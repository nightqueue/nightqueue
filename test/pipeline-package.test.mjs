import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { reportFacts } from "../src/cli/report-facts.mjs";
import { run } from "../src/cli/index.mjs";
import { runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { refuseInvalidAnswer } from "../src/queue/pipeline-answer.mjs";
import { agentRoles, deliveryPhaseOf, gateStopOf, gateStopsOf, installedPipelineNames, lessonRoles, lessonRolesOf, loadPipeline, loadReport, phaseIdsOf, phaseNamesOf, phasesBeforeDeliveryOf, pipelineManifest, reportLayoutOf, requireRole, rolesOf } from "../src/queue/pipeline-package.mjs";
import { derivedGateStop, derivedOutcome } from "../src/queue/pipeline-record.mjs";
import { pipelineGateStops } from "../src/memory/runs.mjs";
import { defaultAgentModels, trackSlots } from "../src/queue/routing.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { recordPhaseDone, recordRunFields, recordRuntimeField, terminationRefusal } from "../src/queue/run-state.mjs";
import { jobExtras } from "../src/studio/job-extras.mjs";
import { ensureProject, makeHome, makeProject } from "../test-support/memory.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = join(ROOT, "bin", "nightqueue.mjs");
const PACKAGE_DIR = join(ROOT, "plugin", "skills", "resolve", "pipeline");
const SLUG = "package-run";
const ACCEPTANCE_RE = /"(triage|explore|architecture|implementation|qa|verification|runtime|commit)"|0[1-7]-[a-z-]+\.md/;
const IMPORT_ALLOW_LIST = ["config/errors", "config/store", "host/paths", "memory/runs", "queue/branch-name", "queue/file-list", "queue/orchestrator-scope", "queue/pipeline-answer", "queue/pipeline-record", "queue/resume", "queue/rounds", "queue/question-text", "queue/stream"];

// A job bound to the run slug, with the run directory ready and these files in it.
function seedRun(t, name, files = {}) {
  const env = makeHome(t, `package-${name}`);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "move the pipeline" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, projectId, dir, id };
}

// Runs `run check` in this process, with an optional package in place of the real one.
async function runCheck(env, check, { loadPipeline: load } = {}) {
  const out = [];
  const err = [];
  const code = await run(["run", "check", check], { env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} }, ...(load ? { loadPipeline: load } : {}) });
  return { code, out, err: err.join("\n") };
}

// Every file of a directory with its bytes, which a refused answer must leave as they were.
function dirBytes(dir) {
  return Object.fromEntries(readdirSync(dir).map((file) => [file, readFileSync(join(dir, file), "utf8")]));
}

// A well-formed answer of a package, with these parts replaced.
function answerWith(parts = {}) {
  return { lines: ["OK"], script: [], record: null, memo: { key: "02", line: "OK", ok: true, completed: true, digest: "d" }, effects: [], next: "report", ...parts };
}

// A package with the real manifest whose `check` answers exactly this.
function fakePackage(answer) {
  return async () => ({ manifest: pipelineManifest(), check: () => answer });
}

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

test("the acceptance grep finds nothing in the runtime files that must not name a phase, and the moved modules are gone", () => {
  for (const file of ["src/cli/check-effects.mjs", "src/queue/routing.mjs", "src/queue/run-state.mjs"]) {
    const match = ACCEPTANCE_RE.exec(readFileSync(join(ROOT, file), "utf8"));
    assert.equal(match, null, `${file} names ${match?.[0]}`);
  }
  for (const gone of ["check-contract", "phase-artifacts", "qa-rounds", "triage-brief", "gate-question"]) {
    assert.equal(existsSync(join(ROOT, "src", "queue", `${gone}.mjs`)), false, gone);
  }
  assert.equal(existsSync(join(ROOT, "src", "cli", "qa-skip-tests.mjs")), false);
});

