import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDir } from "../src/config/paths.mjs";
import { run } from "../src/cli/index.mjs";
import { phasePrompt } from "../src/mcp/phase-prompt.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob, getJob } from "../src/memory/jobs.mjs";
import { evaluateCheck, qaModeOf } from "../src/queue/check-contract.mjs";
import { composeGateNotice } from "../src/queue/gate-notice.mjs";
import { decideResume, readRunState } from "../src/queue/resume.mjs";
import { applyRetry } from "../src/queue/retry.mjs";
import { provisionalSlug } from "../src/queue/run-slug.mjs";
import { recordPhaseDone, recordRunFields, recordTermination } from "../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject } from "../test-support/memory.mjs";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "check");
const SLUG = "check-contract";

// The fixture directories, one per gate code or fact of the check contract.
function fixtureNames() {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

// One fixture: its check and Type, the run files it seeds and the exact lines it expects.
function readFixture(name) {
  const dir = join(FIXTURES, name);
  const fixture = JSON.parse(readFileSync(join(dir, "fixture.json"), "utf8"));
  const files = readdirSync(dir).filter((file) => file.endsWith(".md"));
  const texts = Object.fromEntries(files.map((file) => [file, readFileSync(join(dir, file), "utf8")]));
  const expected = readFileSync(join(dir, "expected.txt"), "utf8").replace(/\n$/, "").split("\n");
  return { fixture, texts, expected };
}

// A job bound to the run slug with the fixture's files in its run directory and its Type recorded.
function seedRun(t, name, { fixture, texts }) {
  const env = makeHome(t, `check-contract-${name}`);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "check the contract" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  if (fixture.type) recordRunFields({ projectId, slug: SLUG, fields: { type: fixture.type }, env });
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(texts)) writeFileSync(join(dir, file), body);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, projectId, dir };
}

