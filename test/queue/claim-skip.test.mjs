import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimNextJob, getJob, hasClaimablePending, releaseJob } from "../../src/memory/jobs.mjs";
import { acquire } from "../../src/queue/claim.mjs";
import { runCycle, runDrain } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL, rateLimitEvent, recordedDone, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const WORKER = "host-a:1";

// A limit whose reset already passed: the attempt parks, and the job is due again at once.
const OVER_LIMIT = toNdjson([systemInitEvent({}), rateLimitEvent({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 3600 })]);
const COMES_BACK_PENDING = { stdout: OVER_LIMIT, exitCode: 1 };

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// The dependencies of a real cycle whose clock never sleeps.
function cycleDeps() {
  return { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} };
}

// A home with one registered project and the fake `claude` answering these attempts in order.
function makeRunnerHome(t, name, attempts) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return env;
}

// A home with one registered project and no fake `claude`, for what stops at the claim.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Enqueues one job of the test project.
function enqueue(env) {
  return addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
}

// How many claims of this job opened an attempt row.
function attemptRows(env, id) {
  return openDb(env).prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE job_id = ?").get(id).n;
}

test("claimNextJob skips the excluded ids, in queue order, and an empty list excludes nothing", (t) => {
  const env = makeQueue(t, "claim-skip-order");
  const [first, second, third] = [enqueue(env), enqueue(env), enqueue(env)];

  assert.equal(claimNextJob({ worker: WORKER, cap: null, excludeIds: [first] }, env).id, second);
  assert.equal(claimNextJob({ worker: WORKER, cap: null, excludeIds: [first, third] }, env), null);
  assert.equal(getJob(first, env).status, "pending");
  assert.equal(attemptRows(env, first), 0, "a skipped job opened an attempt row");
  assert.equal(claimNextJob({ worker: WORKER, cap: null, excludeIds: [] }, env).id, first);
});

test("claimNextJob still honours the ceiling when ids are excluded", (t) => {
  const env = makeQueue(t, "claim-skip-ceiling");
  const [first, second, third] = [enqueue(env), enqueue(env), enqueue(env)];

  assert.equal(claimNextJob({ worker: WORKER, cap: 1, excludeIds: [first] }, env).id, second);
  assert.equal(claimNextJob({ worker: WORKER, cap: 1, excludeIds: [first] }, env), null, "the excluded ids shifted the ceiling's placeholder");
  assert.equal(claimNextJob({ worker: WORKER, cap: 2, excludeIds: [first] }, env).id, third);
});

test("acquire says already-tried only when a job it left out is what is still claimable", async (t) => {
  const env = makeQueue(t, "claim-skip-reasons");
  const id = enqueue(env);

  assert.deepEqual(await acquire({ cap: null, excludeIds: [id], env }), { job: null, reason: "already-tried" });
  assert.deepEqual(await acquire({ cap: 1, excludeIds: [id], env }), { job: null, reason: "already-tried" });
  assert.equal(hasClaimablePending({}, env), true);
  assert.equal(hasClaimablePending({ excludeIds: [id] }, env), false);

  openDb(env).prepare("UPDATE jobs SET not_before = datetime('now', '+1 hour') WHERE id = ?").run(id);
  assert.deepEqual(await acquire({ cap: null, excludeIds: [id], env }), { job: null, reason: "empty-queue" }, "a parked job is not one to retry now");
  openDb(env).prepare("UPDATE jobs SET not_before = NULL WHERE id = ?").run(id);

  const claimed = await acquire({ cap: 1, env });
  assert.equal(claimed.job.id, id);
  assert.deepEqual(await acquire({ cap: null, excludeIds: [id], env }), { job: null, reason: "empty-queue" }, "a job that is running is not one to retry");
  assert.deepEqual(await acquire({ cap: 1, excludeIds: [id], env }), { job: null, reason: "cap-reached" }, "a full ceiling stopped saying so");
  assert.equal(releaseJob(id, { worker: claimed.job.worker, result: null }, env), true);
});

// Skips the next claim of the given job once, as a claim another runner won: the row stays pending while the claim gets nothing.
function raceNextClaim(env, id) {
  const db = openDb(env);
  db.exec("CREATE TABLE claim_race (fired INTEGER NOT NULL)");
  db.exec(`CREATE TRIGGER claim_race_once BEFORE UPDATE OF status ON jobs
    WHEN NEW.status = 'running' AND OLD.id = ${id} AND (SELECT COUNT(*) FROM claim_race) = 0
    BEGIN
      INSERT INTO claim_race (fired) VALUES (1);
      SELECT RAISE(IGNORE);
    END`);
}