test("the manifest pins the plugin's version and the phases and models the runtime held", () => {
  const manifest = pipelineManifest();
  assert.equal(manifest.name, "resolve");
  assert.equal(manifest.version, JSON.parse(readFileSync(join(ROOT, "plugin", ".claude-plugin", "plugin.json"), "utf8")).version);
  assert.deepEqual(phaseIdsOf(manifest), ["triage", "explore", "architecture", "implementation", "qa", "verification", "runtime", "commit"]);
  assert.deepEqual(phaseNamesOf(null), phaseIdsOf(manifest));
  assert.deepEqual(defaultAgentModels(), { triager: "sonnet", explore: "haiku", architect: "opus", coder: "opus", "qa-triage": "sonnet", "qa-analyst": "sonnet", "qa-prover": "haiku", verifier: "haiku", reflector: "haiku", merger: "sonnet" });
  assert.equal(trackSlots().length, 9);
});

test("the agent roles and the lesson roles come from the manifest's agents, in order", () => {
  const manifest = pipelineManifest();
  assert.deepEqual(rolesOf(manifest), ["triager", "architect", "coder", "qa", "verifier", "explore", "reflector"]);
  assert.deepEqual(lessonRolesOf(manifest), ["triager", "architect", "coder", "qa", "verifier"]);
  assert.deepEqual(agentRoles(), rolesOf(manifest));
  assert.deepEqual(lessonRoles(), lessonRolesOf(manifest));
  assert.equal(installedPipelineNames()[0], "resolve");
  assert.throws(() => requireRole("target", "legacy-role", lessonRoles()), /unknown `target` `legacy-role`; accepted: triager, architect, coder, qa, verifier$/);
});

test("the package imports from src/ only what the allow-list names", () => {
  for (const file of readdirSync(PACKAGE_DIR).filter((name) => name.endsWith(".mjs"))) {
    const text = readFileSync(join(PACKAGE_DIR, file), "utf8");
    for (const [, target] of text.matchAll(/from "\.\.\/\.\.\/\.\.\/\.\.\/src\/([^"]+)\.mjs"/g)) {
      assert.ok(IMPORT_ALLOW_LIST.includes(target), `${file} imports ${target}, off the allow-list`);
    }
  }
});

test("the real package loads, and a pipeline with no package or a bad name is refused by name", async () => {
  const { manifest, check } = await loadPipeline("resolve");
  assert.equal(manifest.name, "resolve");
  assert.equal(typeof check, "function");
  await assert.rejects(() => loadPipeline("missing-one"), /the pipeline `missing-one` has no readable package/);
  await assert.rejects(() => loadPipeline("../escape"), /the pipeline `\.\.\/escape` is not a valid name/);
});

test("the real package's report module exposes its row rules, open items and facts, and its layout is the manifest's rows", async () => {
  const { manifest, report } = await loadReport("resolve");
  assert.equal(typeof report.rowOf, "function");
  assert.equal(typeof report.openItems, "function");
  assert.equal(typeof report.facts, "function");
  assert.deepEqual(report.FACT_FILES, ["00-brief.md", "01-triage.md", "03-plan.md", "04-implementation.md", "05-qa.md", "06-verification.md", "07-runtime.md"]);
  assert.deepEqual(reportLayoutOf(manifest).map((row) => row.phase), [...phaseIdsOf(manifest), null]);
  assert.deepEqual(reportLayoutOf({ phases: [{ id: null }, { id: "draft" }] }), [{ phase: "draft", step: "draft", agent: "-" }]);
});

test("the gate stops, the delivering phase and the phases before it come from the manifest, with the same values as before", () => {
  const manifest = pipelineManifest("resolve");
  assert.deepEqual([...pipelineGateStops()], ["critique", "triage", "architect", "qa", "verification", "runtime", "user"]);
  assert.deepEqual(manifest.phases.map((phase) => gateStopOf(manifest, phase.id)), [null, "triage", null, "architect", null, "qa", "verification", "runtime", null]);
  assert.equal(deliveryPhaseOf(manifest), "commit");
  assert.deepEqual(phasesBeforeDeliveryOf(manifest), ["verification", "runtime"]);
  const bare = { phases: [{ id: null }, { id: "draft" }] };
  assert.deepEqual([gateStopsOf(bare), gateStopOf(bare, "draft"), deliveryPhaseOf(bare), phasesBeforeDeliveryOf(bare)], [[], null, null, []]);
});