// Runs `nightqueue run check` in this process, capturing what it printed.
async function runCheck(env, check) {
  const out = [];
  const err = [];
  const code = await run(["run", "check", check], { env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  return { code, out, err };
}

test("every gate code and fact of the check contract has a fixture", () => {
  const names = fixtureNames();
  const codes = [
    "symptom-proof-missing",
    "coverage-vector-no-reason",
    "coverage-enumeration-no-method",
    "coverage-not-covered-without-confirmation",
    "usage-coverage-cond-1",
    "usage-coverage-cond-2",
    "usage-coverage-cond-3",
    "usage-coverage-cond-4",
    "symptom-coverage-n-mismatch",
    "symptom-coverage-omitted-empty",
    "symptom-coverage-method-generic",
    "usage-coverage-nm-mismatch",
    "usage-coverage-divergences-empty",
    "usage-coverage-held-on-pipeline",
    "runtime-not-met",
    "runtime-no-attempt",
    "brief-missing",
    "brief-field-empty",
    "brief-type-invalid",
    "brief-commit-type-invalid",
  ];
  for (const code of codes) {
    assert.ok(names.includes(code), `no fixture for ${code}`);
    assert.ok(readFixture(code).expected.some((line) => line.startsWith(`GATE: ${code} — `)), `the ${code} fixture never fires it`);
  }
});

for (const name of fixtureNames()) {
  test(`\`run check\` answers the exact contract lines of the ${name} fixture`, async (t) => {
    const fixture = readFixture(name);
    const { env } = seedRun(t, name, fixture);
    const { code, out, err } = await runCheck(env, fixture.fixture.check);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(out, fixture.expected);
  });
}

test("a check that fired a gate, a loop-back verdict or a missing part never completes its phase", () => {
  const verdict = (text) => `## Checks run\n- Tests: PASSED\n\n## Verification: ${text}\n`;
  assert.equal(evaluateCheck({ check: "06", texts: { "06-verification.md": verdict("PASSED") } }).completes, true);
  const failed = evaluateCheck({ check: "06", texts: { "06-verification.md": verdict("FAILED") } });
  assert.equal(failed.completes, false);
  assert.equal(failed.memoLine, "VERDICT: FAILED");
  const missing = evaluateCheck({ check: "06", texts: {} });
  assert.equal(missing.completes, false);
  assert.equal(missing.memoLine, "MISSING: ## Checks run, ## Verification");
  const gated = readFixture("runtime-not-met");
  const result = evaluateCheck({ check: "06.5", texts: gated.texts, state: { type: "bug/error" } });
  assert.equal(result.completes, false);
  assert.equal(result.memoLine, "GATE: runtime-not-met — queue close J-2");
});

test("a pause completes its phase and is the line the check memo keeps", () => {
  const confirm = readFixture("confirm");
  const result = evaluateCheck({ check: "03", texts: confirm.texts, state: { type: "bug/error" } });
  assert.equal(result.completes, true);
  assert.equal(result.memoLine, "CONFIRM: requires-user-confirmation");
});

test("without a recorded Type the triage decides it, and with no triage the fail-safe is bug/error", () => {
  const coverageless = readFixture("symptom-coverage-missing").texts;
  assert.equal(evaluateCheck({ check: "03", texts: coverageless }).type, "bug/error");
  assert.equal(evaluateCheck({ check: "03", texts: coverageless }).first, "MISSING: ## Symptom coverage");
  const feature = { ...coverageless, "01-triage.md": readFixture("type-mismatch").texts["01-triage.md"] };
  assert.equal(evaluateCheck({ check: "03", texts: feature }).type, "feature/refactor");
  assert.equal(evaluateCheck({ check: "03", texts: { "03-plan.md": coverageless["03-plan.md"] } }).type, "bug/error");
});

test("gate evidence is one line of at most 160 code points", () => {
  const long = `${"x".repeat(300)}`;
  const texts = readFixture("coverage-enumeration-no-method").texts;
  const plan = texts["03-plan.md"].replace("I analyzed the code and the callers", long);
  const [, gateLine] = evaluateCheck({ check: "03", texts: { ...texts, "03-plan.md": plan }, state: { type: "bug/error" } }).lines;
  const evidence = gateLine.slice("GATE: coverage-enumeration-no-method — ".length);
  assert.equal([...evidence].length, 160);
  assert.ok(evidence.endsWith("…"));
});

// ---- Stage 2: the effects a check chains after its contract lines.

// The state.json of a seeded run.
function stateOf({ env, projectId }) {
  return readRunState({ projectId, slug: SLUG, env });
}

// A verification artifact whose checks and verdict both say the result.
function verification(verdict) {
  return `## Checks run\n- Tests: ${verdict}\n\n## Verification: ${verdict}\n`;
}

// Waits long enough for the next record to carry a later timestamp than the previous one.
function nextMillisecond() {
  return new Promise((done) => setTimeout(done, 5));
}

test("a completed check records its phase as the runtime, and the same artifact checked again answers (already)", async (t) => {
  const seeded = seedRun(t, "effects-dedupe", { fixture: {}, texts: { "06-verification.md": verification("PASSED") } });
  const first = await runCheck(seeded.env, "06");
  assert.deepEqual(first.out, ["OK", "VERDICT: PASSED", "recorded: phase_done verification PASSED"]);
  const again = await runCheck(seeded.env, "06");
  assert.deepEqual(again.out, ["OK", "VERDICT: PASSED", "recorded: phase_done verification PASSED (already)"]);
  const { phases, checks } = stateOf(seeded);
  assert.equal(phases.length, 1);
  assert.deepEqual({ ...phases[0], at: null }, { phase: "verification", at: null, artifact: "06-verification.md", verdict: "PASSED", by: "runtime" });
  assert.equal(checks["06"].line, "OK");
  assert.equal(checks["06"].ok, true);
  assert.equal(checks.lastFailure, undefined);
});

test("a loop-back verdict or a gate records no phase, and the passing re-check sends the failure as its reason", async (t) => {
  const seeded = seedRun(t, "effects-loop-back", { fixture: {}, texts: { "06-verification.md": verification("FAILED") } });
  const failed = await runCheck(seeded.env, "06");
  assert.deepEqual(failed.out, ["OK", "VERDICT: FAILED", "recorded: none (VERDICT: FAILED)"]);
  assert.equal(stateOf(seeded).phases, undefined);
  assert.deepEqual({ ...stateOf(seeded).checks.lastFailure, at: null }, { check: "06", line: "VERDICT: FAILED", at: null });
  writeFileSync(join(seeded.dir, "06-verification.md"), verification("PASSED"));
  const passed = await runCheck(seeded.env, "06");
  assert.equal(passed.out.at(-1), "recorded: phase_done verification PASSED — reason: VERDICT: FAILED");

  const gated = readFixture("runtime-not-met");
  const gatedRun = seedRun(t, "effects-gate", gated);
  await runCheck(gatedRun.env, "06.5");
  assert.equal(stateOf(gatedRun).phases, undefined);
  assert.equal(stateOf(gatedRun).checks.lastFailure.line, "GATE: runtime-not-met — queue close J-2");
});

test("a phase checked again after another check failed names that failure as the reason of its re-run", async (t) => {
  const explore = readFixture("explore-index-saved").texts;
  const seeded = seedRun(t, "effects-re-run", { fixture: {}, texts: { ...explore, "06-verification.md": verification("FAILED") } });
  assert.equal((await runCheck(seeded.env, "02")).out.at(-1), "recorded: phase_done explore OK");
  await nextMillisecond();
  await runCheck(seeded.env, "06");
  writeFileSync(join(seeded.dir, "02-explore.md"), `${explore["02-explore.md"]}\n`);
  assert.equal((await runCheck(seeded.env, "02")).out.at(-1), "recorded: phase_done explore OK — reason: re-run after 06 VERDICT: FAILED");
  assert.deepEqual(stateOf(seeded).phases.map((entry) => entry.reason ?? null), [null, "re-run after 06 VERDICT: FAILED"]);
});

test("a terminal triage verdict records the termination, so the run is never resumed", async (t) => {
  const seeded = seedRun(t, "effects-terminal", readFixture("triage-terminal-verdict"));
  await runCheck(seeded.env, "01");
  const state = stateOf(seeded);
  const reason = "NOT-REPRODUCIBLE: The listing never showed archived jobs on the reported build.";
  assert.deepEqual({ ...state.termination, at: null }, { phase: "triage", reason, at: null, by: "runtime" });
  assert.equal(decideResume({ state }).reason, "terminated-by-verdict");
});

test("a triage with no recorded Type writes the Type it implies", async (t) => {
  const seeded = seedRun(t, "effects-type", readFixture("triage-records-type"));
  await runCheck(seeded.env, "01");
  assert.equal(stateOf(seeded).type, "feature/refactor");
});

test("a completed check 05a records the QA stage A marker and no phase", async (t) => {
  const report = "## Proven breaks\nNone\n\n## Break hypotheses\n- H1\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1\n\n## Invalidated assumptions\nNone\n\n## Verdict\nAPPROVED\n";
  const seeded = seedRun(t, "effects-qa-stage-a", { fixture: {}, texts: { "05a-qa-analyst.md": report } });
  const { out } = await runCheck(seeded.env, "05a");
  assert.deepEqual(out, ["OK", "VERDICT: APPROVED", "recorded: qa_stage_a APPROVED"]);
  const state = stateOf(seeded);
  assert.deepEqual([state.qaStageA.artifact, state.qaStageA.verdict], ["05a-qa-analyst.md", "APPROVED"]);
  assert.equal(state.phases, undefined);
});

// ---- Fix round 1.

// A complete `## Brief` of a bug triage, with the extra field lines given.
function briefOf(extra = "") {
  return `## Brief\n**Affected area:** src/a.mjs\n**Context:** the listing\n**Objective:** list the jobs\n**Expected outcome:** the archived jobs are listed\n**Type:** bug/error\n**Commit type:** fix\n${extra}\n`;
}

// A triage of the given verdict whose open item asks the user one question.
function triageWith(verdict, openItems = "## Open items\n- Which listing is meant?\n", brief = briefOf()) {
  return `# Triage\n\n${brief}## Verdict: ${verdict}\n\nEvidence level: 3\n\n## Diagnosis\n- Confirmed root cause: y (src/a.mjs:1)\n- Symptom proof: a.mjs:1 calls b\n\n## Validated brief\nFix the thing.\n\n## Out of scope\n- None.\n\n## Request gaps\n- None.\n\n${openItems}`;
}

test("a clarification triage without an open item is MISSING, so nothing completes and nothing terminates", async (t) => {
  const seeded = seedRun(t, "open-items-missing", readFixture("triage-open-items-missing"));
  assert.deepEqual((await runCheck(seeded.env, "01")).out, ["MISSING: ## Open items"]);
  const state = stateOf(seeded);
  assert.equal(state.termination, undefined);
  assert.equal(state.phases, undefined);
});

test("an open item written as prose counts, and a deeper `### Open items` heading does not", () => {
  const prose = evaluateCheck({ check: "01", texts: { "01-triage.md": triageWith("NEEDS-CLARIFICATION", "## Open items\n\nWhich listing is meant?\n") } });
  assert.equal(prose.first, "OK");
  const deeper = evaluateCheck({ check: "01", texts: { "01-triage.md": triageWith("NEEDS-CLARIFICATION", "### Open items\n- Which listing is meant?\n") } });
  assert.equal(deeper.first, "MISSING: ## Open items");
});

test("a PROCEED re-triage lifts the runtime's clarification stop, and the answered run resumes", async (t) => {
  const seeded = seedRun(t, "lift-termination", { fixture: { type: "bug/error" }, texts: { "01-triage.md": triageWith("NEEDS-CLARIFICATION") } });
  assert.equal((await runCheck(seeded.env, "01")).out.at(-2), "recorded: run_terminate triage NEEDS-CLARIFICATION");
  assert.equal(stateOf(seeded).termination.by, "runtime");
  writeFileSync(join(seeded.dir, "01-triage.md"), triageWith("PROCEED"));
  assert.deepEqual((await runCheck(seeded.env, "01")).out.slice(-2), ["recorded: termination cleared", `recorded: slug ${SLUG}`]);
  recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase: "explore", env: seeded.env });
  recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase: "architecture", env: seeded.env });
  const decision = decideResume({ state: stateOf(seeded) });
  assert.deepEqual([decision.resume, decision.fromPhase], [true, "implementation"]);
});

