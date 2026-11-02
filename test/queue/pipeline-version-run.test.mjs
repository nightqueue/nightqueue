import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { installedPipelineVersion, pipelineVersionBlock } from "../../src/queue/pipeline-version.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordPipeline, recordRunFields } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { argValue, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const SLUG = "fix-the-worker";
const PHASES = ["triage", "explore", "architecture", "implementation"];
const OLD = { name: "resolve", version: "0.6.0" };
const REFUSAL = "this run started under resolve@0.6.0; retry with --fresh to start it over under @0.7.0";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit({ args }) {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  if (!(args[0] in answers)) throw new Error(`git ${args[0]} failed`);
  return `${answers[args[0]]}\n`;
}

// Runs one cycle over the job with the git reads and the worktree faked.
function cycle(env, id) {
  return runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit } });
}

// A plugin directory whose manifest declares the version, handed through the same variable the runner sets.
function withPlugin(t, env, name, version) {
  const dir = makeDir(t, `${name}-plugin`);
  mkdirSync(join(dir, ".claude-plugin"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "nightqueue", version }));
  return { ...env, NIGHTQUEUE_PLUGIN_DIR: dir };
}

// The phase entries of a run that got as far as the implementation.
function phaseEntries() {
  return PHASES.map((phase, at) => ({ phase, artifact: `0${at + 1}-${phase}.md`, verdict: "ok", at: `2026-01-0${at + 1}T00:00:00Z` }));
}

// The incident state: a queued job whose resumable run recorded the pipeline given; with `orphan`, left `running` by a dead runner instead.
function incident(t, name, { pipeline = OLD, phases = phaseEntries(), orphan = false } = {}) {
  const env = withPlugin(t, makeHome(t, name), name, "0.7.0");
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), [{ stdout: doneStream(), exitCode: 0 }]);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  const held = { schemaVersion: 1, slug: SLUG, project: "alpha", phases };
  writeFileSync(join(dir, "state.json"), JSON.stringify(pipeline === null ? held : { ...held, pipeline }));
  const db = openDb(env);
  db.prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  if (orphan) {
    assert.ok(claimJobById(id, { worker: "elsewhere:1", cap: null }, env), "the incident claim failed");
    db.prepare("UPDATE jobs SET lease_until = datetime('now', '-3600 seconds') WHERE id = ?").run(id);
  }
  return { env, id, dir, planPath, projectId };
}

// Every file of a directory with its bytes, to prove nothing in it changed.
function snapshot(dir) {
  return Object.fromEntries(readdirSync(dir).sort().map((file) => [file, readFileSync(join(dir, file), "utf8")]));
}

// Runs `run start` on the run through the real CLI, answering its exit code and what it printed.
async function runStart(env) {
  const out = [];
  const err = [];
  const io = { env, cwd: process.cwd(), out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } };
  const code = await run(["run", "start", "--project", "alpha", "--slug", SLUG], io).catch((error) => {
    err.push(error.message);
    return 1;
  });
  return { code, out, err };
}

test("a queued job started under another pipeline version is gated without a spawn, and only a fresh retry starts it over", async (t) => {
  const { env, id, dir, planPath } = incident(t, "pipeline-version-gate");
  const before = snapshot(dir);
  const report = await cycle(env, id);
  assert.deepEqual(report.processed, [{ id, status: "gated", code: "pipeline-version-changed" }]);
  const gated = getJob(id, env);
  assert.deepEqual({ status: gated.status, code: gated.blocked_code }, { status: "gate", code: "pipeline-version-changed" });
  assert.ok(gated.notice_md.startsWith(`pipeline-version-changed: ${REFUSAL}`), gated.notice_md);
  assert.match(gated.notice_md, /Start it over: nightqueue queue retry J-\d+ --fresh/);
  assert.doesNotMatch(gated.notice_md, /\(no note needed\)/);
  assert.equal(fakeCalls(planPath).length, 0, "the runner spawned a run of another pipeline version");
  assert.deepEqual(snapshot(dir), before);

  await assert.rejects(applyRetry({ id, env }), { name: "UserError", message: REFUSAL });
  assert.deepEqual(getJob(id, env), gated);
  const fresh = await applyRetry({ id, fresh: true, env });
  assert.equal(fresh.job.status, "pending");
  assert.equal(existsSync(dir), false);
  await cycle(env, id);
  assert.equal(fakeCalls(planPath).length, 1, "the fresh retry never reached the agent");
});

test("a queued job started under the installed version resumes as before", async (t) => {
  const { env, id, planPath } = incident(t, "pipeline-version-same", { pipeline: { name: "resolve", version: "0.7.0" } });
  await cycle(env, id);
  assert.equal(fakeCalls(planPath).length, 1);
  assert.match(argValue(fakeCalls(planPath)[0].argv, "-p"), /RUN FACTS/);
  assert.notEqual(getJob(id, env).blocked_code, "pipeline-version-changed");
});

