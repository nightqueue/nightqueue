import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDir } from "../src/config/paths.mjs";
import { run } from "../src/cli/index.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob, getJob } from "../src/memory/jobs.mjs";
import { evaluateCheck } from "../plugin/skills/resolve/pipeline/contract.mjs";
import { composeGateNotice, gateDigestOf } from "../src/queue/gate-notice.mjs";
import { questionDigest } from "../src/queue/question-text.mjs";
import { jobPromptText } from "../src/queue/job-prompt.mjs";
import { nextRound } from "../src/queue/rounds.mjs";
import { readRunState, saveRunState } from "../src/queue/resume.mjs";
import { applyRetry } from "../src/queue/retry.mjs";
import { provisionalSlug } from "../src/queue/run-slug.mjs";
import { recordOutcome, recordPhaseDone, recordRunFields, recordTermination } from "../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject } from "../test-support/memory.mjs";
import { phasePrompts } from "../test-support/skill-size.mjs";

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

// A job bound to the run slug, with the fixture's prompt and operator note, its files in its run directory, its Type recorded and the digest of a question it paused on.
function seedRun(t, name, { fixture, texts }) {
  const env = makeHome(t, `check-contract-${name}`);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: fixture.prompt ?? "check the contract" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  if (fixture.operatorNote) openDb(env).prepare("UPDATE jobs SET operator_note = ? WHERE id = ?").run(fixture.operatorNote, id);
  if (fixture.type) recordRunFields({ projectId, slug: SLUG, fields: { type: fixture.type }, env });
  if (fixture.gateQuestionDigest) recordOutcome({ projectId, slug: SLUG, status: "gate", questionDigest: fixture.gateQuestionDigest, env });
  if (fixture.answers) saveRunState({ projectId, slug: SLUG, env, state: { ...readRunState({ projectId, slug: SLUG, env }), answers: fixture.answers } });
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(texts)) writeFileSync(join(dir, file), body);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, projectId, dir };
}

// Runs `nightqueue run check` in this process, capturing the contract lines it printed without the `NEXT:` line a successful check ends with.
async function runCheck(env, check, args = []) {
  const out = [];
  const err = [];
  const code = await run(["run", "check", check, ...args], { env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
  if (code === 0) assert.match(out.pop(), /^NEXT: \S/);
  return { code, out, err };
}

test("free-form artifacts pass, and only an absent artifact or an absent verdict word is MISSING", () => {
  for (const name of ["free-form-triage", "free-form-explore", "free-form-plan", "free-form-verification", "brief-missing", "brief-field-empty"]) {
    assert.equal(readFixture(name).expected[0], "OK", name);
  }
  assert.deepEqual(readFixture("artifact-missing").expected, ["MISSING: 06-verification.md (not written)"]);
  assert.deepEqual(readFixture("triage-verdict-unknown").expected, ["MISSING: verdict (one of: PROCEED, NO-CHANGE-NEEDED, NOT-REPRODUCIBLE)"]);
  for (const name of fixtureNames()) assert.equal(readFixture(name).expected.some((line) => /^(?:GATE|OPEN|INVALIDATED|DIFF-APPLIES|TYPE-MISMATCH):/.test(line)), false, name);
});

for (const name of fixtureNames()) {
  test(`\`run check\` answers the exact contract lines of the ${name} fixture`, async (t) => {
    const fixture = readFixture(name);
    const { env } = seedRun(t, name, fixture);
    const { code, out, err } = await runCheck(env, fixture.fixture.check, fixture.fixture.args ?? []);
    assert.equal(code, 0, err.join("\n"));
    assert.deepEqual(out, fixture.expected);
  });
}

test("a check with a loop-back verdict or a missing part never completes its phase", () => {
  const verdict = (text) => `## Checks run\n- Tests: PASSED\n\n## Verification: ${text}\n`;
  assert.equal(evaluateCheck({ check: "06", texts: { "06-verification.md": verdict("PASSED") } }).completes, true);
  const failed = evaluateCheck({ check: "06", texts: { "06-verification.md": verdict("FAILED") } });
  assert.equal(failed.completes, false);
  assert.equal(failed.memoLine, "VERDICT: FAILED");
  const missing = evaluateCheck({ check: "06", texts: {} });
  assert.equal(missing.completes, false);
  assert.equal(missing.memoLine, "MISSING: 06-verification.md (not written)");
  const notMet = evaluateCheck({ check: "07", texts: readFixture("runtime-not-met").texts, state: { type: "bug/error" } });
  assert.equal(notMet.completes, false);
  assert.equal(notMet.memoLine, "VERDICT: NOT-MET");
});

test("a pause completes its phase and is the line the check memo keeps", () => {
  const confirm = readFixture("confirm");
  const result = evaluateCheck({ check: "03", texts: confirm.texts, state: { type: "bug/error" } });
  assert.equal(result.completes, true);
  assert.equal(result.memoLine, "CONFIRM: requires-user-confirmation — approve fixing the retry path only?");
});

test("without a recorded Type the triage decides it, and with no triage the fail-safe is bug/error", () => {
  const plan = { "03-plan.md": "# Plan\nchange it\n" };
  const triage = (diagnosis) => `# Triage\n\n## Verdict: PROCEED\n\n${diagnosis}`;
  assert.equal(evaluateCheck({ check: "03", texts: { ...plan, "01-triage.md": triage("## Diagnosis\n- Confirmed root cause: the filter (src/a.mjs:1)\n") } }).type, "bug/error");
  assert.equal(evaluateCheck({ check: "03", texts: { ...plan, "01-triage.md": triage("") } }).type, "feature/refactor");
  assert.equal(evaluateCheck({ check: "03", texts: plan }).type, "bug/error");
});

test("the QA text asks the three open lines, audits no count and never reports to a pause", () => {
  const agent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "agents", "qa-guardian.md"), "utf8");
  for (const label of ["`omitted: ", "`divergences: ", "`unconfirmed decisions: "]) assert.ok(agent.includes(label), label);
  for (const gone of ["Symptom coverage:", "Usage coverage:", "source=pipeline", "`HELD` is FORBIDDEN", "as a gate", "## Requires user confirmation"]) {
    assert.equal(agent.includes(gone), false, `the qa-guardian still says ${gone}`);
  }
  assert.ok(agent.includes("You never ask the operator"));
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
  assert.deepEqual({ ...phases[0], at: null }, { phase: "verification", at: null, artifact: "06-verification.md", verdict: "PASSED", by: "runtime", claim: { attempt: 0, session: null }, attempt: 0, model: "haiku" });
  assert.equal(checks["06"].line, "OK");
  assert.equal(checks["06"].ok, true);
  assert.equal(checks.lastFailure, undefined);
});

