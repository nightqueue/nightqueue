import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { StoreUnavailableError } from "../../src/config/errors.mjs";
import { jobLogPath, pendingWritesPath } from "../../src/config/paths.mjs";
import { replayAllPendingWrites } from "../../src/queue/pending-writes.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { openStore } from "../../src/store/open.mjs";
import { openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { acquire } from "../../src/queue/claim.mjs";
import { runCycle, runDrain } from "../../src/queue/runner.mjs";
import { provisionalSlug, slugCandidates } from "../../src/queue/spawn.mjs";
import { createStoreOutage, OUTAGE_RECOVERED_LINE, OUTAGE_STOPPED } from "../../src/queue/store-outage.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { capturedUnavailableError, makeSickHome } from "../../test-support/sick-home.mjs";
import { doneStream, SLUG, slugTypeEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const POLL_MS = 50;
const OUTAGE_PREFIX = "nightqueue: the database is unavailable (SQLITE_NOTADB at ";
const DOUBLING = [30000, 60000, 120000, 240000, 300000, 300000];

// A git double for the preflight: a clean checkout of the default branch, calling `onStatus` on each `git status`.
function fakeGit(onStatus = () => {}) {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    if (args[0] === "status") onStatus();
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// A home with project `alpha`, the fake claude playing `attempts`, and one pending job (with `slug`, or none).
function runnerHome(t, name, attempts, { slug = SLUG } = {}) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", slug }, env).id;
  return { env, planPath, projectId, id };
}

// An outage whose lines are recorded instead of written to stderr.
function recordingOutage(sleepImpl) {
  const lines = [];
  const outage = createStoreOutage({ write: (line) => lines.push(line), sleepImpl, probeMs: POLL_MS });
  return { outage, lines };
}

// The outage lines and the recovery lines among the recorded ones.
function outageCounts(lines) {
  return { opened: lines.filter((line) => line.startsWith(OUTAGE_PREFIX)).length, recovered: lines.filter((line) => line === OUTAGE_RECOVERED_LINE).length };
}

// Waits until `check` holds, failing with `what` after ten seconds.
async function until(check, what) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

// Tells whether the job's lease runs past now, compared by the database's own clock.
function leaseIsLive(env, id) {
  const db = openDbReadOnly(env);
  try {
    return db.prepare("SELECT datetime(lease_until) > datetime('now') AS live FROM jobs WHERE id = ?").get(id).live === 1;
  } finally {
    db.close();
  }
}

// A backoff sleep that never resolves by itself: only a stop or a recovery ends the wait.
function neverEndingSleep(slept) {
  return (ms) => {
    slept.push(ms);
    return new Promise(() => {});
  };
}

test("a store outage mid-run keeps the child: one outage line, one recovery line, and the job still ends done", async (t) => {
  const home = runnerHome(t, "outage-keeps-child", [{ holdMs: 1500, tail: doneStream(), exitCode: 0 }]);
  const slept = [];
  const { outage, lines } = recordingOutage(neverEndingSleep(slept));
  let sick = null;
  t.after(() => sick?.restore());

  const cycle = runCycle({ jobId: home.id, env: home.env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), stopPollMs: POLL_MS, storeOutage: outage } });
  await until(() => fakeCalls(home.planPath).length === 1, "the fake claude to start");
  sick = makeSickHome(home.env);
  await until(() => outage.isActive(), "the heartbeat to see the outage");
  await new Promise((done) => setTimeout(done, POLL_MS * 4));
  sick.restore();

  const [claimed] = await Promise.all([acquire({ cap: null, env: home.env }), until(() => !outage.isActive(), "the heartbeat to see the store back")]);
  const row = getJob(home.id, home.env);
  assert.equal(claimed.job, null, "a second claim right after the restore took something");
  assert.deepEqual({ status: row.status, live: leaseIsLive(home.env, home.id) }, { status: "running", live: true }, "a short outage cost the running job its lease");

  const report = (await cycle).processed[0];
  assert.equal(report.status, "done", JSON.stringify(report));
  assert.deepEqual(outageCounts(lines), { opened: 1, recovered: 1 }, lines.join("\n"));
  assert.deepEqual(slept, [], "the heartbeat of a running child was backed off");
});

