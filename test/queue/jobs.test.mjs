import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import {
  acquireClose,
  addJob,
  adoptClose,
  bindRunSlug,
  cancelJob,
  failClose,
  listCloses,
  noteCloseWorktree,
  recordCloseStep,
  settleClose,
  closeRefusal,
  claimJobById,
  claimNextJob,
  countAttempt,
  countActiveJobs,
  countActiveJobsByProject,
  countPendingBlocked,
  countsByStatus,
  finishJob,
  getJob,
  hasClaimablePending,
  jobView,
  listCloseCandidates,
  listJobs,
  parkJob,
  peekNextJob,
  persistRunFacts,
  releaseJob,
  renewLease,
  retryJob,
} from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { makeHome, makeProject, seedClosedJob } from "../../test-support/memory.mjs";

const WORKER = "host:1000";
const OTHER_WORKER = "host:2000";
const CAP = 4;
const GATED_FINISHED_AT = "2020-01-01 00:00:00";
const SESSION_ID = "11111111-2222-3333-4444-555555555555";

// A home with two registered projects and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  return env;
}

// Enqueues a job with the fields the test cares about.
function enqueue(env, { project = "alpha", prompt = "fix the worker", priority, maxAttempts, timeoutS } = {}) {
  return addJob({ project, prompt, priority, maxAttempts, timeoutS }, env).id;
}

// Moves the lease of a job past the reclaim grace, which is how a runner that died looks from the outside.
function expireLease(env, id) {
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
}

test("addJob refuses an empty prompt and every value outside the accepted ranges", (t) => {
  const env = makeQueue(t, "jobs-add");
  assert.throws(() => addJob({ project: "alpha", prompt: "   " }, env), /prompt.*required/);
  assert.throws(() => addJob({ project: "", prompt: "x" }, env), /project.*required/);
  assert.throws(() => enqueue(env, { priority: 0 }), /invalid `priority`/);
  assert.throws(() => enqueue(env, { priority: 10 }), /invalid `priority`/);
  assert.throws(() => enqueue(env, { maxAttempts: 99 }), /invalid `max_attempts`/);
  assert.throws(() => enqueue(env, { timeoutS: 30 }), /invalid `timeout_s`/);
  const job = addJob({ project: "alpha", prompt: "  fix the worker  " }, env);
  assert.deepEqual({ ...job, id: undefined }, { id: undefined, project: "alpha", priority: 5, maxAttempts: 1, timeoutS: 14400, tier: null });
  assert.equal(getJob(job.id, env).prompt, "fix the worker");
});

test("the operator's tier is stored, refused when it is not one of the three, and absent when nothing was informed", (t) => {
  const env = makeQueue(t, "jobs-tier");
  const job = addJob({ project: "alpha", prompt: "fix the worker", tier: "complex" }, env);
  assert.equal(job.tier, "complex");
  assert.equal(getJob(job.id, env).tier, "complex");
  assert.equal(jobView(getJob(job.id, env)).tier, "complex");

  assert.throws(
    () => addJob({ project: "alpha", prompt: "fix the parser", tier: "urgent" }, env),
    /invalid `tier`: `urgent`; expected one of trivial\|simple\|complex/,
  );
  assert.equal(countsByStatus(env).pending, 1, "the refused tier still wrote a job row");

  for (const tier of ["", "   ", undefined, null]) {
    const none = addJob({ project: "alpha", prompt: "fix the parser", tier }, env);
    assert.equal(none.tier, null, `\`${String(tier)}\` should store no tier`);
    assert.equal(getJob(none.id, env).tier, null);
  }
  assert.equal(addJob({ project: "alpha", prompt: "trim it", tier: " simple " }, env).tier, "simple");
});

test("the claim takes the highest priority first, arms the lease and spends one attempt", (t) => {
  const env = makeQueue(t, "jobs-claim-order");
  const low = enqueue(env, { priority: 7 });
  const high = enqueue(env, { project: "beta", priority: 2 });
  assert.equal(peekNextJob(env).id, high);
  const claimed = claimNextJob({ worker: WORKER, cap: CAP }, env);
  assert.equal(claimed.id, high);
  assert.equal(claimed.status, "running");
  assert.equal(claimed.worker, WORKER);
  assert.equal(claimed.attempts, 1);
  assert.ok(claimed.lease_until > claimed.started_at, "the lease was not armed into the future");
  assert.equal(countActiveJobs(env), 1);
  assert.equal(claimNextJob({ worker: OTHER_WORKER, cap: CAP }, env).id, low);
  assert.equal(claimNextJob({ worker: WORKER, cap: CAP }, env), null);
});

test("the concurrency ceiling lives in the WHERE of the claim, so a full queue refuses the next job", (t) => {
  const env = makeQueue(t, "jobs-claim-cap");
  const first = enqueue(env);
  const second = enqueue(env, { project: "beta" });
  assert.equal(claimNextJob({ worker: WORKER, cap: 1 }, env).id, first);
  assert.equal(claimNextJob({ worker: OTHER_WORKER, cap: 1 }, env), null);
  assert.equal(claimJobById(second, { worker: OTHER_WORKER, cap: 1 }, env), null);
  assert.equal(getJob(second, env).attempts, 0, "a refused claim spent an attempt");
  assert.equal(claimJobById(second, { worker: OTHER_WORKER, cap: 2 }, env).id, second);
  assert.equal(claimJobById(first, { worker: OTHER_WORKER, cap: 9 }, env), null, "a running job was claimed twice");
  assert.throws(() => claimNextJob({ worker: WORKER, cap: 0 }, env), /concurrency cap/);
});