test("a second pipeline's outcome and gate stop are derived from its own manifest", () => {
  const duo = { phases: [{ id: "draft", gateStop: "drafting" }, { id: "ship", delivers: true }], gateStops: ["drafting"] };
  const shipped = { phases: [{ phase: "draft", verdict: "OK" }, { phase: "ship", verdict: "OK" }] };
  const failed = { phases: [{ phase: "draft", verdict: "FAILED" }] };
  assert.equal(derivedOutcome(shipped, duo), "local_commit");
  assert.equal(derivedOutcome(failed, duo), "no_commit");
  assert.equal(derivedGateStop(failed, "no_commit", duo), "drafting");
  assert.equal(derivedGateStop({ termination: { phase: "draft" } }, "no_commit", duo), "drafting");
  assert.equal(derivedOutcome({ phases: [{ phase: "commit", verdict: "PR opened" }] }, duo), "no_commit");
});

test("the run's outcome and gate stop are derived without throwing for a state pinning a pipeline with no readable package", () => {
  const state = { pipeline: { name: "missing-one" }, phases: [{ phase: "draft", verdict: "NEEDS-WORK" }] };

  assert.equal(derivedOutcome(state), "no_commit");
  assert.equal(derivedGateStop(state, "no_commit"), null);
  assert.equal(derivedOutcome({ ...state, outcome: { status: "done", prUrl: "https://example.test/pr/1" } }), "pr_opened");
});

test("a package with no report.mjs answers an empty report module", (t) => {
  const copy = installCopy(t);
  rmSync(join(copy, "plugin", "skills", "resolve", "pipeline", "report.mjs"));
  const script = `const { loadReport } = await import(${JSON.stringify(pathToFileURL(join(copy, "src", "queue", "pipeline-package.mjs")).href)}); const { manifest, report } = await loadReport("resolve"); console.log(JSON.stringify({ name: manifest.name, keys: Object.keys(report) }));`;

  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: makeHome(t, "package-no-report") });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { name: "resolve", keys: [] });
});

test("a job whose row names a pipeline with no package is refused by name and writes nothing", async (t) => {
  const { env, id, dir } = seedRun(t, "missing-one");
  openDb(env).prepare("UPDATE jobs SET pipeline = 'missing-one' WHERE id = ?").run(id);
  const before = dirBytes(dir);

  const { code, out, err } = await runCheck(env, "02");

  assert.equal(code, 1);
  assert.deepEqual(out, []);
  assert.match(err, /the pipeline `missing-one` has no readable package/);
  assert.deepEqual(dirBytes(dir), before);
});

const INVALID_ANSWERS = [
  ["an unknown effect", answerWith({ effects: [{ kind: "deleteRun" }] }), /unknown effect `deleteRun`/],
  ["an undeclared field", answerWith({ effects: [{ kind: "recordFields", fields: { branch: "x" } }] }), /field `branch` is not recordable/],
  ["the decisions as a field", answerWith({ effects: [{ kind: "recordFields", fields: { decisions: [] } }] }), /field `decisions` is not recordable/],
  ["a decision with no decision", answerWith({ effects: [{ kind: "recordDecision", decision: { check: "06" }, loops: {} }] }), /recordDecision has no decision/],
  ["a decision with no loops", answerWith({ effects: [{ kind: "recordDecision", decision: { check: "06", next: "report" }, loops: [1] }] }), /recordDecision has no loops/],
  ["a run file off the run directory", answerWith({ effects: [{ kind: "writeRunFile", name: "../x", text: "y", locked: true }] }), /run file `\.\.\/x` is not a bare file name/],
  ["a verdict off the manifest", answerWith({ record: { phase: "explore", artifact: "02-explore.md", verdict: "MAYBE" } }), /verdict `MAYBE` is not one the phase `explore` may record/],
  ["a phase off the manifest", answerWith({ record: { phase: "critique", verdict: "OK" } }), /record of unknown phase `critique`/],
  ["a promise", Promise.resolve(answerWith()), /answered a promise/],
  ["no lines", answerWith({ lines: [] }), /has no `lines`/],
  ["no next", answerWith({ next: undefined }), /has no one-line `next`/],
  ["a next of two lines", answerWith({ next: "report\nreport" }), /has no one-line `next`/],
  ["a next off the grammar", answerWith({ next: "rm -rf /" }), /`rm -rf \/` is off the grammar/],
  ["a next launching no target", answerWith({ next: "launch merger" }), /launches `merger`, which is not a target of the manifest/],
  ["a next checking no phase", answerWith({ next: "check 99" }), /checks `99`, which is not a check of the manifest/],
];

