import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import {
  addJob,
  cancelRunningJob,
  claimJobById,
  countAttempt,
  finishJob,
  gatePreflightJob,
  getJob,
  jobView,
  parkJob,
  recordAttemptMeasures,
  releaseJob,
  retryJob,
  sweepOrphans,
} from "../../src/memory/jobs.mjs";
import { appendPendingWrite, PENDING_KEYS, replayPendingWrites } from "../../src/queue/pending-writes.mjs";
import { jobDetailView, queueView } from "../../src/queue/view.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:4242";
const CAP = 4;

// A home with the project `alpha` registered.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Queues one job of `alpha`.
function enqueue(env, options = {}) {
  return addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker", ...options }, env).id;
}

// Claims the job for the test worker and answers the claimed row.
function claim(env, id) {
  const row = claimJobById(id, { worker: WORKER, cap: CAP }, env);
  assert.ok(row, `J-${id} was not claimed`);
  return row;
}

// The public view of a job, its attempt history included.
function viewOf(env, id) {
  return jobView(getJob(id, env));
}

// The attempt rows of a job reduced to what a test compares.
function attemptsOf(env, id) {
  return viewOf(env, id).attempts_log.map((row) => ({
    attempt: row.attempt,
    outcome: row.outcome,
    exit: row.exit_reason,
    spawns: row.spawns,
    out: row.tokens_out,
    fresh: row.fresh,
  }));
}

// Open attempt rows of jobs that are no longer running: the invariant every writer keeps at zero.
function strayOpenRows(env) {
  return openDb(env)
    .prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE finished_at IS NULL AND job_id IN (SELECT id FROM jobs WHERE status <> 'running')")
    .get().n;
}

// Runs `queue status` with the given arguments in this process and answers its lines.
async function statusLines(env, args = []) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, stdout: { isTTY: false, columns: 200 } };
  const code = await run(["queue", "status", ...args], ctx);
  assert.equal(code, 0, out.join("\n"));
  return out;
}

// Gates a job on a preflight block, then sends it back, gates it on the agent, sends it back and finishes it done.
function gatedRetriedAndDone(env) {
  const id = enqueue(env);
  assert.equal(claim(env, id).claim_attempt, 1);
  const usage1 = { tokensIn: 10, tokensOut: 5, costUsd: 0.5 };
  assert.equal(gatePreflightJob(id, { worker: WORKER, code: "STORE_UNAVAILABLE", message: "m", noticeMd: "n", usage: usage1 }, env), true);
  assert.equal(strayOpenRows(env), 0);
  retryJob(id, {}, env);
  assert.equal(claim(env, id).claim_attempt, 2);
  const usage2 = { tokensIn: 100, tokensOut: 50, costUsd: 1 };
  const orch2 = { turns: 3, reads: 1, bash: 2, bashExplore: 0, ctxLast: 900 };
  finishJob(id, { worker: WORKER, status: "gate", result: { status: "gate", exitCode: 0 }, noticeMd: "q?", usage: usage2, orchestrator: orch2 }, env);
  assert.equal(strayOpenRows(env), 0);
  retryJob(id, { note: "the answer" }, env);
  assert.equal(claim(env, id).claim_attempt, 3);
  const usage3 = { tokensIn: 1000, tokensOut: 500, costUsd: 2 };
  const orch3 = { turns: 4, reads: 2, bash: 1, bashExplore: 1, ctxLast: 1200 };
  finishJob(id, { worker: WORKER, status: "done", result: { status: "done" }, usage: usage3, orchestrator: orch3 }, env);
  assert.equal(strayOpenRows(env), 0);
  return id;
}

// Pins the attempt rows of a job to known instants: 10:00-10:10 and 11:00-11:05, the job first started at 10:00.
function pinTwoAttempts(env, id) {
  const db = openDb(env);
  db.prepare("UPDATE job_attempts SET started_at = '2026-10-06 10:00:00', finished_at = '2026-10-06 10:10:00' WHERE job_id = ? AND attempt = 1").run(id);
  db.prepare("UPDATE job_attempts SET started_at = '2026-10-06 11:00:00', finished_at = '2026-10-06 11:05:00' WHERE job_id = ? AND attempt = 2").run(id);
  db.prepare("UPDATE jobs SET started_at = '2026-10-06 10:00:00' WHERE id = ?").run(id);
}

