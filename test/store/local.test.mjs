import assert from "node:assert/strict";
import { test } from "node:test";
import { DB_USER_VERSION } from "../../src/memory/schema.mjs";
import { createLocalStore } from "../../src/store/local.mjs";
import { STORE_CONTRACT } from "../../src/store/store.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:1000";
const PR_URL = "https://github.com/acme/api/pull/7";

// Every method of the contract as `domain.method`, or the bare name of a top-level one.
function contractMethods() {
  return Object.entries(STORE_CONTRACT).flatMap(([domain, methods]) =>
    methods.map((method) => (domain ? `${domain}.${method}` : method)),
  );
}

// Every method a store really exposes, in the same `domain.method` shape.
function storeMethods(store) {
  return Object.entries(store).flatMap(([key, value]) =>
    typeof value === "function" ? [key] : Object.keys(value).map((method) => `${key}.${method}`),
  );
}

// The method of a store by its contract name.
function methodOf(store, name) {
  const [domain, method] = name.split(".");
  return method ? store[domain]?.[method] : store[domain];
}

test("the local store exposes exactly the methods of the contract", (t) => {
  const env = makeHome(t, "store-contract");
  const store = createLocalStore(env);

  assert.deepEqual(storeMethods(store).sort(), contractMethods().sort());
});

test("every method of the contract is a function that returns a promise", async (t) => {
  const env = makeHome(t, "store-promises");
  const store = createLocalStore(env);

  for (const name of contractMethods()) {
    const method = methodOf(store, name);
    assert.equal(typeof method, "function", `\`${name}\` is missing from the local store`);
    const returned = method();
    assert.ok(returned instanceof Promise, `\`${name}\` must return a promise`);
    await returned.catch(() => null);
  }
});

test("every domain of the store writes and reads back on a real home", async (t) => {
  const env = makeHome(t, "store-smoke");
  makeProject(t, env, "alpha");
  const store = createLocalStore(env);

  const job = await store.jobs.addJob({ project: "alpha", prompt: "do the thing" });
  assert.equal((await store.jobs.getJob(job.id)).project, "alpha");
  assert.equal(await store.jobs.status(job.id), "pending");

  const run = await store.runs.logPipelineRun({ project: "alpha", slug: "fix-it", tier: "simple", outcome: "pr_opened" });
  assert.ok(Number.isInteger(run.runId), "a logged pipeline run answers with its id");

  await store.lessons.saveLesson({
    project: "alpha",
    title: "the lease is renewed before it expires",
    root_cause: "the interval was longer than the lease",
    solution: "renew at half the lease",
    prevention: "keep the heartbeat under the lease",
  });
  const stats = await store.lessons.memoryStats();
  assert.equal(stats.find((row) => row.project === "alpha")?.lessons, 1);

  await store.memory.saveMemory({ project: "alpha", key: "runtime", value: "node 22" });
  assert.equal((await store.memory.recentMemories({ project: "alpha" })).length, 1);

  const indexed = await store.index.saveProjectIndex({
    project: "alpha",
    files: [{ path: "src/a.mjs", responsibility: "claims the next job" }],
  });
  assert.equal(indexed.files, 1);
  assert.equal((await store.index.recallProjectIndex({ project: "alpha" })).files.length, 1);

  await store.decisions.saveDecision({
    project: "alpha",
    title: "the store is the only path to sqlite",
    context: "the sql was spread across the cli",
    decision: "every call goes through the store",
  });
  assert.equal((await store.decisions.listDecisions({ project: "alpha" })).length, 1);

  await store.roadmap.saveRoadmapItem({ type: "improvement", project: "alpha", title: "close the boundary" });
  const roadmap = await store.roadmap.listRoadmap("alpha");
  assert.deepEqual(
    roadmap.items.map((item) => [item.title, item.status, item.priority]),
    [["close the boundary", "todo", 5]],
  );
  assert.deepEqual(await store.roadmap.roadmapDrift(), []);

  assert.deepEqual(await store.orgs.usage("acme"), []);
});

test("listWithSlug answers the jobs a witness could speak for", async (t) => {
  const env = makeHome(t, "store-with-slug");
  makeProject(t, env, "alpha");
  const store = createLocalStore(env);

  const withoutSlug = await store.jobs.addJob({ project: "alpha", prompt: "never ran" });
  const job = await store.jobs.addJob({ project: "alpha", prompt: "ran once" });
  await store.jobs.claimJobById(job.id, { worker: "w1", cap: 2 });
  await store.jobs.persistRunFacts(job.id, { worker: "w1", slug: "fix-it" });

  const listed = await store.jobs.listWithSlug();
  assert.deepEqual(
    listed.map((row) => row.id),
    [job.id],
    `the job \`${withoutSlug.id}\` has no slug, so no witness can speak for it`,
  );
});