for (const [name, answer, line] of INVALID_ANSWERS) {
  test(`an answer with ${name} is refused with one line and an unchanged run directory`, async (t) => {
    const { env, dir } = seedRun(t, `invalid-${name.replace(/\W+/g, "-")}`, { "02-explore.md": "## File map\n" });
    const before = dirBytes(dir);

    const { code, out, err } = await runCheck(env, "02", { loadPipeline: fakePackage(answer) });

    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.match(err, /the pipeline `resolve` answered an invalid check, so nothing was written/);
    assert.match(err, line);
    assert.equal(err.includes("\n"), false, err);
    assert.deepEqual(dirBytes(dir), before);
  });
}

// The node_modules the checkout really resolves from: its own, or an ancestor's when the checkout is a worktree nested in another one.
function resolvingNodeModules(root) {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules");
    if (existsSync(join(candidate, "@modelcontextprotocol", "sdk"))) return candidate;
    if (dirname(dir) === dir) throw new Error(`no node_modules with @modelcontextprotocol/sdk above ${root}`);
  }
}

// A throwaway copy of the install, sharing the node_modules the checkout resolves from.
function installCopy(t) {
  const copy = mkdtempSync(join(tmpdir(), "nightqueue-manifest-"));
  t.after(() => rmSync(copy, { recursive: true, force: true }));
  for (const entry of ["bin", "src", "plugin", "package.json"]) cpSync(join(ROOT, entry), join(copy, entry), { recursive: true });
  symlinkSync(resolvingNodeModules(ROOT), join(copy, "node_modules"));
  return copy;
}

const INVALID_MANIFEST_LINE_RE = /^nightqueue: the pipeline `resolve` has an invalid manifest: .+ \(.*manifest\.json\)$/;

// Runs one command of an install copy's CLI.
function runCopy(copy, args, env) {
  return spawnSync(process.execPath, [join(copy, "bin", "nightqueue.mjs"), ...args], { encoding: "utf8", env });
}

// Asserts that with its manifest broken by `change`, an install's `--help`, `queue status` and `doctor` run and `run check 02` refuses with the one line.
function assertBrokenInstall(t, change, reason) {
  const copy = installCopy(t);
  change(join(copy, "plugin", "skills", "resolve", "pipeline", "manifest.json"));
  const env = makeHome(t, "package-bad-manifest");

  for (const args of [["--help"], ["queue", "status"]]) {
    const result = runCopy(copy, args, env);
    assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  }
  const doctor = runCopy(copy, ["doctor"], env);
  const row = doctor.stdout.split("\n").find((line) => /\bpipeline\b/.test(line) && /manifest\.json/.test(line));
  assert.ok(row, doctor.stdout);
  assert.match(row, /fail/);
  assert.match(row, reason);

  const check = runCopy(copy, ["run", "check", "02"], env);
  assert.equal(check.status, 1);
  assert.equal(check.stderr.trim().split("\n").length, 1, check.stderr);
  assert.match(check.stderr.trim(), INVALID_MANIFEST_LINE_RE);
  assert.match(check.stderr, reason);
}