test("a termination written by hand is never lifted by a PROCEED re-triage", async (t) => {
  const seeded = seedRun(t, "keep-hand-termination", { fixture: { type: "bug/error" }, texts: { "01-triage.md": triageWith("PROCEED") } });
  recordTermination({ projectId: seeded.projectId, slug: SLUG, phase: "triage", reason: "NEEDS-CLARIFICATION: by hand", env: seeded.env });
  const { out } = await runCheck(seeded.env, "01");
  assert.ok(!out.includes("recorded: termination cleared"), out.join("\n"));
  assert.equal(stateOf(seeded).termination.reason, "NEEDS-CLARIFICATION: by hand");
});

test("a code token with regex characters named verbatim in the brief holds the cond-3 exception", () => {
  const texts = readFixture("usage-coverage-cond-3-exception").texts;
  const explore = "# Explore\n\n## Access map\n- unimplemented intent: `run_outcome(from_artifact)` · governs filter\n";
  const triage = texts["01-triage.md"].replace("Make listJobs", "Make run_outcome(from_artifact) and listJobs");
  const result = evaluateCheck({ check: "03", texts: { ...texts, "02-explore.md": explore, "01-triage.md": triage }, state: { type: "feature/refactor" } });
  assert.deepEqual(result.lines, ["OK", "QA: lite"]);
});