// A store on a fresh home with one project and one roadmap item queued as a job of its own.
async function queuedItem(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const store = createLocalStore(env);
  const item = await store.roadmap.saveRoadmapItem({ type: "improvement", project: "alpha", title: "deliver the thing" });
  const job = await store.jobs.addJob({ project: "alpha", prompt: "deliver the thing" });
  assert.equal(await store.roadmap.linkRoadmapItemJob(item.id, job.id), true, "setup: the item was not linked to its job");
  return { store, item, job };
}

// The status the roadmap item carries right now.
async function itemStatus(store, item) {
  return (await store.roadmap.getRoadmapItem(item.id)).status;
}

test("a job the store finishes as done puts its roadmap item in review, and one that gates keeps it in progress", async (t) => {
  const gated = await queuedItem(t, "store-close-gate");
  await gated.store.jobs.claimJobById(gated.job.id, { worker: WORKER, cap: 4 });
  assert.equal(await gated.store.jobs.finishJob(gated.job.id, { worker: WORKER, status: "gate", noticeMd: "answer me" }), true);
  assert.equal(await itemStatus(gated.store, gated.item), "in_progress", "a gated job moved the item it never delivered");

  const delivered = await queuedItem(t, "store-close-finish");
  await delivered.store.jobs.claimJobById(delivered.job.id, { worker: WORKER, cap: 4 });
  assert.equal(await delivered.store.jobs.finishJob(delivered.job.id, { worker: WORKER, status: "done", prUrl: PR_URL }), true);
  assert.equal(await itemStatus(delivered.store, delivered.item), "in_review");
});

test("a re-classification into done puts the item in review, and one that stays failed keeps it at todo", async (t) => {
  const { store, item, job } = await queuedItem(t, "store-close-reclassify");
  await store.jobs.claimJobById(job.id, { worker: WORKER, cap: 4 });
  await store.jobs.finishJob(job.id, { worker: WORKER, status: "failed" });

  assert.equal(await store.jobs.reclassifyJob(job.id, { status: "failed", prUrl: PR_URL }), true);
  assert.equal(await itemStatus(store, item), "todo", "a re-classification that kept the failure moved the item");

  assert.equal(await store.jobs.reclassifyJob(job.id, { status: "done", prUrl: PR_URL }), true);
  assert.equal(await itemStatus(store, item), "in_review");
});

test("a repair from a done witness puts the item in review, and a failed witness sends it back to todo", async (t) => {
  const failed = await queuedItem(t, "store-close-witness-failed");
  await failed.store.jobs.claimJobById(failed.job.id, { worker: WORKER, cap: 4 });
  assert.equal(await failed.store.jobs.repairJobFromWitness(failed.job.id, { status: "failed", prUrl: null }), true);
  assert.equal(await itemStatus(failed.store, failed.item), "todo");

  const delivered = await queuedItem(t, "store-close-witness-done");
  await delivered.store.jobs.claimJobById(delivered.job.id, { worker: WORKER, cap: 4 });
  assert.equal(await delivered.store.jobs.repairJobFromWitness(delivered.job.id, { status: "done", prUrl: PR_URL }), true);
  assert.equal(await itemStatus(delivered.store, delivered.item), "in_review");
});

test("a write another worker owns reports false and moves nothing", async (t) => {
  const { store, item, job } = await queuedItem(t, "store-close-refused");
  await store.jobs.claimJobById(job.id, { worker: WORKER, cap: 4 });

  assert.equal(await store.jobs.finishJob(job.id, { worker: "host:9999", status: "done", prUrl: PR_URL }), false);
  assert.equal(await itemStatus(store, item), "in_progress", "the item of a job another worker owns was moved by a refused write");
  assert.equal((await store.jobs.getJob(job.id)).status, "running");
});

test("followJob answers 0 for an unknown job, refuses a malformed id, and is idempotent", async (t) => {
  const { store, item, job } = await queuedItem(t, "store-follow-job");

  assert.equal(await store.roadmap.followJob(4242), 0);
  await assert.rejects(store.roadmap.followJob("not an id"), /positive integer roadmap item id/);
  assert.equal(await itemStatus(store, item), "in_progress");

  await store.jobs.cancelJob(job.id, { reason: "not now" });
  assert.equal(await itemStatus(store, item), "todo");
  assert.equal(await store.roadmap.followJob(job.id), 0, "a second follow moved the item again");
});

test("health answers the raw numbers of a diagnosis, never an exception", async (t) => {
  const env = makeHome(t, "store-health");
  const store = createLocalStore(env);

  assert.deepEqual(await store.health(), {
    schemaVersion: DB_USER_VERSION,
    orphanJobs: 0,
    errors: { schemaVersion: null, orphanJobs: null },
  });
});