test("a gated, retried and finished job keeps one attempt row per claim, and the job's tokens and cost are their sum", (t) => {
  const env = makeQueue(t, "attempts-history");
  const id = gatedRetriedAndDone(env);
  const view = viewOf(env, id);
  assert.deepEqual(attemptsOf(env, id), [
    { attempt: 1, outcome: "gate", exit: "STORE_UNAVAILABLE", spawns: 1, out: 5, fresh: false },
    { attempt: 2, outcome: "gate", exit: "exit:0", spawns: 1, out: 50, fresh: false },
    { attempt: 3, outcome: "done", exit: null, spawns: 1, out: 500, fresh: false },
  ]);
  assert.equal(view.tokens_in, 1110);
  assert.equal(view.tokens_out, 555);
  assert.equal(view.cost_usd, 3.5);
  assert.equal(view.orch_turns, 7, "the orchestrator turns were not summed");
  assert.equal(view.orch_ctx_last, 1200, "the last context is the last attempt's, never a sum");
  assert.equal(view.started_at, view.attempts_log[0].started_at, "the first start moved with a later claim");
  assert.equal(view.attempt_started_at, null);
  assert.equal(view.attempts_log.reduce((sum, row) => sum + row.duration_s, 0), view.active_s);
});

test("active_s sums the attempts' durations and wall_s spans the first start to the last end; the CLI prints both and labels the two counts", async (t) => {
  const env = makeQueue(t, "attempts-durations");
  const id = enqueue(env, { maxAttempts: 3 });
  claim(env, id);
  releaseJob(id, { worker: WORKER, result: { interrupted: true } }, env);
  claim(env, id);
  finishJob(id, { worker: WORKER, status: "done", result: { status: "done", exitCode: 0 } }, env);
  pinTwoAttempts(env, id);

  const view = viewOf(env, id);
  assert.equal(view.active_s, 900);
  assert.equal(view.wall_s, 3900);
  assert.deepEqual(view.attempts_log.map((row) => row.duration_s), [600, 300]);

  const table = await statusLines(env);
  assert.match(table.find((line) => line.startsWith(`J-${id} `)) ?? "", /\b15m00s\b/, "DURATION is not the active time");
  const detail = await statusLines(env, [`J-${id}`]);
  assert.ok(detail.includes("attempts_log    2 attempts"), detail.join("\n"));
  assert.ok(detail.includes("attempts        1 / 3 (budget counter: inner retries count)"), detail.join("\n"));
  assert.ok(detail.includes("active_s        15m00s (900 s)"), detail.join("\n"));
  assert.ok(detail.includes("wall_s          1h05m (3900 s)"), detail.join("\n"));
  assert.ok(detail.some((line) => /^ {2}#1 {2}2026-10-06T10:00:00Z {2}10m00s {2}released \(interrupted\)/.test(line)), detail.join("\n"));
});

test("a running attempt counts up to the read in active_s and wall_s, and only the closed rows carry a duration", (t) => {
  const env = makeQueue(t, "attempts-running");
  const id = enqueue(env, { maxAttempts: 2 });
  claim(env, id);
  releaseJob(id, { worker: WORKER }, env);
  claim(env, id);
  const db = openDb(env);
  db.prepare("UPDATE job_attempts SET started_at = datetime('now', '-200 seconds'), finished_at = datetime('now', '-140 seconds') WHERE job_id = ? AND attempt = 1").run(id);
  db.prepare("UPDATE job_attempts SET started_at = datetime('now', '-100 seconds') WHERE job_id = ? AND attempt = 2").run(id);
  db.prepare("UPDATE jobs SET started_at = datetime('now', '-200 seconds') WHERE id = ?").run(id);

  const view = viewOf(env, id);
  assert.deepEqual(view.attempts_log.map((row) => row.duration_s), [60, null]);
  assert.ok(view.active_s >= 160 && view.active_s <= 162, `active_s ${view.active_s}`);
  assert.ok(view.wall_s >= 200 && view.wall_s <= 202, `wall_s ${view.wall_s}`);
});

test("inner re-spawns are counted on the claim's one row, and a re-spawn after the row closed counts nothing", (t) => {
  const env = makeQueue(t, "attempts-spawns");
  const id = enqueue(env, { maxAttempts: 3 });
  claim(env, id);
  assert.equal(countAttempt(id, { worker: WORKER }, env), true);
  assert.equal(countAttempt(id, { worker: WORKER }, env), true);
  assert.equal(getJob(id, env).attempts, 3, "the budget counter did not move with the re-spawns");
  assert.deepEqual(attemptsOf(env, id).map((row) => row.spawns), [3]);

  assert.ok(cancelRunningJob(id, { worker: WORKER, reason: "stop" }, env));
  assert.equal(strayOpenRows(env), 0);
  assert.equal(countAttempt(id, { worker: WORKER }, env), false);
  assert.deepEqual(attemptsOf(env, id), [{ attempt: 1, outcome: "cancelled", exit: "stop", spawns: 3, out: null, fresh: false }]);
  assert.equal(jobView(getJob(id, env)).attempts_log.length, 1);
});

test("the late measures of a cancelled attempt land once, however many times they are written", (t) => {
  const env = makeQueue(t, "attempts-late-measures");
  const id = enqueue(env);
  claim(env, id);
  cancelRunningJob(id, { worker: WORKER }, env);
  const spec = { attempt: 1, usage: { tokensIn: 30, tokensOut: 7, costUsd: 0.25 }, hostCommands: { bashTimeouts: 1 } };
  assert.equal(recordAttemptMeasures(id, spec, env), true);
  assert.equal(recordAttemptMeasures(id, spec, env), false);
  const view = viewOf(env, id);
  assert.deepEqual([view.tokens_out, view.cost_usd, view.bash_timeouts], [7, 0.25, 1]);
  assert.equal(view.attempts_log[0].tokens_out, 7);
  assert.throws(() => recordAttemptMeasures(id, { usage: {} }, env), /positive integer `attempt`/);
});

test("a park and an interrupted release keep the claim as `released`, and a --fresh retry marks only the next row", (t) => {
  const env = makeQueue(t, "attempts-released-fresh");
  const id = enqueue(env, { maxAttempts: 2 });
  claim(env, id);
  parkJob(id, { worker: WORKER, notBefore: new Date(Date.now() - 1000).toISOString(), usage: { tokensOut: 11 } }, env);
  claim(env, id);
  releaseJob(id, { worker: WORKER, result: { interrupted: true }, usage: { tokensOut: 13 } }, env);
  claim(env, id);
  finishJob(id, { worker: WORKER, status: "failed", result: { status: "failed", timedOut: true }, usage: { tokensOut: 17 } }, env);
  retryJob(id, { fresh: true }, env);
  claim(env, id);
  finishJob(id, { worker: WORKER, status: "done", result: { status: "done", exitCode: 0 } }, env);
  assert.equal(strayOpenRows(env), 0);

  assert.deepEqual(attemptsOf(env, id), [
    { attempt: 1, outcome: "released", exit: "rate_limited", spawns: 1, out: 11, fresh: false },
    { attempt: 2, outcome: "released", exit: "interrupted", spawns: 1, out: 13, fresh: false },
    { attempt: 3, outcome: "timed_out", exit: "timeout", spawns: 1, out: 17, fresh: false },
    { attempt: 4, outcome: "done", exit: "exit:0", spawns: 1, out: null, fresh: true },
  ]);
  assert.equal(viewOf(env, id).tokens_out, 41);
  assert.equal(openDb(env).prepare("SELECT next_attempt_fresh FROM jobs WHERE id = ?").get(id).next_attempt_fresh, null);
});

test("the sweep closes a dead runner's attempt as lost at its last lease renewal and keeps the job's first start", (t) => {
  const env = makeQueue(t, "attempts-sweep");
  const id = enqueue(env, { maxAttempts: 2, timeoutS: 60 });
  claim(env, id);
  const db = openDb(env);
  db.prepare("UPDATE job_attempts SET started_at = datetime('now', '-1000 seconds') WHERE job_id = ?").run(id);
  db.prepare("UPDATE jobs SET lease_until = datetime('now', '-800 seconds', '+660 seconds') WHERE id = ?").run(id);

  assert.deepEqual(sweepOrphans(env), { failed: 0, requeued: 1 });
  assert.equal(strayOpenRows(env), 0);
  const view = viewOf(env, id);
  assert.deepEqual(attemptsOf(env, id).map(({ outcome, exit }) => ({ outcome, exit })), [{ outcome: "lost", exit: "orphaned" }]);
  assert.ok(Math.abs(view.attempts_log[0].duration_s - 200) <= 1, `duration ${view.attempts_log[0].duration_s}`);
  assert.ok(view.started_at, "the sweep forgot the first start");
});

test("a retried job is protected by the ceiling of its current attempt, not by the age of its first start", (t) => {
  const env = makeQueue(t, "attempts-ceiling");
  const id = enqueue(env, { maxAttempts: 2, timeoutS: 60 });
  claim(env, id);
  releaseJob(id, { worker: WORKER }, env);
  openDb(env).prepare("UPDATE jobs SET started_at = datetime('now', '-100000 seconds') WHERE id = ?").run(id);
  claim(env, id);
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);

  assert.deepEqual(sweepOrphans(env, { liveWorkerImpl: () => true }), { failed: 0, requeued: 0 });
  assert.equal(getJob(id, env).status, "running");
});

test("a queued measures record replays once, and a superseded queued finish still lands its attempt's measures once", async (t) => {
  const env = makeQueue(t, "attempts-pending-writes");
  const projectId = ensureProject(env, "alpha");
  const slug = "fix-the-worker";
  mkdirSync(runDir(projectId, slug, env), { recursive: true });
  const store = openStore(env);
  const id = enqueue(env);
  claim(env, id);
  cancelRunningJob(id, { worker: WORKER }, env);
  const measures = { key: PENDING_KEYS.measures(id, 1), kind: "measures", jobId: id, payload: { attempt: 1, usage: { tokensOut: 9 } } };
  assert.equal(appendPendingWrite({ projectId, slug, entry: measures, env }).status, "queued");
  assert.equal((await replayPendingWrites({ projectId, slug, env, store })).applied, 1);
  assert.equal(appendPendingWrite({ projectId, slug, entry: measures, env }).status, "queued");
  assert.equal((await replayPendingWrites({ projectId, slug, env, store })).superseded, 1);
  assert.equal(viewOf(env, id).tokens_out, 9);

  const other = enqueue(env);
  claim(env, other);
  cancelRunningJob(other, { worker: WORKER }, env);
  const finish = { worker: WORKER, status: "done", result: { status: "done" }, usage: { tokensOut: 21 }, attempt: 1 };
  appendPendingWrite({ projectId, slug, entry: { key: PENDING_KEYS.finish(other, WORKER), kind: "finish", jobId: other, payload: finish }, env });
  assert.equal((await replayPendingWrites({ projectId, slug, env, store })).filled, 1);
  appendPendingWrite({ projectId, slug, entry: { key: PENDING_KEYS.finish(other, WORKER), kind: "finish", jobId: other, payload: finish }, env });
  assert.equal((await replayPendingWrites({ projectId, slug, env, store })).superseded, 1);
  assert.equal(viewOf(env, other).tokens_out, 21);
  assert.equal(viewOf(env, other).status, "cancelled", "a superseded finish moved the row");
});

test("a row read without its attempts (a cancel's or a retry's answer) carries none of the attempt keys", (t) => {
  const env = makeQueue(t, "attempts-returning");
  const id = enqueue(env);
  claim(env, id);
  const cancelled = cancelRunningJob(id, { worker: WORKER }, env);
  assert.equal("attempts_log" in cancelled, false);
  assert.equal("active_s" in cancelled, false);
  const pending = viewOf(env, enqueue(env));
  assert.deepEqual([pending.attempts_log, pending.active_s, pending.wall_s], [[], null, null]);
});

test("the queue view and the detail view of queue_status both carry attempts_log with spawns, active_s and wall_s", async (t) => {
  const env = makeQueue(t, "attempts-queue-status");
  const id = enqueue(env, { maxAttempts: 3 });
  claim(env, id);
  countAttempt(id, { worker: WORKER }, env);
  finishJob(id, { worker: WORKER, status: "done", result: { status: "done" }, usage: { tokensOut: 3 } }, env);
  const store = openStore(env);
  const listed = (await queueView(store, { env })).jobs.find((job) => job.id === id);
  const single = await jobDetailView(store, id, { env });
  for (const job of [listed, single]) {
    assert.deepEqual(job.attempts_log.map((row) => [row.attempt, row.spawns, row.outcome, row.tokens_out]), [[1, 2, "done", 3]]);
    assert.ok(Number.isInteger(job.active_s) && Number.isInteger(job.wall_s));
    assert.equal(job.attempts, 2, "the budget counter is not the history count");
  }
});