test("a claim with an explicit null ceiling carries no ceiling, and only null lifts it", (t) => {
  const env = makeQueue(t, "jobs-claim-no-cap");
  const active = [enqueue(env), enqueue(env), enqueue(env, { project: "beta" })];
  for (const id of active) assert.equal(claimNextJob({ worker: WORKER, cap: null }, env).id, id);
  assert.equal(countActiveJobs(env), 3);
  const next = enqueue(env);
  const byId = enqueue(env, { project: "beta" });
  assert.equal(claimJobById(byId, { worker: OTHER_WORKER, cap: null }, env).id, byId, "a claim by id with no ceiling was refused");
  assert.equal(claimNextJob({ worker: OTHER_WORKER, cap: null }, env).id, next, "a claim with no ceiling was refused");
  assert.equal(countActiveJobs(env), 5);
  assert.equal(claimNextJob({ worker: WORKER, cap: null }, env), null);
  const pending = enqueue(env);
  assert.throws(() => claimNextJob({ worker: WORKER }, env), /concurrency cap/);
  assert.throws(() => claimJobById(pending, { worker: WORKER, cap: 0 }, env), /concurrency cap/);
  assert.equal(getJob(pending, env).status, "pending", "a refused ceiling still claimed the job");
});

test("the active jobs per project count only live leases, grouped by project in name order", (t) => {
  const env = makeQueue(t, "jobs-active-by-project");
  assert.deepEqual(countActiveJobsByProject(env), [], "an empty queue counted a project");
  const beta = enqueue(env, { project: "beta" });
  const alpha = [enqueue(env), enqueue(env)];
  enqueue(env);
  for (const id of [beta, ...alpha]) claimJobById(id, { worker: WORKER, cap: null }, env);

  assert.deepEqual(countActiveJobsByProject(env), [
    { project: "alpha", count: 2 },
    { project: "beta", count: 1 },
  ]);

  expireLease(env, alpha[0]);
  expireLease(env, beta);
  assert.equal(countsByStatus(env).running, 3, "the fixture did not leave the orphaned jobs in `running`");
  assert.deepEqual(countActiveJobsByProject(env), [{ project: "alpha", count: 1 }], "an orphaned lease still counted as a runner on its project");
});

test("release gives the job back without spending the attempt and keeps the previous reason", (t) => {
  const env = makeQueue(t, "jobs-release");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  assert.equal(releaseJob(id, { worker: OTHER_WORKER, result: null }, env), false, "a foreign worker released the job");
  assert.equal(
    releaseJob(id, { worker: WORKER, result: { blocked: { code: "dirty-checkout" } }, blockedCode: "dirty-checkout" }, env),
    true,
  );
  const released = getJob(id, env);
  assert.deepEqual(
    { status: released.status, attempts: released.attempts, worker: released.worker, lease: released.lease_until, blockedCode: released.blocked_code },
    { status: "pending", attempts: 0, worker: null, lease: null, blockedCode: "dirty-checkout" },
  );
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  assert.equal(getJob(id, env).blocked_code, null, "the claim carried the block code of the previous attempt");
  releaseJob(id, { worker: WORKER, result: null }, env);
  const rereleased = getJob(id, env);
  assert.match(rereleased.result, /dirty-checkout/, "a release with no reason erased the previous block");
  assert.equal(rereleased.blocked_code, null, "a release with no code of its own kept the stale block code");
});

test("a job parked on a rate limit keeps its attempt and leaves the claimable scope of every runner until the reset", (t) => {
  const env = makeQueue(t, "jobs-park");
  const id = enqueue(env);
  const later = new Date(Date.now() + 3600_000).toISOString();
  claimJobById(id, { worker: WORKER, cap: CAP }, env);

  assert.throws(() => parkJob(id, { worker: WORKER, notBefore: "whenever" }, env), /notBefore/);
  assert.equal(parkJob(id, { worker: OTHER_WORKER, notBefore: later }, env), false, "a foreign worker parked the job");
  assert.equal(parkJob(id, { worker: WORKER, notBefore: later, result: { rateLimited: true } }, env), true);

  const parked = getJob(id, env);
  assert.deepEqual(
    { status: parked.status, attempts: parked.attempts, worker: parked.worker, lease: parked.lease_until },
    { status: "pending", attempts: 0, worker: null, lease: null },
    "the park spent an attempt or left the job owned",
  );
  assert.equal(jobView(parked).not_before, `${later.replace(/\.\d+Z$/, "")}Z`, "the job view says nothing about when the job is due");
  assert.equal(claimNextJob({ worker: WORKER, cap: CAP }, env), null, "a parked job was claimed before its reset");
  assert.equal(hasClaimablePending(env), false, "a parked job counted as waiting to be claimed");
  assert.equal(peekNextJob(env), null, "`queue run --dry` promised a job no claim can take");

  const due = enqueue(env, { project: "beta" });
  claimJobById(due, { worker: WORKER, cap: CAP }, env);
  parkJob(due, { worker: WORKER, notBefore: new Date(Date.now() - 1000).toISOString() }, env);
  assert.equal(peekNextJob(env).id, due);
  assert.equal(claimNextJob({ worker: WORKER, cap: CAP }, env).id, due, "a job whose reset already passed stayed out of the queue");
});

test("the rate limit schedule of a job dies with the run it scheduled, on the finish and on the retry alike", (t) => {
  const env = makeQueue(t, "jobs-park-cleared");
  const past = new Date(Date.now() - 1000).toISOString();

  const finished = enqueue(env);
  claimJobById(finished, { worker: WORKER, cap: CAP }, env);
  parkJob(finished, { worker: WORKER, notBefore: past }, env);
  claimJobById(finished, { worker: WORKER, cap: CAP }, env);
  finishJob(finished, { worker: WORKER, status: "done", prUrl: null }, env);
  assert.equal(getJob(finished, env).not_before, null, "a finished job stayed scheduled by a limit that is long gone");

  const retried = enqueue(env);
  claimJobById(retried, { worker: WORKER, cap: CAP }, env);
  parkJob(retried, { worker: WORKER, notBefore: past }, env);
  claimJobById(retried, { worker: WORKER, cap: CAP }, env);
  finishJob(retried, { worker: WORKER, status: "failed" }, env);
  openDb(env).prepare("UPDATE jobs SET not_before = ? WHERE id = ?").run("2099-01-01 00:00:00", retried);
  retryJob(retried, {}, env);
  assert.equal(getJob(retried, env).not_before, null, "a retried job kept a schedule of a limit it never hit");
});