for (const [label, reshape, reason] of [
  ["no phases", ({ phases, ...rest }) => rest, /`phases` is not a list/],
  ["no models", ({ models, ...rest }) => rest, /`models` is not an object/],
  ["a phase with no verdicts", (manifest) => ({ ...manifest, phases: [{ id: "qa", sections: [] }] }), /the phase `qa` has no `verdicts` list/],
  ["a report that is not an object", (manifest) => ({ ...manifest, report: [] }), /`report` is not an object/],
  ["report rows that are not a list", (manifest) => ({ ...manifest, report: { rows: {} } }), /`report\.rows` is not a list/],
  ["a report row of an undeclared phase", (manifest) => ({ ...manifest, report: { rows: [{ phase: "deploy", step: "9 Deploy", agent: "x" }] } }), /the `report\.rows` phase `deploy` is not a declared phase/],
  ["a report row with no step", (manifest) => ({ ...manifest, report: { rows: [{ phase: "qa", step: 5, agent: "x" }] } }), /the `report\.rows` entry of `qa` has no `step` string/],
  ["a report row with no agent", (manifest) => ({ ...manifest, report: { rows: [{ phase: null, step: "9 Report" }] } }), /the `report\.rows` entry of `null` has no `agent` string/],
  ["a track lane that is not a string", (manifest) => ({ ...manifest, track: manifest.track.map((slot) => (slot.name === "runtime" ? { ...slot, lane: 6 } : slot)) }), /the `track` slot `runtime` has a `lane` that is not a string/],
  ["a track prompt mode that is not a string", (manifest) => ({ ...manifest, track: manifest.track.map((slot) => (slot.name === "runtime" ? { ...slot, promptMode: true } : slot)) }), /the `track` slot `runtime` has a `promptMode` that is not a string/],
  ["gate stops that are not a list", (manifest) => ({ ...manifest, gateStops: "qa" }), /`gateStops` is not a list of strings/],
  ["a gate stop its list does not name", (manifest) => ({ ...manifest, phases: manifest.phases.map((phase) => (phase.id === "qa" ? { ...phase, gateStop: "deploy" } : phase)) }), /the phase `qa` has a `gateStop` `deploy` that `gateStops` does not list/],
  ["a delivers that is not a boolean", (manifest) => ({ ...manifest, phases: manifest.phases.map((phase) => (phase.id === "commit" ? { ...phase, delivers: "yes" } : phase)) }), /the phase `commit` has a `delivers` that is not a boolean/],
  ["a precedesDelivery that is not a boolean", (manifest) => ({ ...manifest, phases: manifest.phases.map((phase) => (phase.id === "runtime" ? { ...phase, precedesDelivery: 1 } : phase)) }), /the phase `runtime` has a `precedesDelivery` that is not a boolean/],
  ["two delivering phases", (manifest) => ({ ...manifest, phases: manifest.phases.map((phase) => (phase.id === "qa" ? { ...phase, delivers: true } : phase)) }), /more than one phase `delivers`/],
  ["no agents", ({ agents, ...rest }) => rest, /`agents` is not a list/],
  ["an agent role that is not a string", (manifest) => ({ ...manifest, agents: manifest.agents.map((entry) => (entry.name === "triager" ? { ...entry, role: 5 } : entry)) }), /the agent `triager` has a `role` that does not match/],
  ["an agent lessons that is not a boolean", (manifest) => ({ ...manifest, agents: manifest.agents.map((entry) => (entry.name === "triager" ? { ...entry, lessons: "yes" } : entry)) }), /the agent `triager` has a `lessons` that is not a boolean/],
  ["an agent declared twice", (manifest) => ({ ...manifest, agents: [...manifest.agents, manifest.agents[0]] }), /the agent `triager` is declared twice/],
  ["a role with and without lessons", (manifest) => ({ ...manifest, agents: manifest.agents.map((entry) => (entry.name === "qa-prover" ? { ...entry, lessons: false } : entry)) }), /the role `qa` is declared both with and without `lessons`/],
  ["a phase agent with no agents entry", (manifest) => ({ ...manifest, agents: manifest.agents.filter((entry) => entry.name !== "coder") }), /the agent `coder` has no `agents` entry/],
]) {
  test(`a manifest with ${label} keeps the CLI running and refuses \`run check\` with one line naming the reason and the path`, (t) => {
    assertBrokenInstall(t, (path) => writeFileSync(path, JSON.stringify(reshape(JSON.parse(readFileSync(path, "utf8"))))), reason);
  });
}

