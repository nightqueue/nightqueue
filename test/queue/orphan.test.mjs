import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, countAttempt, getJob, sweepOrphans } from "../../src/memory/jobs.mjs";
import { acquire } from "../../src/queue/claim.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const DEAD_WORKER = "host:6666";
const CAP = 4;

// A home with two registered projects and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  return env;
}

// Enqueues a job and claims it for a runner that is about to be declared dead.
function claimedJob(env, { project = "alpha", maxAttempts = 1 } = {}) {
  const id = addJob({ project, prompt: "fix the worker", maxAttempts }, env).id;
  claimJobById(id, { worker: DEAD_WORKER, cap: CAP }, env);
  return id;
}

// Moves the lease of a job past the reclaim grace, which is how a runner that died looks from the outside.
function expireLease(env, id) {
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
}

test("an orphan with attempts left goes back to pending with its attempts preserved", (t) => {
  const env = makeQueue(t, "orphan-requeue");
  const id = claimedJob(env, { maxAttempts: 3 });
  countAttempt(id, { worker: DEAD_WORKER }, env);
  assert.equal(getJob(id, env).attempts, 2);
  expireLease(env, id);

  assert.deepEqual(sweepOrphans(env), { failed: 0, requeued: 1 });
  const row = getJob(id, env);
  assert.deepEqual(
    { status: row.status, attempts: row.attempts, worker: row.worker, lease: row.lease_until, started: row.started_at },
    { status: "pending", attempts: 2, worker: null, lease: null, started: null },
  );
  assert.deepEqual(sweepOrphans(env), { failed: 0, requeued: 0 }, "the sweep touched a job that is already pending");
});

test("an orphan that already spent the max_attempts of its own row fails instead of coming back", (t) => {
  const env = makeQueue(t, "orphan-exhausted");
  const id = claimedJob(env, { maxAttempts: 1 });
  expireLease(env, id);

  assert.deepEqual(sweepOrphans(env), { failed: 1, requeued: 0 });
  const row = getJob(id, env);
  assert.equal(row.status, "failed");
  assert.equal(row.worker, null);
  assert.deepEqual(JSON.parse(row.result), { orphaned: true });
  assert.ok(row.finished_at, "the failed orphan has no finished_at");
});

test("the sweep only touches a running job whose lease is gone", (t) => {
  const env = makeQueue(t, "orphan-scope");
  const alive = claimedJob(env, { maxAttempts: 3 });
  const pending = addJob({ project: "alpha", prompt: "another one" }, env).id;
  const dead = claimedJob(env, { project: "beta", maxAttempts: 3 });
  expireLease(env, dead);

  assert.deepEqual(sweepOrphans(env), { failed: 0, requeued: 1 });
  assert.equal(getJob(alive, env).status, "running", "a job with a live lease was requeued");
  assert.equal(getJob(alive, env).worker, DEAD_WORKER);
  assert.equal(getJob(pending, env).status, "pending");
  assert.equal(getJob(dead, env).status, "pending");
});

test("a job that keeps re-arming its lease is never swept while its retry loop runs", (t) => {
  const env = makeQueue(t, "orphan-alive");
  const id = claimedJob(env, { maxAttempts: 3 });
  expireLease(env, id);
  assert.equal(countAttempt(id, { worker: DEAD_WORKER }, env), true, "the retry loop could not re-arm the lease");

  assert.deepEqual(sweepOrphans(env), { failed: 0, requeued: 0 });
  assert.equal(getJob(id, env).status, "running");
  assert.equal(getJob(id, env).worker, DEAD_WORKER);
});

test("a claim sweeps first, so the job of a dead runner is taken by the next one", (t) => {
  const env = makeQueue(t, "orphan-acquire");
  const id = claimedJob(env, { maxAttempts: 3 });
  expireLease(env, id);

  const claimed = acquire({ cap: CAP, env });
  assert.equal(claimed.job?.id, id);
  assert.equal(claimed.reason, "claimed");
  assert.notEqual(claimed.job.worker, DEAD_WORKER, "the dead runner still owns the job");
  assert.equal(claimed.job.attempts, 2, "the requeue and the claim both spent an attempt");
});