test("table cells keep a pipe inside a code span, and a lone backtick is plain text", () => {
  const runtime = "## Runtime verdict\nCONFIRMED\n\n| # | Scenario | Result | Evidence |\n|---|---|---|---|\n| 1 | list | MET | `a|b` matched |\n";
  assert.deepEqual(evaluateCheck({ check: "06.5", texts: { "06-runtime.md": runtime } }).lines, ["OK", "VERDICT: CONFIRMED"]);
  const texts = readFixture("coverage-table-pipes").texts;
  const plan = texts["03-plan.md"].replace("| 2 | a \\| b path |", "| 2 | a ` b path |");
  const result = evaluateCheck({ check: "03", texts: { ...texts, "03-plan.md": plan }, state: { type: "bug/error" } });
  assert.deepEqual(result.lines, ["OK", "QA: lite"]);
});

test("the QA mode counts 🔴 risk items of `## Identified risks` only: list items and table body rows", () => {
  const risks = (body) => `## Implementation plan\n- x\n\n## Identified risks\n${body}`;
  assert.equal(qaModeOf(risks("| ID | 🔴 severity | Scenario |\n|---|---|---|\n| R1 | 🔴 | a |\n| R2 | 🟡 | b |\n")), "lite", "a 🔴 table header is no risk");
  assert.equal(qaModeOf(risks("| ID | Severity | Scenario |\n|---|---|---|\n| R1 | 🔴 | a |\n| R2 | 🔴 | b |\n")), "full");
  assert.equal(qaModeOf(risks("* [R1] 🔴 a\n+ [R2] 🔴 b\n")), "full");
  assert.equal(qaModeOf(risks("- [R1] 🔴 a\n<!-- - [R2] 🔴 b -->\n")), "lite", "a commented-out risk is not counted");
  assert.equal(qaModeOf(`${risks("- [R1] 🔴 a\n")}\n## Notes\n- [R2] 🔴 b\n`), "lite", "a 🔴 in a later section is not a risk");
  assert.equal(qaModeOf("## Implementation plan\n- x\n"), "lite", "a plan without risks is lite");
  assert.equal(qaModeOf("  **Always-gate class:** yes — rows change\n"), "full");
  assert.equal(qaModeOf("**Always-gate class:** no\n"), "lite");
});