test("the lease renewal is the ownership check: it fails for a worker that no longer owns the row", (t) => {
  const env = makeQueue(t, "jobs-lease");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  expireLease(env, id);
  assert.equal(countActiveJobs(env), 0);
  assert.equal(renewLease(id, { worker: OTHER_WORKER }, env), false);
  assert.equal(renewLease(id, { worker: WORKER }, env), true);
  assert.equal(countActiveJobs(env), 1, "the renewal did not bring the job back under a live lease");
  assert.equal(countAttempt(id, { worker: OTHER_WORKER }, env), false);
  assert.equal(countAttempt(id, { worker: WORKER }, env), true);
  assert.equal(getJob(id, env).attempts, 2);
});

test("the run facts are written once each and never by a worker that lost the job", (t) => {
  const env = makeQueue(t, "jobs-facts");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  assert.equal(persistRunFacts(id, { worker: OTHER_WORKER, slug: "stolen" }, env), false);
  assert.equal(persistRunFacts(id, { worker: WORKER, slug: "fix-the-worker" }, env), true);
  persistRunFacts(id, { worker: WORKER, sessionId: "sess-abc12345" }, env);
  persistRunFacts(id, { worker: WORKER, branch: null, slug: null, sessionId: null }, env);
  const row = getJob(id, env);
  assert.deepEqual({ slug: row.slug, sessionId: row.session_id, branch: row.branch }, { slug: "fix-the-worker", sessionId: "sess-abc12345", branch: null });
});

test("persistRunFacts refuses a slug another job of the project holds, whatever its status, and accepts it in another project", (t) => {
  const env = makeQueue(t, "jobs-facts-slug-held");
  const holder = addJob({ project: "alpha", prompt: "fix the worker", slug: "fix-the-worker" }, env).id;
  cancelJob(holder, {}, env);
  const same = enqueue(env);
  const other = enqueue(env, { project: "beta" });
  claimJobById(same, { worker: WORKER, cap: CAP }, env);
  claimJobById(other, { worker: WORKER, cap: CAP }, env);
  assert.equal(persistRunFacts(same, { worker: WORKER, slug: "fix-the-worker" }, env), false, "two jobs of one project were bound to one run");
  assert.equal(getJob(same, env).slug, null);
  assert.equal(persistRunFacts(other, { worker: WORKER, slug: "fix-the-worker" }, env), true);
  assert.equal(persistRunFacts(same, { worker: WORKER, sessionId: "sess-abc12345" }, env), true, "a fact with no slug was refused");
});

test("bindRunSlug claims the first candidate no other job of the project holds, and refuses a worker that lost the job", (t) => {
  const env = makeQueue(t, "jobs-bind-slug");
  addJob({ project: "alpha", prompt: "fix the worker", slug: "fix-the-worker" }, env);
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  assert.deepEqual(bindRunSlug(id, { worker: OTHER_WORKER, candidates: ["fix-the-worker-2"] }, env), { status: "lost" });
  assert.deepEqual(bindRunSlug(id, { worker: WORKER, candidates: ["fix-the-worker", "fix-the-worker-2"] }, env), { status: "bound", slug: "fix-the-worker-2" });
  assert.equal(getJob(id, env).slug, "fix-the-worker-2");
  assert.deepEqual(bindRunSlug(id, { worker: WORKER, candidates: ["fix-the-worker-2"] }, env), { status: "bound", slug: "fix-the-worker-2" }, "a job was refused its own slug");
  const taken = bindRunSlug(id, { worker: WORKER, candidates: ["fix-the-worker"] }, env);
  assert.equal(taken.status, "taken");
  assert.equal(getJob(id, env).slug, "fix-the-worker-2");
  assert.throws(() => bindRunSlug(id, { worker: WORKER, candidates: ["../etc"] }, env), /invalid `slug`/);
});

test("persistRunFacts overwrites the last session and its attempt every time a new one is given, unlike the first session it never changes again", (t) => {
  const env = makeQueue(t, "jobs-last-session");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);

  persistRunFacts(id, { worker: WORKER, sessionId: "sess-1", lastSessionId: "sess-1", lastSessionAttempt: 1 }, env);
  persistRunFacts(id, { worker: WORKER, lastSessionId: "sess-2", lastSessionAttempt: 2 }, env);

  const row = getJob(id, env);
  assert.deepEqual(
    { sessionId: row.session_id, lastSessionId: row.last_session_id, lastSessionAttempt: row.last_session_attempt },
    { sessionId: "sess-1", lastSessionId: "sess-2", lastSessionAttempt: 2 },
  );
});

test("finishing a job closes it and links only the pipeline run of the same project and slug", (t) => {
  const env = makeQueue(t, "jobs-finish");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  persistRunFacts(id, { worker: WORKER, slug: "fix-the-worker" }, env);
  const mine = logPipelineRun({ project: "alpha", slug: "fix-the-worker", tier: "simple", outcome: "pr_opened", phases: [] }, env);
  const foreign = logPipelineRun({ project: "beta", slug: "fix-the-worker", tier: "simple", outcome: "pr_opened", phases: [] }, env);
  assert.equal(
    finishJob(
      id,
      {
        worker: WORKER,
        status: "done",
        result: { status: "done" },
        prUrl: "https://github.com/acme/api/pull/42",
        noticeMd: "the pull request is open",
        usage: { tokensIn: 10, tokensOut: 4, cacheRead: 2, cacheCreation: 1, costUsd: 0.5 },
        hostCommands: { bashTimeouts: 2, tasksBackgrounded: 1, tasksKilled: 0 },
        orchestrator: { turns: 49, reads: 0, bash: 35, bashExplore: 0, ctxLast: 195000 },
      },
      env,
    ),
    true,
  );
  const row = getJob(id, env);
  assert.equal(row.status, "done");
  assert.equal(row.worker, null);
  assert.equal(row.tokens_in, 10);
  assert.equal(row.cost_usd, 0.5);
  assert.equal(row.bash_timeouts, 2);
  assert.equal(row.tasks_backgrounded, 1);
  assert.equal(row.tasks_killed, 0);
  assert.deepEqual(
    [row.orch_turns, row.orch_reads, row.orch_bash, row.orch_bash_explore, row.orch_ctx_last],
    [49, 0, 35, 0, 195000],
  );
  assert.ok(row.finished_at, "the job has no finished_at");
  const linked = openDb(env)
    .prepare("SELECT id, job_id FROM pipeline_runs ORDER BY id")
    .all()
    .map((run) => [run.id, run.job_id]);
  assert.deepEqual(linked, [
    [mine.runId, id],
    [foreign.runId, null],
  ]);
  assert.equal(finishJob(id, { worker: WORKER, status: "done" }, env), false, "a finished job was closed twice");
});