test("the held job's lease is renewed at once when the store comes back, while the backoff sleep is still pending", async (t) => {
  const home = runnerHome(t, "outage-renew-at-once", [{ holdMs: 800, tail: doneStream(), exitCode: 0 }], { slug: null });
  const slept = [];
  const { outage, lines } = recordingOutage(neverEndingSleep(slept));
  let sick = null;
  t.after(() => sick?.restore());
  const onStatus = () => {
    if (sick) return;
    openDb(home.env).prepare("UPDATE jobs SET lease_until = datetime('now', '-1 hour') WHERE id = ?").run(home.id);
    sick = makeSickHome(home.env);
  };

  const cycle = runCycle({ jobId: home.id, env: home.env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(onStatus), stopPollMs: POLL_MS, storeOutage: outage } });
  await until(() => slept.length === 1, "the slug bind to back off");
  sick.restore();
  await until(() => leaseIsLive(home.env, home.id), "the lease to be renewed");

  assert.deepEqual(slept, [30000], "the renewal waited for the backoff timer");
  const report = (await cycle).processed[0];
  assert.equal(report.status, "done", JSON.stringify(report));
  assert.deepEqual(outageCounts(lines), { opened: 1, recovered: 1 }, lines.join("\n"));
  const job = getJob(home.id, home.env);
  assert.equal(job.slug, slugCandidates(provisionalSlug(job), job.id)[0], "the outage moved the run onto another slug");
});

test("an outage before the spawn makes the job wait, then run to completion with the attempts of a clean run", async (t) => {
  const home = runnerHome(t, "outage-pre-spawn", [{ stdout: doneStream(), exitCode: 0 }], { slug: null });
  const slept = [];
  let sick = null;
  t.after(() => sick?.restore());
  const sleepImpl = async (ms) => {
    slept.push(ms);
    if (slept.length === 2) sick.restore();
  };
  const { outage, lines } = recordingOutage(sleepImpl);
  const onStatus = () => {
    if (!sick) sick = makeSickHome(home.env);
  };

  const cycle = await runCycle({ jobId: home.id, env: home.env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(onStatus), stopPollMs: POLL_MS, storeOutage: outage, sleepImpl } });

  assert.deepEqual(slept, [30000, 60000]);
  assert.deepEqual(cycle.processed.map((report) => [report.status, report.attempts]), [["done", 1]]);
  assert.equal(getJob(home.id, home.env).attempts, 1);
  assert.deepEqual(outageCounts(lines), { opened: 1, recovered: 1 });
});

test("failed claims back off 30 s doubling to 5 min, and the next job is claimed once the store is back", async (t) => {
  const home = runnerHome(t, "outage-backoff", [{ stdout: doneStream(), exitCode: 0 }]);
  const slept = [];
  let sick = null;
  t.after(() => sick?.restore());
  const sleepImpl = async (ms) => {
    slept.push(ms);
    if (slept.length === DOUBLING.length) sick.restore();
  };
  const maintenanceImpl = async () => {
    sick = makeSickHome(home.env);
    return {};
  };
  const { outage, lines } = recordingOutage(sleepImpl);

  const cycle = await runCycle({ jobId: home.id, env: home.env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), maintenanceImpl, storeOutage: outage, sleepImpl } });

  assert.deepEqual(slept, DOUBLING);
  assert.deepEqual(cycle.processed.map((report) => report.status), ["done"]);
  assert.deepEqual(outageCounts(lines), { opened: 1, recovered: 1 });
});

test("a drain on a sick store never returns by itself: it waits out the outage and ends only on the stop signal", async (t) => {
  const home = runnerHome(t, "outage-never-exits", [{ stdout: doneStream(), exitCode: 0 }]);
  const sick = makeSickHome(home.env);
  t.after(() => sick.restore());
  const slept = [];
  const sleepImpl = async (ms) => {
    slept.push(ms);
    if (slept.length === 4) process.emit("SIGTERM");
  };
  const { outage, lines } = recordingOutage(sleepImpl);

  const passes = await runDrain({ env: home.env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), storeOutage: outage, sleepImpl } });

  assert.deepEqual(slept, DOUBLING.slice(0, 4));
  assert.deepEqual(passes.map((pass) => [pass.reason, pass.stopped, pass.processed.length]), [["stopped", true, 0]]);
  assert.deepEqual(outageCounts(lines), { opened: 1, recovered: 0 });
});