test("the QA line never changes completion nor the memo line of check 03", () => {
  const { texts } = readFixture("qa-full-risks");
  const result = evaluateCheck({ check: "03", texts, state: { type: "feature/refactor" } });
  assert.equal(result.completes, true);
  assert.equal(result.memoLine, "OK");
  const confirm = evaluateCheck({ check: "03", texts: readFixture("confirm").texts, state: { type: "bug/error" } });
  assert.deepEqual(confirm.lines.slice(-2), ["CONFIRM: requires-user-confirmation", "QA: lite"]);
  for (const check of ["05", "06", "06.5"]) assert.equal(evaluateCheck({ check, texts }).lines.some((line) => line.startsWith("QA: ")), false, check);
});

test("a `###` confirmation heading the check announces is the section the gate notice composes", async (t) => {
  const seeded = seedRun(t, "confirm-level-3", readFixture("confirm-heading-level-3"));
  assert.ok((await runCheck(seeded.env, "03")).out.includes("CONFIRM: requires-user-confirmation"));
  const notice = composeGateNotice({ runDir: seeded.dir, fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" } });
  assert.ok(notice.startsWith("### Requires user confirmation"), notice);
});

test("a refused record prints `recorded: not recorded` and never changes the first line or the exit code", async (t) => {
  const seeded = seedRun(t, "effects-refused", { fixture: {}, texts: { "06-verification.md": verification("PASSED") } });
  mkdirSync(join(seeded.dir, "state.json"));
  const { code, out } = await runCheck(seeded.env, "06");
  assert.equal(code, 0);
  assert.deepEqual(out.slice(0, 2), ["OK", "VERDICT: PASSED"]);
  assert.match(out[2], /^recorded: not recorded \(.+\)$/);
});

// ---- The triager writes the Brief: check 01 copies it, records its facts and binds its slug.

// The job id a seeded run's environment names.
function jobIdOf(seeded) {
  return Number(seeded.env.NIGHTQUEUE_JOB_ID);
}

// A run still on the provisional slug the runtime derived for its job, held by a worker, with a triage written into it.
function seedProvisional(t, name, triage) {
  const env = makeHome(t, `check-contract-${name}`);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "check the contract" }, env).id;
  const slug = provisionalSlug(getJob(id, env));
  openDb(env).prepare("UPDATE jobs SET slug = ?, worker = 'w1' WHERE id = ?").run(slug, id);
  const dir = runDir(projectId, slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "01-triage.md"), triage);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, projectId, slug, dir, id };
}