test("finishing refuses an unknown status and a worker that lost the job", (t) => {
  const env = makeQueue(t, "jobs-finish-refusal");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  assert.throws(() => finishJob(id, { worker: WORKER, status: "concluido" }, env), /invalid job `status`/);
  assert.equal(finishJob(id, { worker: OTHER_WORKER, status: "done" }, env), false);
  assert.equal(getJob(id, env).status, "running");
});

test("cancel accepts a pending job and an orphan, and refuses a live run without writing anything", (t) => {
  const env = makeQueue(t, "jobs-cancel");
  const pending = enqueue(env);
  const running = enqueue(env);
  claimJobById(running, { worker: WORKER, cap: CAP }, env);

  const before = getJob(running, env);
  assert.throws(() => cancelJob(running, { reason: "changed my mind" }, env), /is running with a live lease/);
  assert.deepEqual(getJob(running, env), before, "the refused cancel wrote to the row");

  assert.equal(cancelJob(pending, { reason: "no longer needed" }, env).status, "cancelled");
  assert.equal(getJob(pending, env).operator_note, "no longer needed");
  assert.deepEqual(JSON.parse(getJob(pending, env).result), { cancelledFrom: "pending" });
  assert.throws(() => cancelJob(pending, {}, env), /already finished with status `cancelled`/);
  assert.throws(() => cancelJob(9999, {}, env), /unknown job `9999`/);
  assert.throws(() => cancelJob(0, {}, env), /positive integer job id/);

  expireLease(env, running);
  const cancelled = cancelJob(running, { reason: "the runner died" }, env);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.worker, null);
  assert.deepEqual(JSON.parse(getJob(running, env).result), { cancelledFrom: "running" });
});

test("cancel accepts a gated job, keeps its original finished_at and records where it came from", (t) => {
  const env = makeQueue(t, "jobs-cancel-gate");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  finishJob(id, { worker: WORKER, status: "gate", result: { status: "gate", prUrl: null } }, env);
  openDb(env).prepare("UPDATE jobs SET finished_at = ? WHERE id = ?").run(GATED_FINISHED_AT, id);

  const cancelled = cancelJob(id, { reason: "abandoned at the gate" }, env);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.worker, null);
  assert.equal(cancelled.lease_until, null);

  const row = getJob(id, env);
  assert.equal(row.finished_at, GATED_FINISHED_AT, "the cancel overwrote the finish of the gated run");
  assert.equal(row.operator_note, "abandoned at the gate");
  assert.deepEqual(JSON.parse(row.result), { status: "gate", prUrl: null, cancelledFrom: "gate" });

  const freeText = enqueue(env);
  claimJobById(freeText, { worker: WORKER, cap: CAP }, env);
  finishJob(freeText, { worker: WORKER, status: "gate", result: "nothing to deliver" }, env);
  cancelJob(freeText, {}, env);
  assert.deepEqual(JSON.parse(getJob(freeText, env).result), { previousResult: "nothing to deliver", cancelledFrom: "gate" });
});

test("cancel refuses a closed and a cancelled job without touching the row", (t) => {
  const env = makeQueue(t, "jobs-cancel-terminal");
  const cancelled = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(cancelled);
  const closed = seedClosedJob(env, { prUrl: "https://github.com/acme/api/pull/9" });
  for (const [id, status] of [[cancelled, "cancelled"], [closed, "closed"]]) {
    const before = getJob(id, env);
    assert.throws(() => cancelJob(id, { reason: "too late" }, env), new RegExp(`already finished with status \`${status}\``));
    assert.deepEqual(getJob(id, env), before, `the refused cancel wrote to a ${status} job`);
  }
});

test("cancel accepts a done and a failed job, keeps the close checklist as history and says where each came from", (t) => {
  const env = makeQueue(t, "jobs-cancel-done-failed");
  const failed = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'failed', finished_at = datetime('now') WHERE id = ?").run(failed);
  const done = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, finished_at = datetime('now') WHERE id = ?").run("https://github.com/acme/api/pull/3", done);
  acquireClose(done, { worker: "close:test:1:aaaa", leaseS: 660 }, env);
  failClose(done, { worker: "close:test:1:aaaa", close: { attempts: 1, steps: {}, data: {}, failed: { step: "preflight", reason: "checks-red" } } }, env);

  const fromFailed = cancelJob(failed, { reason: "abandoned" }, env);
  assert.equal(fromFailed.status, "cancelled");
  assert.equal(fromFailed.cancelled_from, "failed");
  const fromDone = cancelJob(done, {}, env);
  assert.equal(fromDone.cancelled_from, "done");
  const row = getJob(done, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.close_status, null, "a cancelled job still reads as a failed close");
  assert.deepEqual(JSON.parse(row.close).failed, { step: "preflight", reason: "checks-red" }, "the close checklist was dropped");

  const pending = enqueue(env);
  assert.equal(cancelJob(pending, {}, env).cancelled_from, "pending");
});

