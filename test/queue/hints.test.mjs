import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, countActiveJobs, countsByStatus, LEASE_GRACE_S } from "../../src/memory/jobs.mjs";
import { advisoryLines, isQueueIdle, noRunnerWait, parkedBacklogLine, parkedJobLabel, pausedRunnerLine, pendingJobs, runnerPauseLabel, runnersOnline } from "../../src/queue/hints.mjs";
import { advisoryLinesFor, startAdvisoryLines } from "../../src/queue/advisory.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const NONE = [];
const WATCHING = [{ running: true, pid: 4242, mode: "watch" }];

// Expires a job's lease well past the grace window, the state a dead worker leaves behind.
function orphanLease(env, id) {
  openDb(env)
    .prepare(`UPDATE jobs SET lease_until = datetime('now', '-${LEASE_GRACE_S * 2} seconds') WHERE id = ?`)
    .run(id);
}

test("the queue is idle only when no job holds a live lease and no runner is registered", () => {
  assert.equal(isQueueIdle({ activeJobs: 0, runners: NONE }), true);
  assert.equal(isQueueIdle({ activeJobs: 1, runners: NONE }), false, "a job under a live lease left the queue idle");
  assert.equal(isQueueIdle({ activeJobs: 0, runners: WATCHING }), false, "a live watcher left the queue idle");
  assert.equal(isQueueIdle({ activeJobs: 2, runners: WATCHING }), false);
});

test("a running job whose lease died leaves the queue idle, so the backlog still gets its nudge", (t) => {
  const env = makeHome(t, "hints-orphan-lease");
  makeProject(t, env, "alpha");
  const orphaned = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(orphaned, { worker: "host:4242", cap: 4 }, env);
  addJob({ project: "alpha", prompt: "fix the parser" }, env);

  assert.equal(isQueueIdle({ activeJobs: countActiveJobs(env), runners: NONE }), false, "a live lease read as idle");

  orphanLease(env, orphaned);
  assert.equal(countsByStatus(env).running, 1, "the fixture did not land the orphaned job in `running`");
  assert.equal(countActiveJobs(env), 0, "a dead lease still counted as an active job");
  assert.equal(isQueueIdle({ activeJobs: countActiveJobs(env), runners: NONE }), true);
  assert.equal(isQueueIdle({ activeJobs: countActiveJobs(env), runners: WATCHING }), false, "a watcher is still work");
});

test("the number of pending jobs is written in the singular for a single job", () => {
  assert.equal(pendingJobs(0), "0 pending jobs");
  assert.equal(pendingJobs(1), "1 pending job");
  assert.equal(pendingJobs(2), "2 pending jobs");
});

test("the number of live runners is written in the singular for a single runner", () => {
  assert.equal(runnersOnline(0), "0 runners online");
  assert.equal(runnersOnline(1), "1 runner online");
  assert.equal(runnersOnline(2), "2 runners online");
});

test("the zero-runner wait sentence leads with the count and names the way to start one", () => {
  assert.match(noRunnerWait(), /^0 runners online/);
  assert.match(noRunnerWait(), /nightshift queue run/);
});

const WINDOW_TAIL = "another runner will likely hit the limit before finishing";
const PROJECT_TAIL = "parallel jobs on one repository fight over the checkout; a job the preflight releases retries with backoff and burns tokens for no output";

// A list of live runners of the given length, the only thing rule (a) counts.
function liveRunnerList(count) {
  return Array.from({ length: count }, (_, index) => ({ running: true, pid: 4000 + index, mode: "drain" }));
}

test("a five-hour window at the threshold warns with the utilization and the live runners, in the singular for one", () => {
  assert.deepEqual(advisoryLines({ runners: liveRunnerList(1), fiveHourUtilization: 0.8 }), [`5h window at 80% · 1 runner active — ${WINDOW_TAIL}`]);
  assert.deepEqual(advisoryLines({ runners: liveRunnerList(3), fiveHourUtilization: 0.86 }), [
    "5h window at 86% · 3 runners active — another runner will likely hit the limit before finishing",
  ]);
  assert.deepEqual(advisoryLines({ runners: liveRunnerList(1), fiveHourUtilization: 0.79 }), [], "a window under the threshold warned");
  assert.deepEqual(advisoryLines({ runners: liveRunnerList(1), fiveHourUtilization: null }), [], "an unknown utilization warned");
  assert.deepEqual(advisoryLines({ runners: liveRunnerList(0), fiveHourUtilization: 0.95 }), [], "a window with no live runner warned");
});