test("a PROPOSE-ALTERNATIVE triage terminates the run, the gate answer lifts it, and a PROCEED re-triage records the phase", async (t) => {
  const seeded = seedRun(t, "propose-alternative", readFixture("triage-propose-alternative"));
  const proposed = await runCheck(seeded.env, "01");
  assert.ok(proposed.out.includes("recorded: run_terminate triage PROPOSE-ALTERNATIVE"), proposed.out.join("\n"));
  assert.equal(decideResume({ state: stateOf(seeded) }).reason, "terminated-by-verdict");
  const notice = composeGateNotice({ runDir: seeded.dir, fromArtifact: { file: "01-triage.md", section: "## Open items" } });
  assert.match(notice, /Alternative: filter the existing `queue list`/);
  openDb(seeded.env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(jobIdOf(seeded));
  await applyRetry({ id: jobIdOf(seeded), note: "go with the alternative", env: seeded.env });
  assert.equal(stateOf(seeded).termination, undefined);
  writeFileSync(join(seeded.dir, "01-triage.md"), triageWith("PROCEED"));
  const proceeded = await runCheck(seeded.env, "01");
  assert.ok(proceeded.out.some((line) => line.startsWith("recorded: phase_done triage PROCEED")), proceeded.out.join("\n"));
  const reTriaged = decideResume({ state: stateOf(seeded) });
  assert.deepEqual([reTriaged.resume, reTriaged.fromPhase], [true, "explore"]);
  recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase: "explore", env: seeded.env });
  const decision = decideResume({ state: stateOf(seeded) });
  assert.deepEqual([decision.resume, decision.fromPhase], [true, "architecture"]);
});

test("a terminal triage with a partial Brief fires no field gate and still terminates", async (t) => {
  const partial = "## Brief\n**Affected area:** src/a.mjs\n**Commit type:**\n\n";
  const seeded = seedRun(t, "terminal-partial-brief", { fixture: { type: "bug/error" }, texts: { "01-triage.md": triageWith("NEEDS-CLARIFICATION", undefined, partial) } });
  const { out } = await runCheck(seeded.env, "01");
  assert.ok(!out.some((line) => line.startsWith("GATE: ")), out.join("\n"));
  assert.ok(out.includes("recorded: run_terminate triage NEEDS-CLARIFICATION"), out.join("\n"));
});

