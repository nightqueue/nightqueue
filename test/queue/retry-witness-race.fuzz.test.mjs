import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob, retryJob } from "../../src/memory/jobs.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { readRunState, writeRunTerminal } from "../../src/queue/resume.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:1000";
const CAP = 4;
const SLUG = "fix-worker";
const FINISHED_AT = "2026-09-11T03:15:00Z";
const WRITTEN_BY = "/tmp/runtime/versions/0.1.0-20260911T031500Z";

// A home with one registered project and the queue table ready (mirrors witness-reconcile.test.mjs).
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Enqueues a job, claims it and records the slug of its run: the row a runner owns while it works.
function runningJob(env, { slug = SLUG } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  return id;
}

// Moves the lease past the reclaim grace, which is how a runner that died looks from the outside.
function expireLease(env, id) {
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
}

// Writes the witness a runner leaves next to the run once it has finished the job.
function witness(env, { slug = SLUG, status = "failed", prUrl = null } = {}) {
  return writeRunTerminal({
    project: "alpha",
    slug,
    terminal: { status, prUrl, finishedAt: FINISHED_AT, writtenBy: WRITTEN_BY, pid: 4242 },
    env,
  });
}

// A job whose row still says `running` under a dead runner, with the witness of its real outcome on disk.
function lostFinish(env, options = {}) {
  const id = runningJob(env, options);
  expireLease(env, id);
  witness(env, options);
  return id;
}

test("a reconciliation landing between retryJob and clearRunTerminal must not revert a fresh retry to its previous outcome", (t) => {
  const env = makeQueue(t, "retry-witness-race");
  const id = lostFinish(env, { status: "failed", prUrl: null });

  // Establish the real starting point of a retry: the lost finish is legitimately reconciled to `failed` first, exactly as an operator running `queue status` before retrying would observe.
  assert.deepEqual(reconcileFromWitness(env).repaired, [id], "setup: the lost finish was not reconciled to failed first");
  assert.equal(getJob(id, env).status, "failed");

  // `applyRetry` (src/queue/retry.mjs) calls exactly this sequence: `retryJob(id, {...}, env)` first, `clearRunTerminal(run)` only after.
  // Reproduce the intermediate state a second OS process (`queue status`, MCP `queue_status`, or the top of a live `runCycle`)
  // observes if it runs its own `reconcileFromWitness` in the wall-clock gap between those two calls: call the SAME public
  // function `applyRetry` calls, in the SAME order, and stop short of the second call — this is the exact window, not a
  // contrived internal ordering.
  retryJob(id, { note: null, fresh: false }, env);
  assert.equal(getJob(id, env).status, "pending", "retryJob itself did not flip the row to pending");
  assert.notEqual(
    readRunState({ project: "alpha", slug: SLUG, env })?.terminal,
    undefined,
    "setup: the witness of the previous attempt was already cleared before retryJob committed — the race window does not exist in this build",
  );

  // A concurrent process's reconciliation lands here, in the gap, before `clearRunTerminal` ever runs.
  reconcileFromWitness(env);

  assert.equal(
    getJob(id, env).status,
    "pending",
    "a job the operator just retried was silently closed again by the witness of its previous attempt",
  );
});
