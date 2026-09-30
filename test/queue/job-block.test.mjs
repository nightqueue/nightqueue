import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, getJob, retryJob } from "../../src/memory/jobs.mjs";
import { queueRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { diskJobRun, resolveJobRun } from "../../src/queue/job-run.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { recordJobBlock, recordOutcome, recordPhaseDone, recordRunFields, RUNTIME_ONLY_KEYS } from "../../src/queue/run-state.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, gateStream, PR_URL, resultEvent, SLUG, slugTypeEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { makeSickHome } from "../../test-support/sick-home.mjs";

const WRITER = fileURLToPath(new URL("../../test-support/job-block-writer.mjs", import.meta.url));

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// A home with project `alpha` and the fake `claude`, whose every call records what the run's state.json held when it started.
function makeBlockHome(t, name, attempts) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const statePath = join(runDir(ensureProject(env, "alpha"), SLUG, env), "state.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  writeFileSync(planPath, JSON.stringify({ ...plan, probeReadPath: statePath }));
  return { env, planPath, statePath };
}

// Runs one cycle over a single job with the git reads and the worktree injected.
function runJobCycle(env, jobId) {
  return runCycle({ jobId, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });
}

// The state.json of a run as JSON.
function stateAt(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Runs the job-block writer in a child process, started at once and answered once it exits.
function childWrite(env, args) {
  const child = spawn(process.execPath, [WRITER, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`writer exited ${code}: ${stderr}`))));
  });
}

