import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import {
  addJob,
  cancelJob,
  claimJobById,
  claimNextJob,
  closeJob,
  countAttempt,
  countActiveJobs,
  countActiveJobsByProject,
  countPendingBlocked,
  countsByStatus,
  finishJob,
  getJob,
  hasClaimablePending,
  jobView,
  listJobs,
  parkJob,
  peekNextJob,
  persistRunFacts,
  releaseJob,
  renewLease,
  retryJob,
} from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

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
    .prepare("UPDATE jobs SET status = 'failed', slug = ?, branch = ?, session_id = ?, finished_at = datetime('now') WHERE id = ?")
    .run("fix-it", "fix/it", SESSION_ID, id);

  const job = retryJob(id, { fresh: true }, env);
  assert.equal(job.slug, null);
  assert.equal(job.branch, null);
  assert.equal(job.session_id, null);
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
  assert.deepEqual(
    { merged_at: view.merged_at, merge_sha: view.merge_sha },
    { merged_at: null, merge_sha: null },
    "the view of a job hides the merge columns",
  );
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
  assert.deepEqual(countsByStatus(env), { pending: 2, running: 1, done: 0, gate: 0, failed: 0, cancelled: 0, closed: 0 });
  assert.equal("merged" in countsByStatus(env), false, "the retired merged status is still counted");
});

test("close takes a done job to closed, keeps pr_url and finished_at, and refuses every other status by name without writing", (t) => {
  const env = makeQueue(t, "jobs-close");
  const delivered = enqueue(env);
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', pr_url = ?, finished_at = ? WHERE id = ?")
    .run("https://github.com/acme/api/pull/7", GATED_FINISHED_AT, delivered);
  const closed = closeJob(delivered, env);
  assert.equal(closed.status, "closed");
  assert.equal(closed.pr_url, "https://github.com/acme/api/pull/7");
  assert.equal(getJob(delivered, env).finished_at, GATED_FINISHED_AT, "the close rewrote finished_at");
  assert.deepEqual({ merged_at: closed.merged_at, merge_sha: closed.merge_sha }, { merged_at: null, merge_sha: null });

  for (const status of ["pending", "running", "gate", "failed", "cancelled"]) {
    const id = enqueue(env);
    openDb(env).prepare("UPDATE jobs SET status = ? WHERE id = ?").run(status, id);
    const before = getJob(id, env);
    assert.throws(() => closeJob(id, env), new RegExp(`cannot be closed from status \`${status}\`; only a \`done\` job is closed`));
    assert.deepEqual(getJob(id, env), before, `the refused close wrote to a ${status} job`);
  }
  const before = getJob(delivered, env);
  assert.throws(() => closeJob(delivered, env), /job `\d+` is already closed/);
  assert.deepEqual(getJob(delivered, env), before, "the refused close wrote to a closed job");
  assert.throws(() => closeJob(9999, env), /unknown job `9999`/);
  assert.throws(() => closeJob(0, env), /positive integer job id/);
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