test("a swept orphan started under another pipeline version ends failed, never requeued, and spawns nothing", async (t) => {
  const { env, id, dir, planPath } = incident(t, "pipeline-version-orphan", { orphan: true });
  const before = snapshot(dir);
  await cycle(env, id);
  const swept = getJob(id, env);
  assert.equal(swept.status, "failed");
  assert.equal(fakeCalls(planPath).length, 0, "a swept orphan was spawned");
  assert.deepEqual(snapshot(dir), before);
  await assert.rejects(applyRetry({ id, env }), { name: "UserError", message: REFUSAL });
});

test("a state with no pipeline is never gated, even with the artifacts of an old numbering in its directory", async (t) => {
  const { env, id, dir, planPath } = incident(t, "pipeline-version-absent", { pipeline: null });
  writeFileSync(join(dir, "06-runtime.md"), "## Round 1\n");
  writeFileSync(join(dir, "05a-qa-analyst.md"), "## Round 1\n");
  await cycle(env, id);
  assert.equal(fakeCalls(planPath).length, 1);
  assert.notEqual(getJob(id, env).blocked_code, "pipeline-version-changed");
});

test("`run start` under another pipeline version refuses with one line and writes nothing", async (t) => {
  const { env, dir } = incident(t, "pipeline-version-start");
  const before = snapshot(dir);
  const { code, out, err } = await runStart(env);
  assert.equal(code, 1);
  assert.deepEqual(err, [`nightqueue: ${REFUSAL}`]);
  assert.deepEqual(out, []);
  assert.deepEqual(snapshot(dir), before);
});

test("`run start` records the pipeline on a new run", async (t) => {
  const { env, projectId } = incident(t, "pipeline-version-record", { pipeline: null, phases: [] });
  const { code } = await runStart(env);
  assert.equal(code, 0);
  assert.deepEqual(readRunState({ projectId, slug: SLUG, env }).pipeline, { name: "resolve", version: "0.7.0" });
});

test("re-running `run start` never overwrites the version a run with phases started under", async (t) => {
  const { env, projectId } = incident(t, "pipeline-version-keep", { pipeline: { name: "resolve", version: "0.7.0" } });
  assert.equal((await runStart(env)).code, 0);
  const upgraded = withPlugin(t, env, "pipeline-version-keep-next", "0.8.0");
  assert.equal((await runStart(upgraded)).code, 1);
  assert.deepEqual(readRunState({ projectId, slug: SLUG, env }).pipeline, { name: "resolve", version: "0.7.0" });
});

test("`run start` on a run with no phase yet records the installed version over an older one", async (t) => {
  const { env, projectId } = incident(t, "pipeline-version-unpinned", { phases: [] });
  assert.equal((await runStart(env)).code, 0);
  assert.equal(readRunState({ projectId, slug: SLUG, env }).pipeline.version, "0.7.0");
});

test("a manifest that cannot be read records nothing on a run with no pin, says so and blocks nothing", async (t) => {
  const { env, projectId } = incident(t, "pipeline-version-no-manifest", { pipeline: null, phases: [] });
  const broken = { ...env, NIGHTQUEUE_PLUGIN_DIR: makeDir(t, "pipeline-version-empty-plugin") };
  assert.equal(installedPipelineVersion(broken), null);
  const { code, err } = await runStart(broken);
  assert.equal(code, 0);
  assert.ok(err.some((line) => line.includes("the pipeline version was not recorded")), err.join("\n"));
  assert.equal(readRunState({ projectId, slug: SLUG, env }).pipeline, undefined);
  assert.equal(pipelineVersionBlock({ phases: phaseEntries() }, broken), null);
});

// The environment with a plugin whose manifest is cut off mid-write, as during an upgrade.
function truncatedPlugin(t, env, name) {
  const dir = makeDir(t, `${name}-plugin`);
  mkdirSync(join(dir, ".claude-plugin"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), '{"name":"nightqueue","version":"0.7');
  return { ...env, NIGHTQUEUE_PLUGIN_DIR: dir };
}

test("a pinned run under a truncated manifest is gated with no spawn under its own code, and a plain retry resumes once it is repaired", async (t) => {
  const { env, id, dir, planPath } = incident(t, "pipeline-unknown-gate", { pipeline: { name: "resolve", version: "0.7.0" } });
  const broken = truncatedPlugin(t, env, "pipeline-unknown-gate-broken");
  const before = snapshot(dir);

  const report = await cycle(broken, id);

  assert.deepEqual(report.processed, [{ id, status: "gated", code: "pipeline-version-unknown" }]);
  assert.equal(fakeCalls(planPath).length, 0, "a run was spawned under a pipeline nobody could read");
  assert.deepEqual(snapshot(dir), before);
  const gated = getJob(id, env);
  assert.equal(gated.blocked_code, "pipeline-version-unknown");
  assert.match(gated.notice_md, /this run started under resolve@0\.7\.0 and the installed pipeline version cannot be read from .*plugin\.json; repair the plugin, then retry/);
  assert.match(gated.notice_md, /Fix the cause, then send it back/);
  assert.doesNotMatch(gated.notice_md, /--fresh/);

  await assert.rejects(applyRetry({ id, env: broken }), { name: "UserError", message: /cannot be read from/ });
  assert.deepEqual(getJob(id, env), gated);

  assert.equal((await applyRetry({ id, env })).job.status, "pending");
  await cycle(env, id);
  assert.equal(fakeCalls(planPath).length, 1, "the repaired run never resumed");
  assert.equal(readRunState({ projectId: gated.project_id, slug: SLUG, env }).pipeline.version, "0.7.0");
});

