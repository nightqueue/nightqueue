import assert from "node:assert/strict";
import { test } from "node:test";
import { DB_USER_VERSION } from "../../src/memory/schema.mjs";
import { createLocalStore } from "../../src/store/local.mjs";
import { STORE_CONTRACT } from "../../src/store/store.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

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

  const job = await store.jobs.addJob({ projectId: projectIdOf(env, "alpha"), prompt: "do the thing" });
  assert.equal((await store.jobs.getJob(job.id)).project, "alpha");
  assert.equal(await store.jobs.status(job.id), "pending");

  const alphaId = projectIdOf(env, "alpha");
  const run = await store.runs.logPipelineRun({ projectId: alphaId, slug: "fix-it", tier: "simple", outcome: "pr_opened" });
  assert.ok(Number.isInteger(run.runId), "a logged pipeline run answers with its id");

  await store.lessons.saveLesson({
    projectId: alphaId,
    title: "the lease is renewed before it expires",
    root_cause: "the interval was longer than the lease",
    solution: "renew at half the lease",
    prevention: "keep the heartbeat under the lease",
  });
  const stats = await store.lessons.memoryStats();
  assert.equal(stats.find((row) => row.project === "alpha")?.lessons, 1);

  await store.memory.saveMemory({ projectId: alphaId, key: "runtime", value: "node 22" });
  assert.equal((await store.memory.recentMemories({ projectId: alphaId })).length, 1);

  const indexed = await store.index.saveProjectIndex({
    projectId: alphaId,
    files: [{ path: "src/a.mjs", responsibility: "claims the next job" }],
  });
  assert.equal(indexed.files, 1);
  assert.equal((await store.index.recallProjectIndex({ projectId: alphaId })).files.length, 1);

  await store.decisions.saveDecision({
    projectId: projectIdOf(env, "alpha"),
    title: "the store is the only path to sqlite",
    context: "the sql was spread across the cli",
    decision: "every call goes through the store",
  });
  assert.equal((await store.decisions.listDecisions({ projectId: projectIdOf(env, "alpha") })).length, 1);

  assert.equal(Object.hasOwn(store, "issues"), false, "the store still carries an issues domain");

  const acme = await store.orgs.add("acme");
  assert.equal((await store.orgs.byName("acme")).id, acme.id);
  assert.equal((await store.projects.byName("alpha")).org, "default");
  await store.orgs.remove(acme.id);
  assert.equal(await store.orgs.byId(acme.id), null);
});

test("listWithSlug answers the jobs a witness could speak for", async (t) => {
  const env = makeHome(t, "store-with-slug");
  makeProject(t, env, "alpha");
  const store = createLocalStore(env);

  const withoutSlug = await store.jobs.addJob({ projectId: projectIdOf(env, "alpha"), prompt: "never ran" });
  const job = await store.jobs.addJob({ projectId: projectIdOf(env, "alpha"), prompt: "ran once" });
  await store.jobs.claimJobById(job.id, { worker: "w1", cap: 2 });
  await store.jobs.persistRunFacts(job.id, { worker: "w1", slug: "fix-it" });

  const listed = await store.jobs.listWithSlug();
  assert.deepEqual(
    listed.map((row) => row.id),
    [job.id],
    `the job \`${withoutSlug.id}\` has no slug, so no witness can speak for it`,
  );
});

// A store on a fresh home with one project and one job of it.
async function storeWithJob(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const store = createLocalStore(env);
  const job = await store.jobs.addJob({ projectId: projectIdOf(env, "alpha"), prompt: "deliver the thing" });
  return { store, job };
}

test("a write another worker owns reports false and moves nothing", async (t) => {
  const { store, job } = await storeWithJob(t, "store-close-refused");
  await store.jobs.claimJobById(job.id, { worker: WORKER, cap: 4 });

  assert.equal(await store.jobs.finishJob(job.id, { worker: "host:9999", status: "done", prUrl: PR_URL }), false);
  assert.equal((await store.jobs.getJob(job.id)).status, "running");
});

test("jobSpawnRefs answers the project key of a job, and refuses an unknown job", async (t) => {
  const { store, job } = await storeWithJob(t, "store-spawn-refs");
  assert.deepEqual(await store.jobs.jobSpawnRefs(job.id), { projectKey: "AP" });
  await assert.rejects(store.jobs.jobSpawnRefs(4242), /unknown job `4242`/);
});

test("health answers the raw numbers of a diagnosis, never an exception", async (t) => {
  const env = makeHome(t, "store-health");
  const store = createLocalStore(env);
  await store.connect();

  assert.deepEqual(await store.health(), {
    schemaVersion: DB_USER_VERSION,
    orphanJobs: 0,
    danglingReferences: 0,
    errors: { schemaVersion: null, orphanJobs: null, danglingReferences: null },
    unavailable: null,
  });
});