test("a close acquired with force marks its checklist `forced`, and the mark stays on the attempts after it", (t) => {
  const env = makeQueue(t, "jobs-close-forced");
  const id = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/5", id);
  acquireClose(id, { worker: "close:test:1:aaaa", leaseS: 660 }, env);
  assert.equal(JSON.parse(getJob(id, env).close).forced, undefined, "an unforced close was marked forced");
  failClose(id, { worker: "close:test:1:aaaa", close: JSON.parse(getJob(id, env).close) }, env);
  acquireClose(id, { worker: "close:test:2:bbbb", leaseS: 660, force: true }, env);
  assert.equal(JSON.parse(getJob(id, env).close).forced, true);
  failClose(id, { worker: "close:test:2:bbbb", close: JSON.parse(getJob(id, env).close) }, env);
  acquireClose(id, { worker: "close:test:3:cccc", leaseS: 660 }, env);
  const checklist = JSON.parse(getJob(id, env).close);
  assert.equal(checklist.forced, true, "a later attempt dropped the forced mark");
  assert.equal(checklist.attempts, 3);
});

test("cancel refuses a done job under a live close lease, naming the closer, and an interrupted close, pointing at the resume", (t) => {
  const env = makeQueue(t, "jobs-cancel-closing");
  const id = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/4", id);
  acquireClose(id, { worker: "close:test:1:aaaa", leaseS: 660 }, env);
  const before = getJob(id, env);
  assert.throws(() => cancelJob(id, {}, env), new RegExp(`job \`${id}\` is being closed by \`close:test:1:aaaa\` until .*; wait for it or follow it with nightqueue queue status ${id}`));
  assert.deepEqual(getJob(id, env), before, "the refused cancel wrote to a job being closed");

  openDb(env).prepare("UPDATE jobs SET close_lease_until = datetime('now', '-5 seconds') WHERE id = ?").run(id);
  const interrupted = getJob(id, env);
  assert.throws(
    () => cancelJob(id, {}, env),
    new RegExp(`job \`${id}\` has an interrupted close whose merge may already have happened; resume it with nightqueue queue close ${id} - `),
  );
  assert.deepEqual(getJob(id, env), interrupted, "the refused cancel wrote to a job whose close was interrupted");
});

test("cancel takes a done job whose close stopped as failed, clearing the close columns so the old closer can never settle it", (t) => {
  const env = makeQueue(t, "jobs-cancel-close-failed");
  const id = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/4", id);
  acquireClose(id, { worker: "close:test:1:aaaa", leaseS: 660 }, env);
  assert.equal(failClose(id, { worker: "close:test:1:aaaa", close: { steps: {}, data: {} } }, env), true);

  assert.equal(cancelJob(id, {}, env).status, "cancelled");
  const row = getJob(id, env);
  assert.equal(row.close_status, null);
  assert.equal(row.close_worker, null);
  assert.equal(row.close_lease_until, null);
  assert.equal(settleClose(id, { worker: "close:test:1:aaaa", close: { steps: {}, data: { merged: true, mergeSha: "abc" } }, noticeLine: "Closed: PR #4" }, env), null, "the old closer settled a cancelled job");
});