test("a record of a phase whose manifest entry has no verdicts is refused, not a crash", () => {
  const manifest = { ...pipelineManifest(), phases: [{ id: "explore", check: "02" }] };
  assert.throws(() => refuseInvalidAnswer(answerWith({ record: { phase: "explore", verdict: "OK" } }), manifest), /the manifest's phase `explore` has no `verdicts` list/);
});

test("an install with no manifest keeps the CLI running and refuses `run check` with one line saying it is missing", (t) => {
  assertBrokenInstall(t, (path) => rmSync(path), /it is missing/);
});

test("an install whose manifest is not JSON keeps the CLI running and refuses `run check` with one line saying so", (t) => {
  assertBrokenInstall(t, (path) => writeFileSync(path, "{ not json"), /it is not valid JSON: /);
});

test("a manifest that declares a field the runtime has no writer for is still refused", () => {
  const manifest = { ...pipelineManifest(), recordable: ["brand-new"] };
  assert.throws(() => refuseInvalidAnswer(answerWith({ effects: [{ kind: "recordFields", fields: { "brand-new": 1 } }] }), manifest), /field `brand-new` is not recordable/);
});

test("a decision record is refused for a pipeline whose manifest does not declare `decisions`", () => {
  const manifest = { ...pipelineManifest(), recordable: ["pipelineLoops"] };
  const effect = { kind: "recordDecision", decision: { check: "06", next: "report" }, loops: {} };
  assert.throws(() => refuseInvalidAnswer(answerWith({ effects: [effect] }), manifest), /`decisions` is not recordable/);
  assert.doesNotThrow(() => refuseInvalidAnswer(answerWith({ effects: [effect] }), pipelineManifest()));
});

test("the phase names of a run come from the pipeline its state pinned", () => {
  assert.equal(terminationRefusal("triage", "a reason"), null);
  assert.match(terminationRefusal("triagem", "a reason").reason, /unknown phase `triagem`; accepted: triage, /);
  assert.match(terminationRefusal("triage", "a reason", { pipeline: { name: "missing-one", version: "1" } }).reason, /the pipeline `missing-one` has no readable package/);
});

test("the generic runtime field drops only the entries its filter matches, and refuses a key it does not record", (t) => {
  const { env, projectId } = seedRun(t, "runtime-field");
  const target = { projectId, slug: SLUG, env };
  recordPhaseDone({ ...target, phase: "qa", verdict: "SKIPPED", by: "runtime" });
  recordPhaseDone({ ...target, phase: "qa", verdict: "SKIPPED", by: "orchestrator" });

  assert.equal(recordRuntimeField({ ...target, name: "qaMode", value: { mode: "lite", reason: "r" }, dropPhases: { phase: "qa", by: "runtime", verdict: "SKIPPED" } }).status, "written");

  const state = readRunState(target);
  assert.deepEqual(state.phases.map((entry) => entry.by), ["orchestrator"]);
  assert.equal(state.qaMode.mode, "lite");
  assert.equal(recordRuntimeField({ ...target, name: "job", value: {} }).status, "kept");
});

test("a `run append` waiting on the lock while `run check 05` consolidates loses nothing", async (t) => {
  const qa = readFileSync(join(ROOT, "test", "fixtures", "check", "qa-full-consolidated", "05-qa.md"), "utf8");
  const { env, dir } = seedRun(t, "append-race", { "05-qa.md": qa });
  const draft = join(dir, "late-round.md");
  writeFileSync(draft, "## Proven breaks\nNone\n\n## Validated risks\nH1: HELD (REFUTED) — late\n\n## Generated PoCs\n- poc/late.poc.test.mjs\n\n## Verdict\nAPPROVED\n");
  const real = await loadPipeline("resolve");
  let append = null;
  const waiting = () => {
    const child = spawn(process.execPath, [CLI, "run", "append", "05", "--group", "late", "--from", draft], { env, stdio: "ignore" });
    append = new Promise((resolve) => child.on("exit", resolve));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  };
  const load = async () => ({
    manifest: real.manifest,
    check: (args) => {
      const answer = real.check(args);
      waiting();
      return answer;
    },
  });

  const { code, err } = await runCheck(env, "05", { loadPipeline: load });
  assert.equal(code, 0, err);
  assert.equal(await append, 0);

  const text = readFileSync(join(dir, "05-qa.md"), "utf8");
  assert.ok(text.includes("source: runtime consolidation · rounds 1, 2, 3"), "the consolidated round was lost");
  assert.ok(text.includes("source: prover · group: late"), "the appended round was lost");
  assert.ok(text.indexOf("runtime consolidation") < text.indexOf("group: late"), "the append did not wait for the check's lock");
});

test("the report facts and the job screen read the derived file list when the artifact lists no file", async (t) => {
  const { env, dir, projectId, id } = seedRun(t, "fallback", {
    "04-implementation.md": "# Implementation\n\n## Left\nnothing\n",
    "04-files.generated.md": "# Implementation (derived from git)\n\n## Modified files\n/w/src/derived.mjs\n",
  });
  recordRunFields({ projectId, slug: SLUG, fields: { type: "feature/refactor" }, env });

  const facts = await reportFacts({ runDir: dir, state: readRunState({ projectId, slug: SLUG, env }) });
  assert.ok(facts.includes("- Modified file: /w/src/derived.mjs"), facts.join("\n"));

  const extras = await jobExtras({ id, project_id: projectId, slug: SLUG }, { env, store: { projects: { agents: async () => null } } });
  assert.deepEqual(extras.files, ["/w/src/derived.mjs"]);
});

test("every retired tool answers the stale-contract line, `context_for_phase` naming its successor", async (t) => {
  const env = makeHome(t, "package-retired-tools");
  const client = await connect(t, env);
  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ["run_phase_done", "run_skip", "context_for_phase"]) {
    assert.equal(listed.includes(name), false, name);
    const answer = await client.callTool({ name, arguments: { phase: "triage" } });
    assert.equal(answer.isError, true, name);
    assert.match(textOf(answer), /your client has the tool definitions of an older nightqueue \(contract 14, this server is 15\)/, name);
  }
  assert.match(textOf(await client.callTool({ name: "context_for_phase", arguments: { target: "coder" } })), /use `context_for_agent` with `agent`/);
});

