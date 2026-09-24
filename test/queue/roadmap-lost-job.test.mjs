import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { cancelJob, getJob } from "../../src/memory/jobs.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { getRoadmapItem, queueRoadmapItem, queueableRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, failureStream, gateStream } from "../../test-support/streams.mjs";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// A home with one registered project and one queueable roadmap item.
function makeItemHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const item = saveRoadmapItem({ project: "alpha", horizon: "now", title: "deliver the thing" }, env);
  return { env, item };
}

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Polls a condition instead of guessing a delay.
async function waitFor(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Pushes a job's lease and start time far enough into the past for `sweepOrphans` to treat it as dead.
function expireLease(env, jobId) {
  openDb(env)
    .prepare(`UPDATE jobs SET lease_until = datetime('now', '-120 seconds'), started_at = datetime('now', '-120 seconds') WHERE id = ?`)
    .run(jobId);
}

test("finishJob returning false strands the item behind a phantom `running` job, but the refusal is actionable and the item self-heals once the stolen lease expires", async (t) => {
  const { env, item } = makeItemHome(t, "roadmap-lost-finishjob-false");
  const planPath = useFakeClaude(env, makeDir(t, "roadmap-lost-finishjob-false-plan"), [{ stdout: doneStream(), holdMs: 400, exitCode: 0 }]);
  const queued = await queueRoadmapItem({ id: item.id }, env);

  const cycle = runCycle({ jobId: queued.job.id, env, deps: { gitImpl: fakeGit(), stopSignalImpl: () => false } });
  await waitFor(() => fakeCalls(planPath).length > 0, "the fake claude to start");
  openDb(env).prepare("UPDATE jobs SET worker = ? WHERE id = ?").run("phantom:9999", queued.job.id);
  const done = await cycle;

  assert.deepEqual(done.processed, [{ id: queued.job.id, status: "lost", prUrl: "https://github.com/acme/api/pull/42", attempts: 1 }]);
  const row = getJob(queued.job.id, env);
  assert.deepEqual(
    { status: row.status, worker: row.worker, finished: row.finished_at, result: row.result },
    { status: "running", worker: "phantom:9999", finished: null, result: null },
    "finishJob's `written &&` guard skipped the write, but never released the row either: the job is stuck `running` forever under a worker that does not exist",
  );
  assert.equal(getRoadmapItem(item.id, env).status, "queued", "closeRoadmapItem was correctly skipped: the item was never marked done for work that was never confirmed written");

  assert.throws(
    () => queueableRoadmapItem(item.id, env),
    /already queued as job `\d+` \(`running`\); cancel that job first/,
    "queue_add on the item is refused with an ACTIONABLE message, not a silent no-op",
  );
  assert.throws(
    () => cancelJob(queued.job.id, {}, env),
    /is running with a live lease on worker `phantom:9999`; stop that runner first/,
    "but the literal remedy the refusal names does not work either: nothing can `stop that runner`, it never existed",
  );

  expireLease(env, queued.job.id);
  await runCycle({ env, deps: { gitImpl: fakeGit() } });
  assert.equal(getJob(queued.job.id, env).status, "failed", "once the lease's grace window passes, the NEXT queue cycle sweeps the orphan on its own");
  const requeued = await queueRoadmapItem({ id: item.id }, env);
  assert.notEqual(requeued.job.id, queued.job.id, "the item is queueable again through the normal path, once the stolen lease has aged out");
  assert.equal(getRoadmapItem(item.id, env).job_id, requeued.job.id);
});

test("runJob returning early via run.lost (ownership stolen mid-run, detected by the real poll) never reaches finalize, and lands in the exact same phantom-running limbo", async (t) => {
  const { env, item } = makeItemHome(t, "roadmap-lost-run-lost");
  const planPath = useFakeClaude(env, makeDir(t, "roadmap-lost-run-lost-plan"), [{ stdout: doneStream(), holdMs: 5000, exitCode: 0 }]);
  const queued = await queueRoadmapItem({ id: item.id }, env);

  const cycle = runCycle({ jobId: queued.job.id, env, deps: { gitImpl: fakeGit(), stopPollMs: 200 } });
  await waitFor(() => fakeCalls(planPath).length > 0, "the fake claude to start");
  openDb(env).prepare("UPDATE jobs SET worker = ? WHERE id = ?").run("phantom:1234", queued.job.id);
  const done = await cycle;

  assert.deepEqual(done.processed, [{ id: queued.job.id, status: "lost", attempts: 1 }]);
  const row = getJob(queued.job.id, env);
  assert.deepEqual(
    { status: row.status, worker: row.worker, finished: row.finished_at },
    { status: "running", worker: "phantom:1234", finished: null },
    "runJob returned via `run.lost` before `finalize()` ever ran: closeRoadmapItem was never even a candidate to be called",
  );
  assert.equal(getRoadmapItem(item.id, env).status, "queued");
  assert.throws(
    () => queueableRoadmapItem(item.id, env),
    /already queued as job `\d+` \(`running`\); cancel that job first/,
    "same actionable (if misleading) refusal as the finishJob-false path: both bypass-of-finalize routes share one root and one recovery story",
  );
});

test("runJob returning early via ctx.state.stopping (an interrupted runner) is NOT stranded: the job goes back to pending and later finishes the SAME item through the normal done hook", async (t) => {
  const { env, item } = makeItemHome(t, "roadmap-lost-interrupted");
  useFakeClaude(env, makeDir(t, "roadmap-lost-interrupted-plan"), [{ stdout: doneStream(), holdMs: 5000, exitCode: 0 }]);
  const queued = await queueRoadmapItem({ id: item.id }, env);

  const cycle = runCycle({ jobId: queued.job.id, env, deps: { gitImpl: fakeGit(), stopPollMs: 200 } });
  await waitFor(() => getJob(queued.job.id, env).status === "running", "the job to start running");
  process.emit("SIGINT");
  const done = await cycle;

  assert.deepEqual(done.processed, [{ id: queued.job.id, status: "interrupted", attempts: 1 }]);
  const interrupted = getJob(queued.job.id, env);
  assert.deepEqual(
    { status: interrupted.status, worker: interrupted.worker, attempts: interrupted.attempts },
    { status: "pending", worker: null, attempts: 0 },
    "release() puts the SAME job back at the front of the queue; this is not a phantom, it is a normal retryable job",
  );
  assert.equal(getRoadmapItem(item.id, env).status, "queued", "the item still points at the same job id, which is exactly correct here");

  const finish = await runCycle({ jobId: queued.job.id, env, deps: { gitImpl: fakeGit() } });
  assert.deepEqual(finish.processed.map((entry) => entry.status), ["done"]);
  assert.equal(getRoadmapItem(item.id, env).status, "done", "the interrupted path self-heals completely with no operator action at all, unlike the two lost-ownership paths above");
});

test("a `gate` outcome keeps the item correctly queued behind a retryable job; a `failed` outcome frees the item for a normal re-queue", async (t) => {
  const { env: gateEnv, item: gateItem } = makeItemHome(t, "roadmap-lost-gate");
  useFakeClaude(gateEnv, makeDir(t, "roadmap-lost-gate-plan"), [{ stdout: gateStream(), exitCode: 0 }, { stdout: doneStream(), exitCode: 0 }]);
  const gateQueued = await queueRoadmapItem({ id: gateItem.id }, gateEnv);
  const gateCycle = await runCycle({ jobId: gateQueued.job.id, env: gateEnv, deps: { gitImpl: fakeGit() } });
  assert.deepEqual(gateCycle.processed.map((entry) => entry.status), ["gate"]);
  assert.equal(getJob(gateQueued.job.id, gateEnv).status, "gate");
  assert.equal(getRoadmapItem(gateItem.id, gateEnv).status, "queued");
  assert.throws(
    () => queueableRoadmapItem(gateItem.id, gateEnv),
    /already queued as job `\d+` \(`gate`\); cancel that job first/,
    "a gated job is correctly treated as still alive: queue_add refuses it",
  );
  await applyRetry({ id: gateQueued.job.id, note: "go ahead", env: gateEnv });
  const gateRetryCycle = await runCycle({ jobId: gateQueued.job.id, env: gateEnv, deps: { gitImpl: fakeGit() } });
  assert.deepEqual(gateRetryCycle.processed.map((entry) => entry.status), ["done"]);
  assert.equal(getRoadmapItem(gateItem.id, gateEnv).status, "done", "the intended path (queue_retry, not queue_add) resolves the SAME job and closes the SAME item; gate is recoverable by design");

  const { env: failedEnv, item: failedItem } = makeItemHome(t, "roadmap-lost-failed");
  useFakeClaude(failedEnv, makeDir(t, "roadmap-lost-failed-plan"), [{ stdout: failureStream(), exitCode: 1 }]);
  const failedQueued = await queueRoadmapItem({ id: failedItem.id }, failedEnv);
  const failedCycle = await runCycle({ jobId: failedQueued.job.id, env: failedEnv, deps: { gitImpl: fakeGit() } });
  assert.deepEqual(failedCycle.processed.map((entry) => entry.status), ["failed"]);
  assert.equal(getJob(failedQueued.job.id, failedEnv).status, "failed");
  assert.equal(getRoadmapItem(failedItem.id, failedEnv).status, "queued", "the item's own status column is untouched by a failed job, same as a done one");
  assert.doesNotThrow(
    () => queueableRoadmapItem(failedItem.id, failedEnv),
    "a `failed` job is NOT live: queueableRoadmapItem lets the item straight through the normal path, no cancel needed",
  );
  const failedRequeued = await queueRoadmapItem({ id: failedItem.id }, failedEnv);
  assert.notEqual(failedRequeued.job.id, failedQueued.job.id);
  assert.equal(getRoadmapItem(failedItem.id, failedEnv).job_id, failedRequeued.job.id, "failed self-heals immediately, no lease expiry needed at all");
});