test("every repository two or more runners work at once warns, in the order given, and nothing else does", () => {
  assert.deepEqual(advisoryLines({ runners: [], activeByProject: [{ project: "alpha", count: 2 }, { project: "beta", count: 1 }] }), [
    "2 runners on `alpha` — parallel jobs on one repository fight over the checkout; a job the preflight releases retries with backoff and burns tokens for no output",
  ]);
  assert.deepEqual(advisoryLines({ runners: [], activeByProject: [{ project: "alpha", count: 3 }, { project: "beta", count: 2 }] }), [
    `3 runners on \`alpha\` — ${PROJECT_TAIL}`,
    `2 runners on \`beta\` — ${PROJECT_TAIL}`,
  ]);
});

test("a read that fails while gathering the advice answers no advice instead of failing its caller", async (t) => {
  const env = makeHome(t, "hints-advisory-read-failure");
  const store = { jobs: { countActiveJobsByProject: async () => { throw new Error("database is locked"); } } };
  assert.deepEqual(await advisoryLinesFor({ store, runners: liveRunnerList(2), env }), []);
  assert.deepEqual(await startAdvisoryLines({ store, env }), []);
});

test("both advisories come window first, then the repositories, and no condition gives no line", () => {
  assert.deepEqual(advisoryLines({ runners: liveRunnerList(2), fiveHourUtilization: 0.9, activeByProject: [{ project: "alpha", count: 2 }] }), [
    `5h window at 90% · 2 runners active — ${WINDOW_TAIL}`,
    `2 runners on \`alpha\` — ${PROJECT_TAIL}`,
  ]);
  assert.deepEqual(advisoryLines({ runners: liveRunnerList(1), fiveHourUtilization: 0.5, activeByProject: [{ project: "alpha", count: 1 }] }), []);
  assert.deepEqual(advisoryLines(), []);
});

const NOW = new Date(2026, 8, 14, 1, 24, 0).getTime();

// A live runner waiting out a limit, as `runnerView` hands it to every reader.
function pausedRunner({ minutes = 108, type = "five_hour", pid = 4242, running = true } = {}) {
  const resetsAt = new Date(NOW + minutes * 60_000);
  return {
    running,
    pid,
    pausedUntil: new Date(resetsAt.getTime() + 60_000).toISOString(),
    rateLimit: { type, resetsAt: resetsAt.toISOString(), utilization: 0.99 },
  };
}

test("the pause of a runner is written with the instant it ends, the budget that ran out and how long is left", () => {
  assert.equal(runnerPauseLabel(pausedRunner(), NOW), "paused until 03:12 (5h limit, resets in 1h48)");
  assert.equal(runnerPauseLabel(pausedRunner({ minutes: 12 }), NOW), "paused until 01:36 (5h limit, resets in 12m)");
  assert.equal(
    runnerPauseLabel(pausedRunner({ minutes: 8515, type: "seven_day" }), NOW),
    "paused until 2026-09-19 23:19 (7d limit, resets in 5d21h)",
    "a pause that ends on another day was written as a bare time of day",
  );
  assert.equal(runnerPauseLabel(pausedRunner({ type: null }), NOW), "paused until 03:12 (rate limit, resets in 1h48)");
});

test("a runner that is not waiting out a limit right now has no pause to report, whatever its record still carries", () => {
  assert.equal(runnerPauseLabel({ running: true, pid: 1, pausedUntil: null, rateLimit: null }, NOW), null);
  assert.equal(runnerPauseLabel(pausedRunner({ minutes: -60 }), NOW), null, "a pause that is over still stopped the queue");
  assert.equal(runnerPauseLabel(pausedRunner({ running: false }), NOW), null, "a stopped runner reported a pause of its own");
  assert.equal(runnerPauseLabel({ running: true, pid: 1, pausedUntil: "not an instant", rateLimit: null }, NOW), null);
  assert.equal(runnerPauseLabel(null, NOW), null);
});