test("retry takes a gated job back to pending, keeping what makes the pipeline resume from where it stopped", (t) => {
  const env = makeQueue(t, "jobs-retry-gate");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  finishJob(id, { worker: WORKER, status: "gate", result: { status: "gate", prUrl: null } }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ?, branch = ?, session_id = ? WHERE id = ?").run("fix-it", "fix/it", SESSION_ID, id);

  const job = retryJob(id, { note: "rename the column" }, env);
  assert.equal(job.status, "pending");
  assert.equal(job.operator_note, "rename the column");
  assert.equal(job.slug, "fix-it");
  assert.equal(job.branch, "fix/it");
  assert.equal(job.session_id, SESSION_ID);
  assert.equal(job.attempts, 1, "the retry rewrote the history of attempts");
  assert.equal(job.max_attempts, 2, "the retry did not widen the allowance");
  assert.equal(job.worker, null);
  assert.equal(job.lease_until, null);
  assert.equal(job.started_at, null);
  assert.equal(job.finished_at, null);
  assert.deepEqual(JSON.parse(getJob(id, env).result), { status: "gate", prUrl: null, retriedFrom: "gate" });
});

test("a gated job is only retried with a note, and the refusal prints the reason it is waiting", (t) => {
  const env = makeQueue(t, "jobs-retry-gate-note");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  finishJob(id, { worker: WORKER, status: "gate", noticeMd: "Rename the column or keep both?" }, env);

  const before = getJob(id, env);
  assert.throws(() => retryJob(id, {}, env), /Rename the column or keep both\?/);
  assert.throws(() => retryJob(id, { note: "   " }, env), /This job is waiting for a decision/);
  assert.deepEqual(getJob(id, env), before, "the refused retry wrote to the row");
});

test("retry accepts a failed and a cancelled job without a note, and refuses every other status", (t) => {
  const env = makeQueue(t, "jobs-retry-statuses");
  for (const status of ["failed", "cancelled"]) {
    const id = enqueue(env);
    openDb(env).prepare("UPDATE jobs SET status = ?, finished_at = datetime('now') WHERE id = ?").run(status, id);
    const job = retryJob(id, {}, env);
    assert.equal(job.status, "pending");
    assert.deepEqual(JSON.parse(getJob(id, env).result), { retriedFrom: status });
  }

  const pending = enqueue(env);
  assert.throws(() => retryJob(pending, { note: "again" }, env), /already pending; there is nothing to retry/);
  const done = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(done);
  assert.throws(() => retryJob(done, { note: "again" }, env), /cannot be retried from status `done`/);
  const running = enqueue(env);
  claimJobById(running, { worker: WORKER, cap: CAP }, env);
  const before = getJob(running, env);
  assert.throws(() => retryJob(running, { note: "again" }, env), /is running with a live lease/);
  assert.deepEqual(getJob(running, env), before);
  assert.throws(() => retryJob(9999, { note: "again" }, env), /unknown job `9999`/);
  assert.throws(() => retryJob(0, { note: "again" }, env), /positive integer job id/);
});

test("--fresh gives up the slug, the branch and the session, so the next run starts from phase 0", (t) => {
  const env = makeQueue(t, "jobs-retry-fresh");
  const id = enqueue(env);
  openDb(env)
    .prepare(
      "UPDATE jobs SET status = 'failed', slug = ?, branch = ?, session_id = ?, last_session_id = ?, last_session_attempt = ?, finished_at = datetime('now') WHERE id = ?",
    )
    .run("fix-it", "fix/it", SESSION_ID, SESSION_ID, 2, id);

  const job = retryJob(id, { fresh: true }, env);
  assert.equal(job.slug, null);
  assert.equal(job.branch, null);
  assert.equal(job.session_id, null);
  const row = openDb(env).prepare("SELECT last_session_id, last_session_attempt FROM jobs WHERE id = ?").get(id);
  assert.deepEqual({ ...row }, { last_session_id: null, last_session_attempt: null }, "--fresh kept the session of a previous attempt");
});

test("the allowance of attempts grows by one per retry and stops at the ceiling the queue accepts", (t) => {
  const env = makeQueue(t, "jobs-retry-allowance");
  const id = enqueue(env, { maxAttempts: 9 });
  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(id);

  assert.equal(retryJob(id, {}, env).max_attempts, 10);
  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(id);
  assert.equal(retryJob(id, {}, env).max_attempts, 10, "the retry pushed the allowance past the accepted range");
});

test("a retry without a note clears the reason of a cancel instead of passing it off as an answer to the gate", (t) => {
  const env = makeQueue(t, "jobs-retry-note-ownership");
  const id = enqueue(env);
  cancelJob(id, { reason: "no longer needed" }, env);
  assert.equal(getJob(id, env).operator_note, "no longer needed");

  assert.equal(retryJob(id, {}, env).operator_note, null, "the reason of the cancel survived as an answer to the gate");
});

test("the public view drops the prompt, truncates the free text by code point and returns ISO timestamps", (t) => {
  const env = makeQueue(t, "jobs-view");
  const id = enqueue(env);
  const notice = `${"a".repeat(499)}\u{1F680}${"b".repeat(100)}`;
  openDb(env).prepare("UPDATE jobs SET notice_md = ?, result = ? WHERE id = ?").run(notice, "short result", id);
  const view = jobView(getJob(id, env));
  assert.equal("prompt" in view, false, "the view leaked the prompt");
  assert.equal(view.notice_md, `${"a".repeat(499)}\u{1F680}...`);
  assert.equal(Array.from(view.notice_md).length, 503);
  assert.equal(view.result, "short result");
  assert.match(view.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(view.finished_at, null);
  assert.equal("merged_at" in view, false, "the view still carries the dropped merged_at column");
  assert.equal("merge_sha" in view, false, "the view still carries the dropped merge_sha column");
  assert.equal(jobView(null), null);
});

test("the public view omits a host-command counter at zero or null, and shows it once it is not", (t) => {
  const env = makeQueue(t, "jobs-view-host-commands");
  const zero = enqueue(env);
  const some = enqueue(env);
  openDb(env)
    .prepare("UPDATE jobs SET bash_timeouts = 0, tasks_backgrounded = 0, tasks_killed = 0 WHERE id = ?")
    .run(zero);
  openDb(env)
    .prepare("UPDATE jobs SET bash_timeouts = 3, tasks_backgrounded = 0, tasks_killed = 1 WHERE id = ?")
    .run(some);

  const untouched = jobView(getJob(enqueue(env), env));
  assert.equal(untouched.bash_timeouts, null, "a job that never ran shows a counter other than null");

  const atZero = jobView(getJob(zero, env));
  assert.equal(atZero.bash_timeouts, null);
  assert.equal(atZero.tasks_backgrounded, null);
  assert.equal(atZero.tasks_killed, null);

  const nonZero = jobView(getJob(some, env));
  assert.equal(nonZero.bash_timeouts, 3);
  assert.equal(nonZero.tasks_backgrounded, null);
  assert.equal(nonZero.tasks_killed, 1);
});

test("the public view shows the orchestrator counters at zero, the healthy value, and omits them only while null", (t) => {
  const env = makeQueue(t, "jobs-view-orchestrator");
  const measured = enqueue(env);
  openDb(env)
    .prepare("UPDATE jobs SET orch_turns = 12, orch_reads = 0, orch_bash = 5, orch_bash_explore = 0, orch_ctx_last = 88000 WHERE id = ?")
    .run(measured);

  const view = jobView(getJob(measured, env));
  assert.deepEqual(
    [view.orch_turns, view.orch_reads, view.orch_bash, view.orch_bash_explore, view.orch_ctx_last],
    [12, 0, 5, 0, 88000],
  );
  const untouched = jobView(getJob(enqueue(env), env));
  assert.equal(untouched.orch_turns, null, "a job that never ran shows an orchestrator counter");
});

test("a cut field carries its truncated flag, a field that fits has no key, and the full view flags nothing", (t) => {
  const env = makeQueue(t, "jobs-view-truncated-flags");
  const id = enqueue(env);
  const exact = "e".repeat(500);
  openDb(env).prepare("UPDATE jobs SET notice_md = ?, result = ? WHERE id = ?").run("n".repeat(501), exact, id);

  const listed = jobView(getJob(id, env));
  assert.equal(listed.notice_truncated, true, "a cut notice was not flagged");
  assert.equal("result_truncated" in listed, false, "a result of exactly 500 code points was flagged as cut");
  assert.equal(listed.result, exact);

  const full = jobView(getJob(id, env), { full: true });
  assert.equal(full.notice_md, "n".repeat(501));
  assert.equal("notice_truncated" in full, false, "the full view flagged a text it never cut");
  assert.equal("result_truncated" in full, false);

  openDb(env).prepare("UPDATE jobs SET notice_md = NULL, result = ? WHERE id = ?").run("r".repeat(600), id);
  const resultCut = jobView(getJob(id, env));
  assert.equal(resultCut.result_truncated, true);
  assert.equal("notice_truncated" in resultCut, false, "a null notice was flagged as cut");
});

test("the listing is newest first with a clamped limit, and the counts cover every status", (t) => {
  const env = makeQueue(t, "jobs-list");
  const ids = [enqueue(env), enqueue(env), enqueue(env)];
  assert.deepEqual(listJobs({}, env).map((row) => row.id), [...ids].reverse());
  assert.equal(listJobs({ limit: 1 }, env).length, 1);
  assert.throws(() => listJobs({ limit: 0 }, env), /invalid `limit`/);
  assert.throws(() => listJobs({ limit: 500 }, env), /invalid `limit`/);
  claimJobById(ids[0], { worker: WORKER, cap: CAP }, env);
  assert.deepEqual(countsByStatus(env), { pending: 2, running: 1, done: 0, gate: 0, failed: 0, cancelled: 0, closed: 0 });
  assert.equal("merged" in countsByStatus(env), false, "the retired merged status is still counted");
});

test("listCloseCandidates lists only done jobs with a pull request url, newest first", (t) => {
  const env = makeQueue(t, "jobs-close-candidates");
  const done = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/1", done);
  const failed = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'failed', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/2", failed);
  const gated = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'gate', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/3", gated);
  const doneNoPr = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(doneNoPr);
  const done2 = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/4", done2);
  const pending = enqueue(env);
  const running = enqueue(env);
  claimJobById(running, { worker: WORKER, cap: CAP }, env);

  assert.deepEqual(listCloseCandidates(env).map((row) => row.id), [done2, done]);
  assert.equal(listCloseCandidates(env).some((row) => [failed, gated, doneNoPr, pending, running].includes(row.id)), false);
});

test("the blocked-pending count and listing only ever see a pending job with a block code, never a running or done one", (t) => {
  const env = makeQueue(t, "jobs-blocked-pending");
  const [blocked, plain] = [enqueue(env), enqueue(env)];
  assert.equal(countPendingBlocked(env), 0);
  claimJobById(blocked, { worker: WORKER, cap: CAP }, env);
  releaseJob(blocked, { worker: WORKER, result: { blocked: { code: "dirty-checkout" } }, blockedCode: "dirty-checkout" }, env);

  assert.equal(countPendingBlocked(env), 1);
  assert.deepEqual(listJobs({ blockedOnly: true }, env).map((row) => row.id), [blocked]);
  assert.deepEqual(listJobs({}, env).map((row) => row.id).sort(), [blocked, plain].sort(), "blockedOnly is opt-in, not the default");

  claimJobById(blocked, { worker: WORKER, cap: CAP }, env);
  assert.equal(countPendingBlocked(env), 0, "the claim cleared the block code, so the count must drop with it");
  assert.deepEqual(listJobs({ blockedOnly: true }, env), []);
});

const CLOSE_WORKER = "close:host:1:aaaa";
const OTHER_CLOSE_WORKER = "close:host:2:bbbb";
const PR_URL = "https://github.com/acme/api/pull/7";

// A job in the given status carrying a pull request, the target a close starts from.
function closableJob(env, { status = "done", prUrl = PR_URL } = {}) {
  const id = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET status = ?, pr_url = ? WHERE id = ?").run(status, prUrl, id);
  return id;
}

// Moves the close lease of a job relative to SQLite's own clock, which is how a close that died looks from the outside.
function moveCloseLease(env, id, seconds) {
  openDb(env).prepare("UPDATE jobs SET close_lease_until = datetime('now', ? || ' seconds') WHERE id = ?").run(String(seconds), id);
}

test("acquireClose takes the lease of a done job from NULL and re-arms a failed one, keeping its checklist", (t) => {
  const env = makeQueue(t, "jobs-close-acquire");
  const id = closableJob(env);
  const first = acquireClose(id, { worker: CLOSE_WORKER, leaseS: 660 }, env);
  assert.equal(first.close_status, "closing");
  assert.equal(first.close_worker, CLOSE_WORKER);
  assert.equal(first.status, "done", "a close never moves the job status before settle");
  assert.equal(JSON.parse(first.close).attempts, 1);
  assert.deepEqual(JSON.parse(first.close).steps, {});

  const checklist = { ...JSON.parse(first.close), steps: { preflight: { status: "done", note: "ok", at: "x" } }, failed: { step: "conflict", reason: "suite-red" } };
  assert.equal(failClose(id, { worker: CLOSE_WORKER, close: checklist }, env), true);
  const failed = getJob(id, env);
  assert.equal(failed.close_status, "failed");
  assert.equal(failed.close_worker, null);
  assert.equal(failed.close_lease_until, null);

  const second = acquireClose(id, { worker: OTHER_CLOSE_WORKER, leaseS: 660 }, env);
  const rearmed = JSON.parse(second.close);
  assert.equal(rearmed.attempts, 2);
  assert.equal(rearmed.failed, null);
  assert.equal(rearmed.steps.preflight.status, "done", "the steps of an earlier attempt survive the re-arm");
});

test("acquireClose refuses a live lease and reclaims a dead one", (t) => {
  const env = makeQueue(t, "jobs-close-lease");
  const id = closableJob(env);
  assert.ok(acquireClose(id, { worker: CLOSE_WORKER, leaseS: 660 }, env));
  assert.equal(acquireClose(id, { worker: OTHER_CLOSE_WORKER, leaseS: 660 }, env), null, "a live lease must refuse a second close");
  assert.equal(getJob(id, env).close_worker, CLOSE_WORKER, "a refusal writes nothing");
  assert.match(closeRefusal(id, getJob(id, env)), /is already being closed by `close:host:1:aaaa` until .*; follow it with nightqueue queue status \d+/);

  moveCloseLease(env, id, -5);
  const reclaimed = acquireClose(id, { worker: OTHER_CLOSE_WORKER, leaseS: 660 }, env);
  assert.equal(reclaimed.close_worker, OTHER_CLOSE_WORKER);
  assert.equal(JSON.parse(reclaimed.close).attempts, 2);
});

test("acquireClose refuses every status but done, even with force, and a done job without a pull request", (t) => {
  const env = makeQueue(t, "jobs-close-status");
  for (const status of ["pending", "running", "cancelled", "failed", "gate"]) {
    const id = closableJob(env, { status });
    for (const force of [false, true]) {
      assert.equal(acquireClose(id, { worker: CLOSE_WORKER, leaseS: 660, force }, env), null, `${status} (force ${force})`);
      assert.equal(getJob(id, env).close_status, null, `${status}: a refusal writes nothing`);
    }
  }
  const closed = seedClosedJob(env);
  const before = getJob(closed, env);
  assert.equal(acquireClose(closed, { worker: CLOSE_WORKER, leaseS: 660, force: true }, env), null, "closed");
  assert.deepEqual(getJob(closed, env), before, "closed: a refusal writes nothing");
  const noPr = closableJob(env, { prUrl: null });
  assert.equal(acquireClose(noPr, { worker: CLOSE_WORKER, leaseS: 660, force: true }, env), null);
  assert.throws(() => acquireClose(noPr, { worker: CLOSE_WORKER, leaseS: 5 }, env), /invalid close lease/);
});

test("closeRefusal phrases the refusal of every status by name and answers null for a done job with a pull request", (t) => {
  const env = makeQueue(t, "jobs-close-refusal");
  const phrase = (status, extra = {}) => closeRefusal(1, { status, pr_url: PR_URL, worker: WORKER, ...extra }, { force: true });
  const cases = [
    [closeRefusal(99, null), /^unknown job `99`$/],
    [phrase("closed"), /^job `1` is already closed$/],
    [phrase("running"), /^job `1` is running with a live lease on worker `host:1000`; stop that runner first$/],
    [phrase("pending"), /^job `1` is pending; it has not produced a pull request yet$/],
    [phrase("gate"), /^job `1` is waiting at a gate; answer it with nightqueue queue retry 1 --note "…", or cancel it$/],
    [phrase("failed"), /^job `1` failed; retry it or cancel it - only a done job is closed$/],
    [phrase("cancelled"), /^job `1` is cancelled; retry it before closing$/],
    [phrase("done", { pr_url: null }), /^nothing to close: the job has no pull request$/],
    [phrase("done", { close_status: "closing", close_worker: "w", close_lease_until: "2999-01-01 00:00:00" }), /^job `1` is already being closed by `w` until 2999-01-01T00:00:00Z; follow it with nightqueue queue status 1$/],
  ];
  for (const [answer, expected] of cases) assert.match(answer, expected);
  assert.equal(phrase("done"), null);
  assert.equal(phrase("done", { close_status: "closing", close_worker: "w", close_lease_until: "2000-01-01 00:00:00" }), null, "a dead lease refuses nothing");
  assert.equal(closeRefusal(closableJob(env), getJob(1, env)), null);
});

test("adoptClose and recordCloseStep hold only for the worker that owns the lease", (t) => {
  const env = makeQueue(t, "jobs-close-adopt");
  const id = closableJob(env);
  const row = acquireClose(id, { worker: CLOSE_WORKER, leaseS: 660 }, env);
  assert.equal(adoptClose(id, { worker: OTHER_CLOSE_WORKER, leaseS: 660 }, env), false);
  assert.equal(adoptClose(id, { worker: CLOSE_WORKER, leaseS: 660 }, env), true);
  const checklist = { ...JSON.parse(row.close), steps: { preflight: { status: "done", note: "green", at: "now" } } };
  assert.equal(recordCloseStep(id, { worker: OTHER_CLOSE_WORKER, close: checklist, leaseS: 660 }, env), false);
  assert.equal(recordCloseStep(id, { worker: CLOSE_WORKER, close: checklist, leaseS: 660 }, env), true);
  assert.deepEqual(jobView(getJob(id, env)).close.steps, checklist.steps);
  assert.equal(failClose(id, { worker: OTHER_CLOSE_WORKER, close: checklist }, env), false);
});

test("settleClose closes a merged job, clears the close columns and appends the settled line to the notice", (t) => {
  const env = makeQueue(t, "jobs-close-settle");
  const id = closableJob(env);
  openDb(env).prepare("UPDATE jobs SET notice_md = 'A\n' WHERE id = ?").run(id);
  const row = acquireClose(id, { worker: CLOSE_WORKER, leaseS: 660 }, env);
  const merged = { ...JSON.parse(row.close), data: { merged: true, mergeSha: "abc1234def" } };
  const line = "Closed: PR #7 merged as abc1234 on 2026-09-21";
  assert.equal(settleClose(id, { worker: OTHER_CLOSE_WORKER, close: merged, noticeLine: line }, env), null);
  const settled = settleClose(id, { worker: CLOSE_WORKER, close: merged, noticeLine: line }, env);
  assert.equal(settled.status, "closed");
  assert.equal(settled.close_status, null);
  assert.equal(settled.close_worker, null);
  assert.equal(settled.close_lease_until, null);
  assert.equal(settled.close.data.merged, true);
  assert.equal(getJob(id, env).notice_md, `A\n\n${line}`);
  assert.equal(noteCloseWorktree(id, { worktree: { removed: "/tmp/wt" } }, env), false, "a checklist without a settle step is left alone");
});

test("listCloses answers the closes in flight, failed or stalled with the liveness of each lease", (t) => {
  const env = makeQueue(t, "jobs-close-list");
  const live = closableJob(env);
  const stalled = closableJob(env);
  const failed = closableJob(env);
  closableJob(env);
  seedClosedJob(env);
  for (const id of [live, stalled, failed]) acquireClose(id, { worker: CLOSE_WORKER, leaseS: 660 }, env);
  moveCloseLease(env, stalled, -5);
  failClose(failed, { worker: CLOSE_WORKER, close: { attempts: 1, steps: {}, data: {}, failed: { step: "merge", reason: "merge-without-sha" } } }, env);
  const rows = listCloses(env);
  assert.deepEqual(
    rows.map((row) => [row.id, row.close_status, row.close_lease_live]),
    [
      [failed, "failed", 0],
      [stalled, "closing", 0],
      [live, "closing", 1],
    ],
  );
});