test("check 01 writes the Brief the phase prompts read and records the type and the commit type", async (t) => {
  const seeded = seedRun(t, "writes-brief", { fixture: {}, texts: { "01-triage.md": triageWith("PROCEED") } });
  recordRunFields({ projectId: seeded.projectId, slug: SLUG, fields: { branch: "fix/the-worker" }, env: seeded.env });
  const { out } = await runCheck(seeded.env, "01");
  assert.deepEqual(out, [
    "OK",
    "VERDICT: PROCEED",
    "recorded: type bug/error",
    "recorded: brief 00-brief.md",
    "recorded: commit type fix",
    "recorded: phase_done triage PROCEED",
    `recorded: slug ${SLUG}`,
  ]);
  const brief = readFileSync(join(seeded.dir, "00-brief.md"), "utf8");
  assert.ok(brief.startsWith("## Brief\n"), brief);
  assert.match(brief, /^\*\*Context:\*\* the listing$/m);
  assert.match(brief, /^\*\*Expected outcome:\*\* the archived jobs are listed$/m);
  const state = stateOf(seeded);
  assert.deepEqual([state.type, state.commitType], ["bug/error", "fix"]);
  const run = { project: "alpha", projectId: seeded.projectId, slug: SLUG };
  const { prompt } = await phasePrompt({ target: "explore" }, { run, env: seeded.env });
  assert.ok(prompt.includes("Find the files related to: src/a.mjs"), prompt);
  assert.ok(prompt.includes("Task objective: list the jobs"), prompt);
});

test("a valid Brief Type overrides a different recorded type, and says what it replaced", async (t) => {
  const seeded = seedRun(t, "type-override", { fixture: { type: "feature/refactor" }, texts: { "01-triage.md": triageWith("PROCEED") } });
  const { out } = await runCheck(seeded.env, "01");
  assert.ok(out.includes("recorded: type bug/error (was feature/refactor)"), out.join("\n"));
  assert.equal(stateOf(seeded).type, "bug/error");
});

test("check 01 renames a provisional run onto the Brief's slug, last, leaving no directory at the old slug", async (t) => {
  const seeded = seedProvisional(t, "slug-rename", triageWith("PROCEED", undefined, briefOf("**Slug:** active-jobs-filter\n")));
  const { out } = await runCheck(seeded.env, "01");
  const newDir = runDir(seeded.projectId, "active-jobs-filter", seeded.env);
  assert.equal(out.at(-1), `recorded: slug active-jobs-filter (renamed from ${seeded.slug}; run dir ${newDir})`);
  assert.equal(existsSync(seeded.dir), false, "a ghost directory was left at the provisional slug");
  assert.ok(existsSync(join(newDir, "00-brief.md")));
  assert.equal(readRunState({ projectId: seeded.projectId, slug: "active-jobs-filter", env: seeded.env }).phases[0].phase, "triage");
  assert.equal(getJob(seeded.id, seeded.env).slug, "active-jobs-filter");
});

test("a provisional run keeps its slug when the Brief's slug is taken, missing or invalid", async (t) => {
  const taken = seedProvisional(t, "slug-taken", triageWith("PROCEED", undefined, briefOf("**Slug:** active-jobs-filter\n")));
  const other = addJob({ projectId: taken.projectId, prompt: "another job" }, taken.env).id;
  openDb(taken.env).prepare("UPDATE jobs SET slug = 'active-jobs-filter' WHERE id = ?").run(other);
  const takenOut = (await runCheck(taken.env, "01")).out;
  assert.match(takenOut.at(-1), new RegExp(`^recorded: slug ${taken.slug} \\(kept: .+ holds it\\)$`));
  assert.ok(existsSync(taken.dir));
  assert.equal(getJob(taken.id, taken.env).slug, taken.slug);

  const missing = seedProvisional(t, "slug-missing", triageWith("PROCEED"));
  assert.equal((await runCheck(missing.env, "01")).out.at(-1), `recorded: slug ${missing.slug} (kept: the Brief names no **Slug:**)`);

  const invalid = seedProvisional(t, "slug-invalid", triageWith("PROCEED", undefined, briefOf("**Slug:** ../escape\n")));
  assert.equal((await runCheck(invalid.env, "01")).out.at(-1), `recorded: slug ${invalid.slug} (kept: \`../escape\` is not a valid run slug)`);
});