// A job of the queue as every reader gets it from the job view, parked or not.
function jobRow({ id = 1, status = "pending", minutes = null, slug = null } = {}) {
  return { id, status, slug, not_before: minutes === null ? null : new Date(NOW + minutes * 60_000).toISOString() };
}

test("a job waiting for a rate limit to reset says so where a reader looks for what it is doing", () => {
  assert.equal(parkedJobLabel(jobRow({ minutes: 108 }), NOW), "⏸ rate limit until 03:12 (in 1h48)");
  assert.equal(parkedJobLabel(jobRow({ minutes: 12 }), NOW), "⏸ rate limit until 01:36 (in 12m)");
  assert.equal(parkedJobLabel(jobRow({ minutes: 8515 }), NOW), "⏸ rate limit until 2026-09-19 23:19 (in 5d21h)");
  assert.equal(parkedJobLabel(jobRow({ slug: "fix-the-worker" }), NOW), null, "an ordinary pending job was read as parked");
  assert.equal(parkedJobLabel(jobRow({ minutes: -60 }), NOW), null, "a job due again since an hour ago still waits for the reset");
  assert.equal(parkedJobLabel(jobRow({ status: "running", minutes: 108 }), NOW), null, "a job that is running was read as parked");
  assert.equal(parkedJobLabel({ id: 1, status: "pending", not_before: "not an instant" }, NOW), null);
  assert.equal(parkedJobLabel(null, NOW), null);
});

test("a backlog nobody can claim before a reset answers with the wait, and one with a job left to claim still asks for a batch", () => {
  const near = jobRow({ id: 1, minutes: 12 });
  const far = jobRow({ id: 2, minutes: 108 });
  const free = jobRow({ id: 3, slug: "fix-the-parser" });

  assert.equal(parkedBacklogLine({ jobs: [near, far], pending: 2 }, NOW), "the rate limit resets at 03:12 (in 1h48); a batch started now claims nothing before that");
  assert.equal(parkedBacklogLine({ jobs: [far, near], pending: 2 }, NOW), "the rate limit resets at 03:12 (in 1h48); a batch started now claims nothing before that", "the nearest reset won over the furthest one");
  assert.equal(parkedBacklogLine({ jobs: [near, free], pending: 2 }, NOW), null, "a job that could be claimed right now was reported as waiting for a reset");
  assert.equal(parkedBacklogLine({ jobs: [near], pending: 3 }, NOW), null, "a listing that showed one parked job of three answered for the two it never read");
  assert.equal(parkedBacklogLine({ jobs: [free], pending: 1 }, NOW), null);
  assert.equal(parkedBacklogLine({ jobs: [], pending: 0 }, NOW), null);
  assert.equal(parkedBacklogLine({ jobs: undefined, pending: 1 }, NOW), null, "a listing that is not a list threw instead of answering");
});

test("what the surfaces say instead of `start the batch` is the furthest pause of the runners of this home", () => {
  const near = pausedRunner({ minutes: 12, pid: 1 });
  const far = pausedRunner({ minutes: 108, pid: 2 });
  const free = { running: true, pid: 3, pausedUntil: null, rateLimit: null };

  assert.equal(pausedRunnerLine([near, far, free], NOW), "the runner is paused until 03:12 (5h limit, resets in 1h48)");
  assert.equal(pausedRunnerLine([far, near], NOW), "the runner is paused until 03:12 (5h limit, resets in 1h48)", "the nearest pause won over the furthest one");
  assert.equal(pausedRunnerLine([near], NOW), "the runner is paused until 01:36 (5h limit, resets in 12m)");
  assert.equal(pausedRunnerLine([free], NOW), null);
  assert.equal(pausedRunnerLine([], NOW), null);
  assert.equal(pausedRunnerLine(undefined, NOW), null, "a listing that is not a list threw instead of answering");
});