test("a pinned run under a missing manifest refuses `run start`, its state bytes unchanged", async (t) => {
  const { env, dir } = incident(t, "pipeline-unknown-start");
  const missing = { ...env, NIGHTQUEUE_PLUGIN_DIR: makeDir(t, "pipeline-unknown-start-empty") };
  const before = snapshot(dir);

  const { code, err } = await runStart(missing);

  assert.equal(code, 1);
  assert.match(err.join("\n"), /cannot be read from/);
  assert.deepEqual(snapshot(dir), before);
});

test("the unknown-version block names its code and offers no fresh retry, while a known change does", (t) => {
  const state = { pipeline: OLD, phases: phaseEntries() };
  const unknown = pipelineVersionBlock(state, truncatedPlugin(t, {}, "pipeline-unknown-shape"));
  assert.equal(unknown.code, "pipeline-version-unknown");
  assert.equal(unknown.fresh, undefined);
  const changed = pipelineVersionBlock(state, withPlugin(t, {}, "pipeline-changed-shape", "0.7.0"));
  assert.equal(changed.code, "pipeline-version-changed");
  assert.equal(changed.fresh, true);
});

test("a version with no plugin variable is read from the package's own plugin", () => {
  const { version } = JSON.parse(readFileSync(new URL("../../plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(installedPipelineVersion({}), version);
  assert.equal(installedPipelineVersion({ NIGHTQUEUE_PLUGIN_DIR: "   " }), version);
});

test("only a recorded text version over recorded phases can block", (t) => {
  const env = withPlugin(t, {}, "pipeline-version-shapes", "0.7.0");
  const phases = phaseEntries();
  for (const state of [
    null,
    "not a state",
    {},
    { phases },
    { pipeline: OLD },
    { pipeline: OLD, phases: [] },
    { pipeline: OLD, phases: "many" },
    { pipeline: "0.6.0", phases },
    { pipeline: { version: 6 }, phases },
    { pipeline: { version: "  " }, phases },
    { pipeline: { name: "resolve", version: "0.7.0" }, phases },
  ]) {
    assert.equal(pipelineVersionBlock(state, env), null, JSON.stringify(state));
  }
  assert.equal(pipelineVersionBlock({ pipeline: { version: "0.6.0" }, phases }, env).message, REFUSAL);
});

test("`run start` never stamps a version on a run with phases and none recorded, not even with the artifacts of an old numbering, so a later version does not gate it", async (t) => {
  const { env, dir, projectId } = incident(t, "pipeline-version-no-stamp", { pipeline: null });
  writeFileSync(join(dir, "06-runtime.md"), "## Round 1\n");
  writeFileSync(join(dir, "05a-qa-analyst.md"), "## Round 1\n");
  assert.equal((await runStart(env)).code, 0);
  assert.equal(readRunState({ projectId, slug: SLUG, env }).pipeline, undefined);
  const upgraded = withPlugin(t, env, "pipeline-version-no-stamp-next", "0.8.0");
  assert.equal((await runStart(upgraded)).code, 0);
  assert.equal(readRunState({ projectId, slug: SLUG, env }).pipeline, undefined);
});

test("`run_set` refuses the record whole or dotted, a kept field leaves it, and the runtime's writer refuses an unsafe path", (t) => {
  const { env, projectId } = incident(t, "pipeline-version-writers");
  for (const name of ["pipeline", "pipeline.version"]) {
    const refused = recordRunFields({ projectId, slug: SLUG, fields: { [name]: "9.9.9" }, env });
    assert.deepEqual(refused, { status: "kept", path: null, reason: "`pipeline` is written by the runtime only" }, name);
  }
  recordRunFields({ projectId, slug: SLUG, fields: { type: "bug/error" }, env });
  assert.deepEqual(readRunState({ projectId, slug: SLUG, env }).pipeline, OLD);
  const refused = recordPipeline({ projectId, slug: "../up", pipeline: OLD, env });
  assert.deepEqual(refused, { status: "kept", path: null, reason: "unsafe project or slug" });
  assert.equal(recordPipeline({ projectId, slug: SLUG, pipeline: { name: "resolve", version: "9.9.9" }, env }).status, "unchanged");
});
