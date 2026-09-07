import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import {
  addJob,
  cancelJob,
  claimJobById,
  claimNextJob,
  countAttempt,
  countActiveJobs,
  countsByStatus,
  finishJob,
  getJob,
  jobView,
  listJobs,
  peekNextJob,
  persistRunFacts,
  releaseJob,
  renewLease,
} from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:1000";
const OTHER_WORKER = "host:2000";
const CAP = 4;
const GATED_FINISHED_AT = "2020-01-01 00:00:00";

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
  assert.deepEqual({ ...job, id: undefined }, { id: undefined, project: "alpha", priority: 5, maxAttempts: 1, timeoutS: 14400 });
  assert.equal(getJob(job.id, env).prompt, "fix the worker");
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

test("release gives the job back without spending the attempt and keeps the previous reason", (t) => {
  const env = makeQueue(t, "jobs-release");
  const id = enqueue(env);
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  assert.equal(releaseJob(id, { worker: OTHER_WORKER, result: null }, env), false, "a foreign worker released the job");
  assert.equal(releaseJob(id, { worker: WORKER, result: { blocked: { code: "dirty-checkout" } } }, env), true);
  const released = getJob(id, env);
  assert.deepEqual(
    { status: released.status, attempts: released.attempts, worker: released.worker, lease: released.lease_until },
    { status: "pending", attempts: 0, worker: null, lease: null },
  );
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  releaseJob(id, { worker: WORKER, result: null }, env);
  assert.match(getJob(id, env).result, /dirty-checkout/, "a release with no reason erased the previous block");
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

test("cancel refuses a job in every terminal state without touching the row", (t) => {
  const env = makeQueue(t, "jobs-cancel-terminal");
  for (const status of ["done", "failed", "cancelled"]) {
    const id = enqueue(env);
    openDb(env).prepare("UPDATE jobs SET status = ?, finished_at = datetime('now') WHERE id = ?").run(status, id);
    const before = getJob(id, env);
    assert.throws(() => cancelJob(id, { reason: "too late" }, env), new RegExp(`already finished with status \`${status}\``));
    assert.deepEqual(getJob(id, env), before, `the refused cancel wrote to a ${status} job`);
  }
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
  assert.equal(jobView(null), null);
});

test("the listing is newest first with a clamped limit, and the counts cover every status", (t) => {
  const env = makeQueue(t, "jobs-list");
  const ids = [enqueue(env), enqueue(env), enqueue(env)];
  assert.deepEqual(listJobs({}, env).map((row) => row.id), [...ids].reverse());
  assert.equal(listJobs({ limit: 1 }, env).length, 1);
  assert.throws(() => listJobs({ limit: 0 }, env), /invalid `limit`/);
  assert.throws(() => listJobs({ limit: 500 }, env), /invalid `limit`/);
  claimJobById(ids[0], { worker: WORKER, cap: CAP }, env);
  assert.deepEqual(countsByStatus(env), { pending: 2, running: 1, done: 0, gate: 0, failed: 0, cancelled: 0 });
});