test("the runner writes the job block of a free-prompt job before the spawn, with every field", async (t) => {
  const { env, planPath, statePath } = makeBlockHome(t, "job-block-free", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;

  await runJobCycle(env, id);

  const seen = JSON.parse(fakeCalls(planPath)[0].probedText ?? "null");
  assert.ok(seen?.job, "the session started before the runtime wrote the job block");
  assert.deepEqual(Object.keys(seen.job).sort(), ["createdAt", "decisionRefs", "id", "itemRef", "projectKey", "ref"]);
  assert.deepEqual({ ...seen.job, createdAt: null }, { id, ref: `J-${id}`, projectKey: "AP", itemRef: null, decisionRefs: [], createdAt: null });
  assert.ok(!Number.isNaN(Date.parse(seen.job.createdAt)), seen.job.createdAt);
  assert.deepEqual(stateAt(statePath).job, seen.job, "the block changed after the spawn");
});

test("the job block of a roadmap job carries the item ref and the decision the item links", async (t) => {
  const { env } = makeBlockHome(t, "job-block-roadmap", [{ stdout: toNdjson([systemInitEvent(), resultEvent({ text: `Done. Pull request: ${PR_URL}` })]), exitCode: 0 }]);
  const projectId = projectIdOf(env, "alpha");
  const decision = saveDecision({ projectId, title: "one queue", context: "c", decision: "d", consequences: "q" }, env);
  const item = saveRoadmapItem({ type: "feature", projectId, title: "fix the worker", decision_id: decision.id }, env);
  const { job } = await queueRoadmapItem({ id: item.id }, env);
  assert.equal(getJob(job.id, env).slug ?? null, null, "setup: the job should start without a slug");

  await runJobCycle(env, job.id);

  const block = stateAt(join(runDir(projectId, getJob(job.id, env).slug, env), "state.json")).job;
  assert.equal(block?.id, job.id, readFileSync(jobLogPath(job.id, env), "utf8"));
  assert.equal(block.itemRef, item.ref);
  assert.deepEqual(block.decisionRefs, [decision.ref]);
});

test("a second attempt of the same job keeps the job block and the createdAt of the first", async (t) => {
  const { env, statePath } = makeBlockHome(t, "job-block-retry", [
    { stdout: gateStream(), exitCode: 0 },
    { stdout: doneStream(), exitCode: 0 },
  ]);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  await runJobCycle(env, id);
  const first = stateAt(statePath).job;
  assert.equal(getJob(id, env).status, "gate", "setup: the first attempt should stop at a gate");

  retryJob(id, { note: "keep the column" }, env);
  await runJobCycle(env, id);

  assert.equal(getJob(id, env).slug, SLUG, "setup: the retry should reuse the run directory");
  assert.deepEqual(stateAt(statePath).job, first);
});

test("a re-declared SLUG moves the run directory and its job block with it", async (t) => {
  const stdout = toNdjson([systemInitEvent(), slugTypeEvent("the-real-name", "bug/error"), resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
  const { env } = makeBlockHome(t, "job-block-rename", [{ stdout, exitCode: 0 }]);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker", slug: SLUG }, env).id;

  await runJobCycle(env, id);

  assert.equal(getJob(id, env).slug, "the-real-name");
  const moved = stateAt(join(runDir(ensureProject(env, "alpha"), "the-real-name", env), "state.json"));
  assert.equal(moved.job.id, id);
  assert.equal(moved.type, "bug/error");
});

test("`run_set` refuses `job` and any `job.*` name, and no pipeline writer ever changes the block", (t) => {
  const env = makeHome(t, "job-block-runtime-only");
  const projectId = ensureProject(env, "alpha");
  const block = { id: 7, ref: "J-7", projectKey: "AP", itemRef: "AP-3", decisionRefs: ["D-1"], createdAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(recordJobBlock({ projectId, slug: SLUG, block, env }).status, "written");
  assert.deepEqual(RUNTIME_ONLY_KEYS, ["job"]);

  for (const name of ["job", "job.id", "job.itemRef"]) {
    const refused = recordRunFields({ projectId, slug: SLUG, fields: { [name]: "x" }, env });
    assert.deepEqual(refused, { status: "kept", path: null, reason: "`job` is written by the runtime only" }, name);
  }
  assert.equal(recordPhaseDone({ projectId, slug: SLUG, phase: "triage", env }).status, "written");
  assert.equal(recordOutcome({ projectId, slug: SLUG, status: "done", env }).status, "written");
  assert.equal(recordRunFields({ projectId, slug: SLUG, fields: { type: "bug/error" }, env }).status, "written");

  const state = stateAt(join(runDir(projectId, SLUG, env), "state.json"));
  assert.deepEqual(state.job, block);
  assert.equal(state.phases.length, 1);
});

test("the block is written once: the same job keeps it, another job is refused", (t) => {
  const env = makeHome(t, "job-block-once");
  const projectId = ensureProject(env, "alpha");
  const block = { id: 4, createdAt: "2026-01-01T00:00:00.000Z" };
  assert.equal(recordJobBlock({ projectId, slug: SLUG, block, env }).status, "written");
  assert.deepEqual(recordJobBlock({ projectId, slug: SLUG, block: { ...block, createdAt: "2026-02-02T00:00:00.000Z" }, env }), {
    status: "kept",
    path: null,
    reason: "already recorded",
  });
  assert.equal(recordJobBlock({ projectId, slug: SLUG, block: { id: 5, createdAt: block.createdAt }, env }).reason, "the run directory belongs to J-4");
  assert.equal(recordJobBlock({ projectId, slug: SLUG, block: { id: 0, createdAt: block.createdAt }, env }).status, "kept");
  assert.equal(stateAt(join(runDir(projectId, SLUG, env), "state.json")).job.createdAt, block.createdAt);
});

test("block writes fired concurrently from four processes and this one leave exactly one block", async (t) => {
  const env = makeHome(t, "job-block-concurrent");
  const projectId = ensureProject(env, "alpha");
  const children = [1, 2, 3, 4].map((n) => childWrite(env, ["block", projectId, SLUG, "9", `2026-01-0${n}T00:00:00.000Z`]));
  const own = recordJobBlock({ projectId, slug: SLUG, block: { id: 9, createdAt: "2026-01-09T00:00:00.000Z" }, env });

  const results = [own, ...(await Promise.all(children))];

  assert.equal(results.filter((result) => result.status === "written").length, 1, JSON.stringify(results));
  assert.ok(results.every((result) => result.status === "written" || result.reason === "already recorded"), JSON.stringify(results));
  const block = stateAt(join(runDir(projectId, SLUG, env), "state.json")).job;
  assert.equal(block.id, 9);
});

test("two concurrent `run_set` writes and one job block write lose no field", async (t) => {
  const env = makeHome(t, "job-block-concurrent-fields");
  const projectId = ensureProject(env, "alpha");

  const results = await Promise.all([
    childWrite(env, ["set", projectId, SLUG, "type", "bug/error"]),
    childWrite(env, ["set", projectId, SLUG, "tier", "complex"]),
    childWrite(env, ["block", projectId, SLUG, "11", "2026-01-01T00:00:00.000Z"]),
  ]);

  assert.deepEqual(results.map((result) => result.status), ["written", "written", "written"]);
  const state = stateAt(join(runDir(projectId, SLUG, env), "state.json"));
  assert.equal(state.type, "bug/error");
  assert.equal(state.tier, "complex");
  assert.equal(state.job.id, 11);
});

test("the run of a job resolves from its row while the database answers, and from its newest job block on disk when it does not", async (t) => {
  const env = makeHome(t, "job-block-resolve");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", slug: "the-retry" }, env).id;
  const createdAt = "2026-01-01T00:00:00.000Z";
  assert.equal(recordJobBlock({ projectId, slug: "the-first", block: { id, projectKey: "AP", createdAt }, env }).status, "written");
  await new Promise((done) => setTimeout(done, 10));
  assert.equal(recordJobBlock({ projectId, slug: "the-retry", block: { id, projectKey: "AP", createdAt }, env }).status, "written");
  assert.equal(recordJobBlock({ projectId, slug: "another-job", block: { id: id + 1, createdAt }, env }).status, "written");

  assert.deepEqual(await resolveJobRun(id, env), { project: "alpha", projectId, slug: "the-retry", source: "db" });
  const sick = makeSickHome(env);
  t.after(() => sick.restore());
  assert.deepEqual(await resolveJobRun(id, env), { project: "AP", projectId, slug: "the-retry", source: "disk" });
  assert.equal(diskJobRun(id + 7, env), null);
  await assert.rejects(resolveJobRun(id + 7, env), { name: "StoreUnavailableError", code: "SQLITE_NOTADB" });
});