test("retryWhileUnavailable rethrows a failure that is not a store outage, and answers OUTAGE_STOPPED when told to stop", async (t) => {
  const unavailable = await capturedUnavailableError(t);
  const lines = [];
  const outage = createStoreOutage({ write: (line) => lines.push(line), sleepImpl: async () => {} });
  const state = { stopping: false };

  await assert.rejects(outage.retryWhileUnavailable(async () => {
    throw new Error("boom");
  }, state), /boom/);
  state.stopping = true;
  const stopped = await outage.retryWhileUnavailable(async () => {
    throw unavailable;
  }, state);

  assert.equal(stopped, OUTAGE_STOPPED);
  assert.ok(unavailable instanceof StoreUnavailableError);
  assert.deepEqual(outageCounts(lines), { opened: 1, recovered: 0 });
});

const OUTAGE_SESSION = "sess-outage-1";

// The columns that hold the job's sessions, read on a fresh connection.
function sessionColumns(env, id) {
  const db = openDbReadOnly(env);
  try {
    return { ...db.prepare("SELECT session_id, last_session_id FROM jobs WHERE id = ?").get(id) };
  } finally {
    db.close();
  }
}

// A job whose child announces its session and `SLUG: renamed-run TYPE: feature/refactor` after a hold, then waits before it exits done.
function announcingHome(t, name) {
  const tail = toNdjson([systemInitEvent({ sessionId: OUTAGE_SESSION }), slugTypeEvent("renamed-run", "feature/refactor", { sessionId: OUTAGE_SESSION })]) + doneStream({ sessionId: OUTAGE_SESSION });
  return runnerHome(t, name, [{ holdMs: 600, tail, afterHoldMs: 1200, exitCode: 0 }]);
}

// The live pending-writes file of the job's provisional run, or "" when there is none.
function pendingText(home) {
  const path = pendingWritesPath(home.projectId, SLUG, home.env);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

// Starts the cycle and turns the home sick as soon as the child runs, before it says anything; answers once the session was queued.
async function startSickRun(t, home) {
  const { outage } = recordingOutage(neverEndingSleep([]));
  let sick = null;
  t.after(() => sick?.restore());
  const cycle = runCycle({ jobId: home.id, env: home.env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), stopPollMs: POLL_MS, storeOutage: outage } });
  await until(() => fakeCalls(home.planPath).length === 1, "the fake claude to start");
  sick = makeSickHome(home.env);
  await until(() => outage.isActive(), "the heartbeat to see the outage");
  await until(() => pendingText(home).includes(`"session:${home.id}:`), "the session to be queued");
  return { cycle, sick };
}

test("facts announced during an outage are kept: the type is recorded, the slug stays with a reason, and the session lands once the store is back", async (t) => {
  const home = announcingHome(t, "outage-facts-restored");
  const { cycle, sick } = await startSickRun(t, home);
  sick.restore();

  const report = (await cycle).processed[0];

  assert.equal(report.status, "done", JSON.stringify(report));
  const log = readFileSync(jobLogPath(home.id, home.env), "utf8");
  assert.equal(readRunState({ projectId: home.projectId, slug: SLUG, env: home.env })?.type, "feature/refactor", log);
  assert.equal(log.split("\n").filter((line) => line.startsWith("the database is unavailable: the session record waits in ")).length, 1, log);
  assert.match(log, /the run keeps the slug `fix-the-worker`: it could not be renamed to `renamed-run` \(the database is unavailable\)/);
  assert.deepEqual(sessionColumns(home.env, home.id), { session_id: OUTAGE_SESSION, last_session_id: OUTAGE_SESSION });
});

test("a session and a finish queued during an outage are both applied by one replay after it, session first", async (t) => {
  const home = announcingHome(t, "outage-facts-replayed");
  const { cycle, sick } = await startSickRun(t, home);
  const report = (await cycle).processed[0];
  assert.equal(report.status, "unrecorded", JSON.stringify(report));
  sick.restore();

  const replay = await replayAllPendingWrites({ env: home.env, store: openStore(home.env) });

  assert.equal(replay.error, null);
  const lines = readFileSync(replay.runs[0].done, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const results = lines.filter((line) => line.applied).map((marker) => `${marker.applied.split(":")[0]}=${marker.result}`);
  const session = results.indexOf("session=applied");
  const finish = results.indexOf("finish=applied");
  assert.ok(session >= 0 && finish > session, results.join(", "));
  assert.deepEqual(sessionColumns(home.env, home.id), { session_id: OUTAGE_SESSION, last_session_id: OUTAGE_SESSION });
  assert.equal(getJob(home.id, home.env).status, "done");
});