test("a loop-back verdict records no phase, and the passing re-check sends the failure as its reason", async (t) => {
  const seeded = seedRun(t, "effects-loop-back", { fixture: {}, texts: { "06-verification.md": verification("FAILED") } });
  const failed = await runCheck(seeded.env, "06");
  assert.deepEqual(failed.out, ["OK", "VERDICT: FAILED", "recorded: none (VERDICT: FAILED)"]);
  assert.equal(stateOf(seeded).phases, undefined);
  assert.deepEqual({ ...stateOf(seeded).checks.lastFailure, at: null }, { check: "06", line: "VERDICT: FAILED", at: null });
  writeFileSync(join(seeded.dir, "06-verification.md"), verification("PASSED"));
  const passed = await runCheck(seeded.env, "06");
  assert.equal(passed.out.at(-1), "recorded: phase_done verification PASSED — reason: VERDICT: FAILED");
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

test("a terminal triage verdict records the termination", async (t) => {
  const seeded = seedRun(t, "effects-terminal", readFixture("triage-terminal-verdict"));
  await runCheck(seeded.env, "01");
  const state = stateOf(seeded);
  const reason = "NOT-REPRODUCIBLE: The listing never showed archived jobs on the reported build.";
  assert.deepEqual({ ...state.termination, at: null }, { phase: "triage", reason, at: null, by: "runtime", claim: { attempt: 0, session: null } });
});

test("a triage with no recorded Type writes the Type it implies", async (t) => {
  const seeded = seedRun(t, "effects-type", readFixture("triage-records-type"));
  await runCheck(seeded.env, "01");
  assert.equal(stateOf(seeded).type, "feature/refactor");
});

test("a completed check 05 --stage analyst answers its stage and records no marker and no phase", async (t) => {
  const report = "## Round 1\n## Proven breaks\nNone\n\n## Break hypotheses\n- H1\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone — the provers write them\n\n## Verdict\nAPPROVED\n";
  const seeded = seedRun(t, "effects-qa-stage-a", { fixture: {}, texts: { "05-qa.md": report } });
  const { out } = await runCheck(seeded.env, "05", ["--stage", "analyst"]);
  assert.deepEqual(out, ["OK", "VERDICT: APPROVED", "QA-STAGE: provers"]);
  const state = stateOf(seeded);
  assert.equal(state.phases, undefined);
});

test("check 05 of a full QA writes the consolidated round of the analyst and both provers, once", async (t) => {
  const seeded = seedRun(t, "qa-consolidated", readFixture("qa-full-consolidated"));
  await runCheck(seeded.env, "05");
  const written = readFileSync(join(seeded.dir, "05-qa.md"), "utf8");
  const consolidated = written.slice(written.indexOf("## Round 4\n"));
  assert.ok(written.includes("## Round 4\n"), written);
  assert.equal(consolidated.split("\n")[1], "source: runtime consolidation · rounds 1, 2, 3");
  assert.match(consolidated, /^## Verdict\nNEEDS FIX$/m);
  await runCheck(seeded.env, "05");
  assert.equal(readFileSync(join(seeded.dir, "05-qa.md"), "utf8"), written, "a second check wrote another consolidation");
});

test("PoC qa-r4-fence-stale-round vector a (H12): the check closes the open fence and reports it, and the lane's appended round converges", async (t) => {
  const fence = "```";
  const open = `## Round 1\n## Checks run\n- npm test\n\n## Verification: FAILED\n\n${fence}text\nunclosed\n\n## Round 2\n## Checks run\n- npm test\n\n## Verification: PASSED\n`;
  const seeded = seedRun(t, "fence-stale-round", { fixture: {}, texts: { "06-verification.md": open } });
  const path = join(seeded.dir, "06-verification.md");
  const first = await runCheck(seeded.env, "06");
  assert.equal(first.out[1], `REPAIRED: the code fence of round 1 opened at line 7 of 06-verification.md never closed; the runtime appended \`${fence}\` at line 15`);
  assert.equal(readFileSync(path, "utf8"), `${open}${fence}\n`);
  appendFileSync(path, "## Round 2\n## Checks run\n- npm test\n\n## Verification: PASSED\n");
  assert.equal(nextRound(readFileSync(path, "utf8")), 3);
  const second = await runCheck(seeded.env, "06");
  assert.deepEqual(second.out.slice(0, 2), ["OK", "VERDICT: PASSED"], second.out.join("\n"));
});

test("a check over a round artifact whose fences all close never writes it", async (t) => {
  const text = `## Round 1\n${verification("PASSED")}\n\`\`\`\nlog\n\`\`\`\n`;
  const seeded = seedRun(t, "closed-fence-untouched", { fixture: {}, texts: { "06-verification.md": text } });
  const path = join(seeded.dir, "06-verification.md");
  const before = statSync(path).mtimeMs;
  await nextMillisecond();
  const { out } = await runCheck(seeded.env, "06");
  assert.deepEqual(out.slice(0, 2), ["OK", "VERDICT: PASSED"]);
  assert.ok(!out.some((line) => line.startsWith("REPAIRED:")), out.join("\n"));
  assert.equal(readFileSync(path, "utf8"), text);
  assert.equal(statSync(path).mtimeMs, before);
});

test("a retired check id of the old numbering is refused with one line naming its new id", async (t) => {
  const seeded = seedRun(t, "renumbered", { fixture: {}, texts: {} });
  assert.deepEqual(await runCheck(seeded.env, "06.5"), { code: 1, out: [], err: ["nightqueue: renumbered: use 07"] });
  assert.deepEqual(await runCheck(seeded.env, "05a"), { code: 1, out: [], err: ["nightqueue: renumbered: use 05"] });
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

test("a PROCEED re-triage lifts the runtime's triage stop", async (t) => {
  const seeded = seedRun(t, "lift-termination", { fixture: { type: "bug/error" }, texts: { "01-triage.md": triageWith("NOT-REPRODUCIBLE") } });
  assert.equal((await runCheck(seeded.env, "01")).out.at(-2), "recorded: run_terminate triage NOT-REPRODUCIBLE");
  assert.equal(stateOf(seeded).termination.by, "runtime");
  writeFileSync(join(seeded.dir, "01-triage.md"), triageWith("PROCEED"));
  assert.deepEqual((await runCheck(seeded.env, "01")).out.slice(-2), ["recorded: termination cleared", `recorded: slug ${SLUG}`]);
  assert.equal(stateOf(seeded).termination, undefined);
});

test("a termination written by hand is never lifted by a PROCEED re-triage", async (t) => {
  const seeded = seedRun(t, "keep-hand-termination", { fixture: { type: "bug/error" }, texts: { "01-triage.md": triageWith("PROCEED") } });
  recordTermination({ projectId: seeded.projectId, slug: SLUG, phase: "triage", reason: "NEEDS-CLARIFICATION: by hand", env: seeded.env });
  const { out } = await runCheck(seeded.env, "01");
  assert.ok(!out.includes("recorded: termination cleared"), out.join("\n"));
  assert.equal(stateOf(seeded).termination.reason, "NEEDS-CLARIFICATION: by hand");
});

test("check 03 prints no QA line, whatever always-gate class and 🔴 risks the plan declares", () => {
  const plan = "## Implementation plan\n- x\n\n**Always-gate class:** yes — rows change\n\n## Assumptions\n- a (unverified)\n\n## Pre-mortem\n- b\n\n## Identified risks\n- [R1] 🔴 a\n- [R2] 🔴 b\n";
  const result = evaluateCheck({ check: "03", texts: { "03-plan.md": plan }, state: { type: "feature/refactor" } });
  assert.deepEqual(result.lines, ["OK"]);
  assert.equal(result.qaMode, null);
  assert.equal(result.completes, true);
});

// ---- The QA triage stage: `run check 05 --stage triage`.

const TRIAGE_ARGS = ["--stage", "triage"];

// A triage round of the given number, from its classification, its new risk and its QA mode line.
function triageRound(number, { kinds = "- copy/docs: README.md", risk = "none", mode = "skip — only text changed." } = {}) {
  return `## Round ${number}\nsource: qa-triage\n\n## Diff classification\n${kinds}\n\n## New risk\n${risk}\n\n## QA mode\n${mode}\n`;
}

test("a skip records the mode and one SKIPPED qa entry, and a second check leaves both untouched", async (t) => {
  const seeded = seedRun(t, "triage-skip-record", readFixture("qa-triage-skip"));
  const why = "only documentation text changed, with no runtime effect.";
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const first = stateOf(seeded);
  assert.deepEqual({ ...first.qaMode, at: null }, { mode: "skip", reason: why, at: null });
  assert.equal(typeof first.qaMode.at, "string");
  assert.deepEqual({ ...first.phases[0], at: null }, { phase: "qa", at: null, artifact: "05-qa.md", verdict: "SKIPPED", note: why, reason: `QA skipped: ${why}`, by: "runtime", claim: { attempt: 0, session: null }, attempt: 0, model: "sonnet" });
  await nextMillisecond();
  const again = await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.deepEqual(again.out.slice(-2), ["recorded: phase_done qa SKIPPED (already)", "recorded: qa_mode skip (already)"]);
  const second = stateOf(seeded);
  assert.deepEqual(second.qaMode, first.qaMode);
  assert.deepEqual(second.phases, first.phases);
});

test("a skip whose mode write was lost records it on the next check, without a second qa entry", async (t) => {
  const seeded = seedRun(t, "triage-skip-partial", readFixture("qa-triage-skip"));
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const path = join(seeded.dir, "state.json");
  const { qaMode: _lost, ...withoutMode } = stateOf(seeded);
  writeFileSync(path, JSON.stringify(withoutMode));
  const { out } = await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.ok(out.includes("recorded: qa_mode skip"), out.join("\n"));
  assert.equal(stateOf(seeded).phases.length, 1);
});

test("a lite or full mode records the mode and no phase, so `run check 05` keeps its single qa entry", async (t) => {
  for (const [name, mode] of [["qa-triage-lite-logic", "lite"], ["qa-triage-full-migration", "full"]]) {
    const seeded = seedRun(t, name, readFixture(name));
    await runCheck(seeded.env, "05", TRIAGE_ARGS);
    const state = stateOf(seeded);
    assert.equal(state.qaMode.mode, mode);
    assert.equal(state.phases, undefined);
  }
});

test("a refused triage records neither a mode nor a phase", async (t) => {
  for (const name of ["qa-triage-bad-word", "qa-triage-no-round"]) {
    const seeded = seedRun(t, name, readFixture(name));
    const { out } = await runCheck(seeded.env, "05", TRIAGE_ARGS);
    assert.equal(out.length, 1, out.join("\n"));
    const state = stateOf(seeded);
    assert.equal(state.qaMode, undefined);
    assert.equal(state.phases, undefined);
    assert.equal(state.checks["05-triage"].completed, false);
  }
});

test("a reworded relaunch of a skip is the same decision: it keeps the one entry and the first reason", async (t) => {
  const seeded = seedRun(t, "triage-reworded", { fixture: {}, texts: { "05-qa.md": triageRound(1) } });
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const first = stateOf(seeded);
  assert.equal(first.phases.length, 1);
  writeFileSync(join(seeded.dir, "05-qa.md"), triageRound(1, { mode: "skip — docs only, nothing executes." }));
  const { out } = await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.deepEqual(out.slice(-2), ["recorded: phase_done qa SKIPPED (already)", "recorded: qa_mode skip (already)"]);
  assert.deepEqual(stateOf(seeded).phases, first.phases);
  assert.deepEqual(stateOf(seeded).qaMode, first.qaMode);
});

test("a skip refused or moved in between stays one entry when the skip comes back", async (t) => {
  const seeded = seedRun(t, "triage-back", { fixture: {}, texts: { "05-qa.md": triageRound(1) } });
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  for (const mode of ["maybe — unsure.", "lite — one small file."]) {
    writeFileSync(join(seeded.dir, "05-qa.md"), triageRound(1, { mode }));
    await runCheck(seeded.env, "05", TRIAGE_ARGS);
    writeFileSync(join(seeded.dir, "05-qa.md"), triageRound(1));
    await runCheck(seeded.env, "05", TRIAGE_ARGS);
    assert.equal(stateOf(seeded).phases.length, 1, mode);
    assert.equal(stateOf(seeded).qaMode.mode, "skip", mode);
  }
});

test("a skip after a QA that ran is a new entry: only the runtime's own last SKIPPED is repeated", async (t) => {
  const seeded = seedRun(t, "triage-after-qa", { fixture: {}, texts: { "05-qa.md": triageRound(1) } });
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const written = recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase: "qa", verdict: "APPROVED", by: "orchestrator", env: seeded.env });
  assert.equal(written.status, "written");
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.deepEqual(stateOf(seeded).phases.map((entry) => entry.verdict), ["SKIPPED", "APPROVED", "SKIPPED"]);
});

test("a skip moved to lite or full drops the runtime's skip from the facts, so the orchestrator owes the QA; a skip that stands stays", async (t) => {
  const seeded = seedRun(t, "triage-owed", { fixture: {}, texts: { "05-qa.md": triageRound(1) } });
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const target = { projectId: seeded.projectId, slug: SLUG, env: seeded.env };
  assert.equal(recordPhaseDone({ ...target, phase: "implementation", verdict: "fixed" }).status, "written");
  assert.deepEqual(stateOf(seeded).phases.map((entry) => entry.verdict), ["SKIPPED", "fixed"]);
  for (const mode of ["lite — one small file.", "full — the retry path changed."]) {
    writeFileSync(join(seeded.dir, "05-qa.md"), triageRound(1, { kinds: "- logic: src/a.mjs", risk: "- the retry path", mode }));
    await runCheck(seeded.env, "05", TRIAGE_ARGS);
    assert.deepEqual(stateOf(seeded).phases.map((entry) => entry.phase), ["implementation"], mode);
  }
});

test("a lite or full decision drops the skip past a verification recorded before it", async (t) => {
  for (const mode of ["lite — one small file.", "full — the retry path changed."]) {
    const seeded = seedRun(t, `triage-owed-past-${mode.slice(0, 4)}`, { fixture: {}, texts: { "05-qa.md": triageRound(1) } });
    await runCheck(seeded.env, "05", TRIAGE_ARGS);
    const target = { projectId: seeded.projectId, slug: SLUG, env: seeded.env };
    assert.equal(recordPhaseDone({ ...target, phase: "implementation", verdict: "fixed" }).status, "written");
    assert.equal(recordPhaseDone({ ...target, phase: "verification", verdict: "FAILED" }).status, "written");
    await nextMillisecond();
    writeFileSync(join(seeded.dir, "05-qa.md"), triageRound(1, { kinds: "- logic: src/a.mjs", risk: "- the retry path", mode }));
    await runCheck(seeded.env, "05", TRIAGE_ARGS);
    assert.deepEqual(stateOf(seeded).phases.map((entry) => entry.phase), ["implementation", "verification"], mode);
  }
});

test("a mode decided after a QA that ran keeps that QA's entry, only the runtime's skip goes", async (t) => {
  const seeded = seedRun(t, "triage-after-real-qa", { fixture: {}, texts: { "05-qa.md": triageRound(1, { kinds: "- logic: src/a.mjs", mode: "lite — one small file." }) } });
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const target = { projectId: seeded.projectId, slug: SLUG, env: seeded.env };
  assert.equal(recordPhaseDone({ ...target, phase: "qa", verdict: "APPROVED", by: "orchestrator" }).status, "written");
  await nextMillisecond();
  writeFileSync(join(seeded.dir, "05-qa.md"), triageRound(1, { kinds: "- logic: src/a.mjs", risk: "- the retry path", mode: "full — the retry path changed." }));
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.deepEqual(stateOf(seeded).phases.map((entry) => entry.verdict), ["APPROVED"]);
});

test("a qa SKIPPED nobody decided stays on the state when a lite or full decision lands", async (t) => {
  const seeded = seedRun(t, "triage-forged-stays", { fixture: {}, texts: { "05-qa.md": triageRound(1, { kinds: "- logic: src/a.mjs", mode: "lite — one small file." }) } });
  const target = { projectId: seeded.projectId, slug: SLUG, env: seeded.env };
  assert.equal(recordPhaseDone({ ...target, phase: "qa", verdict: "SKIPPED", by: "orchestrator" }).status, "written");
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.deepEqual(stateOf(seeded).phases.map((entry) => entry.by), ["orchestrator"]);
});

test("a stale skip beside the same lite or full mode goes on the next check, instead of answering already", async (t) => {
  const seeded = seedRun(t, "triage-stale-same-mode", { fixture: {}, texts: { "05-qa.md": triageRound(1) } });
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const state = stateOf(seeded);
  writeFileSync(join(seeded.dir, "state.json"), JSON.stringify({ ...state, qaMode: { mode: "lite", reason: "the skip's mode write was lost.", at: state.qaMode.at } }));
  writeFileSync(join(seeded.dir, "05-qa.md"), triageRound(1, { kinds: "- logic: src/a.mjs", mode: "lite — one small file." }));
  const first = await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.ok(first.out.includes("recorded: qa_mode lite"), first.out.join("\n"));
  assert.deepEqual(stateOf(seeded).phases, []);
  const again = await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.ok(again.out.includes("recorded: qa_mode lite (already)"), again.out.join("\n"));
});

test("a triage round relaunched after a refusal is the one read, and its entry says why the QA was skipped", async (t) => {
  const refused = triageRound(1, { mode: "maybe — unsure." });
  const seeded = seedRun(t, "triage-relaunch", { fixture: {}, texts: { "05-qa.md": refused } });
  assert.ok((await runCheck(seeded.env, "05", TRIAGE_ARGS)).out[0].startsWith("MISSING: "));
  writeFileSync(join(seeded.dir, "05-qa.md"), `${refused}\n${triageRound(2)}`);
  const { out } = await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.equal(out[1], "QA-MODE: skip — only text changed.");
  assert.equal(stateOf(seeded).phases[0].reason, "QA skipped: only text changed.");
});

test("a triage round after a lite round is read as is and the artifact is not written", async (t) => {
  const fixture = readFixture("qa-triage-after-lite-round");
  const seeded = seedRun(t, "triage-resume", fixture);
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.equal(readFileSync(join(seeded.dir, "05-qa.md"), "utf8"), fixture.texts["05-qa.md"]);
});

test("a fence left open in a later round is closed and reported, and the triage round still answers", async (t) => {
  const open = `${triageRound(1)}\n## Round 2\n\`\`\`text\nunclosed\n`;
  const seeded = seedRun(t, "triage-open-fence", { fixture: {}, texts: { "05-qa.md": open } });
  const { out } = await runCheck(seeded.env, "05", TRIAGE_ARGS);
  assert.equal(out[0], "OK");
  assert.match(out[1], /^REPAIRED: the code fence of round 2 /);
  assert.equal(out[2], "QA-MODE: skip — only text changed.");
});

test("a triage round as the last one needs no consolidation, and plain check 05 answers MISSING on it", async (t) => {
  const seeded = seedRun(t, "triage-plain-05", readFixture("qa-triage-skip"));
  const before = readFileSync(join(seeded.dir, "05-qa.md"), "utf8");
  const { out } = await runCheck(seeded.env, "05");
  assert.ok(out[0].startsWith("MISSING: "), out.join("\n"));
  assert.equal(readFileSync(join(seeded.dir, "05-qa.md"), "utf8"), before);
});

test("a triage round before the analyst stays out of the consolidation of a full QA", async (t) => {
  const seeded = seedRun(t, "qa-full-after-triage", readFixture("qa-full-after-triage"));
  await runCheck(seeded.env, "05");
  const written = readFileSync(join(seeded.dir, "05-qa.md"), "utf8");
  const consolidated = written.slice(written.indexOf("## Round 5\n"));
  assert.equal(consolidated.split("\n")[1], "source: runtime consolidation · rounds 2, 3, 4");
  assert.equal(consolidated.includes("## Diff classification"), false, consolidated);
});

test("a skipped QA is recorded as a qa entry the facts list last", async (t) => {
  const seeded = seedRun(t, "triage-skip-resume", readFixture("qa-triage-skip"));
  for (const phase of ["triage", "explore", "architecture", "implementation"]) recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase, env: seeded.env });
  await runCheck(seeded.env, "05", TRIAGE_ARGS);
  const last = stateOf(seeded).phases.at(-1);
  assert.deepEqual([last.phase, last.verdict], ["qa", "SKIPPED"]);
});

test("`run_set` refuses the QA mode, whole or dotted, and `--stage` accepts no inherited name", async (t) => {
  const seeded = seedRun(t, "qa-mode-run-set", readFixture("qa-triage-skip"));
  for (const name of ["qaMode", "qaMode.mode"]) {
    const refused = recordRunFields({ projectId: seeded.projectId, slug: SLUG, fields: { [name]: "skip" }, env: seeded.env });
    assert.deepEqual(refused, { status: "kept", path: null, reason: "`qaMode` is written by the runtime only" }, name);
  }
  const inherited = await runCheck(seeded.env, "05", ["--stage", "constructor"]);
  assert.equal(inherited.code, 1);
  assert.match(inherited.err.join("\n"), /unknown stage `constructor` of check `05`; the stages are `05 --stage analyst\|triage`/);
  assert.throws(() => evaluateCheck({ check: "05", stage: "constructor", texts: {} }), /unknown stage/);
  assert.throws(() => evaluateCheck({ check: "06", stage: "triage", texts: {} }), /unknown stage/);
});

test("the round the skip fixture proves is the one the lane asks for and the qa-guardian method writes", () => {
  const launch = phasePrompts().blocks["qa-triage"].join("\n");
  const method = readFileSync(new URL("../plugin/agents/qa-guardian.md", import.meta.url), "utf8");
  const round = readFixture("qa-triage-skip").texts["05-qa.md"].split("\n").slice(1);
  assert.ok(round.includes("source: qa-triage") && launch.includes("`source: qa-triage`"), "the qa-triage launch no longer asks for the round's source line");
  for (const heading of round.filter((text) => text.startsWith("## "))) assert.ok(method.includes(`- \`${heading}\`: `), `the qa-guardian method no longer defines ${heading}`);
});

test("a `###` confirmation heading the check announces is the section the gate notice composes", async (t) => {
  const seeded = seedRun(t, "confirm-level-3", readFixture("confirm-heading-level-3"));
  assert.ok((await runCheck(seeded.env, "03")).out.includes("CONFIRM: requires-user-confirmation — approve fixing the retry path only?"));
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

test("a plan with a filled question records its phase and no termination, composes its notice, and the answer is recorded after the architecture", async (t) => {
  const seeded = seedRun(t, "confirm-pause", readFixture("confirm"));
  for (const phase of ["triage", "explore"]) recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase, env: seeded.env });
  const { out } = await runCheck(seeded.env, "03");
  assert.ok(out.includes("CONFIRM: requires-user-confirmation — approve fixing the retry path only?"), out.join("\n"));
  assert.ok(out.some((line) => line.startsWith("recorded: phase_done architecture")), out.join("\n"));
  assert.equal(stateOf(seeded).termination, undefined);
  const confirmation = composeGateNotice({ runDir: seeded.dir, fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" } });
  assert.match(confirmation, /approve fixing the retry path only\?/);
  openDb(seeded.env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(jobIdOf(seeded));
  await applyRetry({ id: jobIdOf(seeded), note: "yes, the retry path only", env: seeded.env });
  assert.deepEqual(stateOf(seeded).answers.map((entry) => entry.text), ["yes, the retry path only"]);
  assert.equal(stateOf(seeded).phases.at(-1).phase, "architecture");
});

test("a terminal triage with a partial Brief still terminates", async (t) => {
  const partial = "## Brief\n**Affected area:** src/a.mjs\n**Commit type:**\n\n";
  const seeded = seedRun(t, "terminal-partial-brief", { fixture: { type: "bug/error" }, texts: { "01-triage.md": triageWith("NOT-REPRODUCIBLE", undefined, partial) } });
  const { out } = await runCheck(seeded.env, "01");
  assert.ok(!out.some((line) => line.startsWith("GATE: ")), out.join("\n"));
  assert.ok(out.includes("recorded: run_terminate triage NOT-REPRODUCIBLE"), out.join("\n"));
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
  assert.match(brief, /^\*\*Affected area:\*\* src\/a\.mjs$/m);
  assert.match(brief, /^\*\*Objective:\*\* list the jobs$/m);
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

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");

test("the plan template asks one filled question, records decisions, and no architect text manufactures the confirmation", () => {
  const agent = readFileSync(join(PLUGIN, "agents", "architect.md"), "utf8");
  for (const part of ["**Question:**", "**Options:**", "**On go ahead:**", "## Decisions taken"]) assert.ok(agent.includes(part), `the plan template lost ${part}`);
  for (const gone of ["source=", "When to stop and ask", "requires `## Requires user confirmation`", "stop and ask", "is a gate", "→ gate"]) assert.equal(agent.includes(gone), false, `the architect still says ${gone}`);
  for (const part of ["changes observable behavior, data or scope", "the request does not", "costly to undo"]) assert.ok(agent.replace(/\s+/g, " ").includes(part), `the agent lost the rule part ${part}`);
});

test("`run_set` refuses the digest of the paused question", async (t) => {
  const seeded = seedRun(t, "digest-run-set", readFixture("confirm"));
  const refused = recordRunFields({ projectId: seeded.projectId, slug: SLUG, fields: { gateQuestionDigest: "forged" }, env: seeded.env });
  assert.deepEqual(refused, { status: "kept", path: null, reason: "`gateQuestionDigest` is written by the runtime only" });
});

test("the job prompt text reads the job's row, and answers null outside a job or for an unknown job", async (t) => {
  const seeded = seedRun(t, "job-prompt", { fixture: { prompt: "list the active jobs", operatorNote: "keep  the \"raw\" note" }, texts: {} });
  const own = { jobId: Number(seeded.env.NIGHTQUEUE_JOB_ID) };
  assert.equal(await jobPromptText(own, seeded.env), 'list the active jobs\n\nkeep  the "raw" note');
  for (const other of [{ jobId: null }, { jobId: 99999 }]) {
    assert.equal(await jobPromptText(other, seeded.env), null);
  }
});

test("a paused question reads as answered on the resumed check, reformatted too, and a new question pauses again", async (t) => {
  const seeded = seedRun(t, "answered-end-to-end", readFixture("confirm"));
  const { projectId, env, dir } = seeded;
  const pause = "CONFIRM: requires-user-confirmation — approve fixing the retry path only?";
  const planPath = join(dir, "03-plan.md");
  const plan = readFileSync(planPath, "utf8");
  assert.ok((await runCheck(env, "03")).out.includes(pause));
  const questionDigest = gateDigestOf({ runDir: dir, notice: "## Requires user confirmation\n\n**Question:** approve fixing the retry path only?\n\n**Options:** (A)" });
  assert.equal(recordOutcome({ projectId, slug: SLUG, status: "gate", notice: "asked", questionDigest, env }).status, "written");
  openDb(env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(jobIdOf(seeded));
  await applyRetry({ id: jobIdOf(seeded), note: "go ahead", env });
  assert.equal(stateOf(seeded).gateQuestionDigest, questionDigest);

  const answered = await runCheck(env, "03");
  const answer = stateOf(seeded).answers.at(-1);
  assert.equal(answer.text, "go ahead");
  assert.ok(answered.out.includes(`CONFIRM: answered (${answer.at})`), answered.out.join("\n"));
  assert.ok(!answered.out.includes(pause), answered.out.join("\n"));
  assert.equal(stateOf(seeded).checks["03"].line, "OK");

  writeFileSync(planPath, plan.replace("approve fixing the retry path only?", "**Approve**  fixing   the `retry` path only?"));
  assert.ok((await runCheck(env, "03")).out.includes(`CONFIRM: answered (${answer.at})`));

  writeFileSync(planPath, plan.replace("approve fixing the retry path only?", "approve fixing every path?"));
  assert.ok((await runCheck(env, "03")).out.includes("CONFIRM: requires-user-confirmation — approve fixing every path?"));
});

test("a feature job whose request has gaps passes triage and plan with no pause when the architect decides them", async (t) => {
  const seeded = seedRun(t, "gaps-decided", readFixture("decisions-taken-no-question"));
  const triage = await runCheck(seeded.env, "01");
  assert.ok(triage.out.includes("VERDICT: PROCEED"), triage.out.join("\n"));
  const plan = await runCheck(seeded.env, "03");
  assert.equal(plan.out[0], "OK");
  assert.equal(plan.out.some((line) => /^(CONFIRM|GATE|OPEN):/.test(line)), false, plan.out.join("\n"));
  const state = stateOf(seeded);
  assert.deepEqual(state.phases.map((entry) => entry.phase), ["triage", "architecture"]);
  assert.equal(state.outcome, undefined);
  assert.equal(state.gateQuestionDigest, undefined);
});

test("a pause that does not show the plan's filled question records no digest", (t) => {
  const seeded = seedRun(t, "no-digest", readFixture("confirm-question-none"));
  assert.equal(gateDigestOf({ runDir: seeded.dir, notice: "## Requires user confirmation\n\n**Question:** none" }), null);
  assert.equal(gateDigestOf({ runDir: seeded.dir }), null);
  const filled = seedRun(t, "other-artifact", readFixture("confirm"));
  assert.equal(gateDigestOf({ runDir: filled.dir, notice: "## Requires user confirmation\n\n## Runtime verdict\nNEEDS-DEVICE" }), null);
  assert.equal(gateDigestOf({ runDir: filled.dir, notice: "Do you approve only the retry fix?" }), null, "a paraphrase");
  assert.equal(gateDigestOf({ runDir: join(filled.dir, "absent"), notice: "approve fixing the retry path only?" }), null, "no plan to read");
  recordOutcome({ projectId: filled.projectId, slug: SLUG, status: "gate", notice: "asked", env: filled.env });
  assert.equal("gateQuestionDigest" in stateOf(filled), false);
});

test("a pause showing the plan's question records its digest, whatever text surrounds it", (t) => {
  const { dir } = seedRun(t, "digest-shapes", readFixture("confirm"));
  const question = "**Question:**\n- Keep the old\n- column?\n";
  writeFileSync(join(dir, "03-plan.md"), `## Implementation plan\n- x\n\n## Requires user confirmation\n${question}`);
  const notices = [
    `## Requires user confirmation\n${question}\n\nAnswer with: nightqueue queue retry J-1 --note "<your answer>"`,
    "## Requires user confirmation\n\nKeep the old column?",
    "Before going on: KEEP   the `old` column? Reply on the job.",
  ];
  for (const notice of notices) assert.equal(gateDigestOf({ runDir: dir, notice }), questionDigest("keep the old column?"), notice);
});