test("`context_for_agent` answers with `agent` for every value, and refuses the old `target`", async (t) => {
  const { env, id } = seedRun(t, "context-agent");
  const client = await connect(t, env);
  for (const agent of ["triager", "architect", "coder", "qa", "verifier", "explore", "reflector"]) {
    const answer = await client.callTool({ name: "context_for_agent", arguments: { agent, project: "alpha" } });
    assert.notEqual(answer.isError, true, `${agent} (job ${id}): ${textOf(answer)}`);
    assert.equal(typeof JSON.parse(textOf(answer)).block, "string", agent);
  }
  const old = await client.callTool({ name: "context_for_agent", arguments: { target: "coder", project: "alpha" } });
  assert.equal(old.isError, true);
});

test("what stays: `pipeline_log` still answers, `run pr --template` still prints, and `run commit` names `run publish`", async (t) => {
  const { env } = seedRun(t, "kept");
  const client = await connect(t, env);
  const logged = await client.callTool({ name: "pipeline_log", arguments: { outcome: "pr_opened" } });
  assert.notEqual(logged.isError, true, textOf(logged));

  const lines = [];
  const pr = await run(["run", "pr", "--template"], { env, out: (line) => lines.push(line), err: (line) => lines.push(line), stdout: { write: () => {} } });
  assert.equal(pr, 0, lines.join("\n"));
  assert.match(lines[0], /^TEMPLATE: /);

  const errors = [];
  const commit = await run(["run", "commit", "--message-file", "x"], { env, out: () => {}, err: (line) => errors.push(line), stdout: { write: () => {} } });
  assert.equal(commit, 1);
  assert.match(errors.join("\n"), /`run commit` was removed: `nightqueue run publish/);
});