test("a raced claim with a job nobody left out says claim-raced, never already-tried, and the next claim takes the job", async (t) => {
  const env = makeQueue(t, "claim-skip-raced");
  const [tried, fresh] = [enqueue(env), enqueue(env)];
  await acquire({ cap: null, env });
  raceNextClaim(env, fresh);

  assert.deepEqual(await acquire({ cap: null, excludeIds: [tried], env }), { job: null, reason: "claim-raced" });
  assert.equal(getJob(fresh, env).status, "pending");
  assert.equal((await acquire({ cap: null, excludeIds: [tried], env })).job.id, fresh);
});

test("a raced claim under a free ceiling with no id left out still says cap-reached, as before", async (t) => {
  const env = makeQueue(t, "claim-skip-raced-cap");
  const id = enqueue(env);
  raceNextClaim(env, id);

  assert.deepEqual(await acquire({ cap: 5, env }), { job: null, reason: "cap-reached" });
});

test("a raced claim never ends a drain: it waits one interval and the next pass runs the job", async (t) => {
  const delivered = { tail: doneStream({ slug: null }), runState: recordedDone(), exitCode: 0 };
  const env = makeRunnerHome(t, "claim-skip-raced-drain", [COMES_BACK_PENDING, delivered, delivered]);
  const [back, fresh] = [enqueue(env), enqueue(env)];
  raceNextClaim(env, fresh);
  const slept = [];

  const passes = await runDrain({ env, deps: { ...cycleDeps(), sleepImpl: async (ms) => slept.push(ms) } });

  assert.equal(passes[0].reason, "claim-raced", JSON.stringify(passes));
  assert.equal(slept.length, 1, `a drain waited ${slept.length} times`);
  assert.deepEqual([getJob(back, env).status, getJob(fresh, env).status], ["done", "done"]);
});

test("a drain over a claim that stays raced waits each pass and ends by its cycles, never spinning", async (t) => {
  const env = makeRunnerHome(t, "claim-skip-raced-forever", []);
  const id = enqueue(env);
  openDb(env).exec(`CREATE TRIGGER claim_race_always BEFORE UPDATE OF status ON jobs WHEN NEW.status = 'running' AND OLD.id = ${id} BEGIN SELECT RAISE(IGNORE); END`);
  const slept = [];

  const passes = await runDrain({ env, cycles: 3, deps: { ...cycleDeps(), sleepImpl: async (ms) => slept.push(ms) } });

  assert.deepEqual(passes.map((pass) => pass.reason), ["claim-raced", "claim-raced", "claim-raced"]);
  assert.equal(slept.length, 2);
  assert.equal(getJob(id, env).status, "pending");
});

test("a named job ignores the exclusion: the operator asked for that one", async (t) => {
  const env = makeQueue(t, "claim-skip-named");
  const id = enqueue(env);

  assert.equal((await acquire({ jobId: id, cap: null, excludeIds: [id], env })).job.id, id);
});

test("a job that came back pending is skipped: the same cycle runs the next one and ends already-tried", async (t) => {
  const env = makeRunnerHome(t, "claim-skip-cycle", [COMES_BACK_PENDING, { tail: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const [back, fresh] = [enqueue(env), enqueue(env)];

  const cycle = await runCycle({ env, deps: cycleDeps() });

  assert.deepEqual(
    cycle.processed.map(({ id, status }) => ({ id, status })),
    [
      { id: back, status: "rate-limited" },
      { id: fresh, status: "done" },
    ],
  );
  assert.equal(cycle.reason, "already-tried");
  assert.equal(attemptRows(env, back), 1, "a skip opened an attempt row for the job that came back");
  assert.equal(attemptRows(env, fresh), 1);
  assert.equal(getJob(back, env).status, "pending");
  assert.equal(getJob(back, env).worker, null);
  assert.equal(getJob(fresh, env).pr_url, PR_URL);
});

for (const maxConcurrent of [null, 1]) {
  test(`a drain with only already-tried jobs left stops instead of running them again (cap ${maxConcurrent ?? "none"})`, async (t) => {
    const env = makeRunnerHome(t, `claim-skip-drain-${maxConcurrent ?? "none"}`, [COMES_BACK_PENDING]);
    if (maxConcurrent !== null) saveConfig({ ...loadConfig(env, { warn: () => {} }), queue: { maxConcurrent } }, env);
    const id = enqueue(env);

    const passes = await runDrain({ env, deps: cycleDeps() });

    assert.deepEqual(passes.map((pass) => pass.reason), ["already-tried"]);
    assert.equal(attemptRows(env, id), 1, "the drain ran the job twice");
    assert.equal(getJob(id, env).status, "pending");
  });
}
