import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDir } from "../src/config/paths.mjs";
import { run } from "../src/cli/index.mjs";
import { phasePrompt } from "../src/mcp/phase-prompt.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob, getJob } from "../src/memory/jobs.mjs";
import { evaluateCheck, qaModeOf, quotedSourceOf } from "../src/queue/check-contract.mjs";
import { composeGateNotice } from "../src/queue/gate-notice.mjs";
import { jobPromptText } from "../src/queue/job-prompt.mjs";
import { nextRound } from "../src/queue/phase-artifacts.mjs";
import { PR_FOOTER, publishedBodyFile } from "../src/queue/pr-footer.mjs";
import { decideResume, readRunState } from "../src/queue/resume.mjs";
import { applyRetry } from "../src/queue/retry.mjs";
import { provisionalSlug } from "../src/queue/run-slug.mjs";
import { recordPhaseDone, recordRunFields, recordTermination } from "../src/queue/run-state.mjs";
import { coverageRecordLine } from "../src/queue/usage-coverage-record.mjs";
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

// A job bound to the run slug, with the fixture's prompt and operator note, its files in its run directory and its Type recorded.
function seedRun(t, name, { fixture, texts }) {
  const env = makeHome(t, `check-contract-${name}`);
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: fixture.prompt ?? "check the contract" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  if (fixture.operatorNote) openDb(env).prepare("UPDATE jobs SET operator_note = ? WHERE id = ?").run(fixture.operatorNote, id);
  if (fixture.type) recordRunFields({ projectId, slug: SLUG, fields: { type: fixture.type }, env });
  const dir = runDir(projectId, SLUG, env);
  mkdirSync(dir, { recursive: true });
  for (const [file, body] of Object.entries(texts)) writeFileSync(join(dir, file), body);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(id) }, projectId, dir };
}

// Runs `nightqueue run check` in this process, capturing what it printed.
async function runCheck(env, check, args = []) {
  const out = [];
  const err = [];
  const code = await run(["run", "check", check, ...args], { env, out: (line) => out.push(line), err: (line) => err.push(line), stdout: { write: () => {} } });
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
    const { code, out, err } = await runCheck(env, fixture.fixture.check, fixture.fixture.args ?? []);
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
  const result = evaluateCheck({ check: "07", texts: gated.texts, state: { type: "bug/error" } });
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

test("the usage coverage counts read the leading integer of each field and gate a field with none", () => {
  const { texts } = readFixture("usage-coverage-template-wording");
  const counts = (fields) => {
    const qa = texts["05-qa.md"].replace("1 lines of the plan · 1 own scenarios", fields);
    const { lines } = evaluateCheck({ check: "05", texts: { ...texts, "05-qa.md": qa }, state: { type: "feature/refactor" } });
    return lines.find((line) => line.startsWith("GATE: usage-coverage-nm-mismatch — "))?.slice("GATE: usage-coverage-nm-mismatch — ".length) ?? null;
  };
  for (const fields of ["1 · 1", "N=1 · M=1", "n = 1 · m=1", "**1** lines of the plan · `1` own scenarios", "1 lines of the plan (1 in the diff) · 1 own scenarios", "1 linhas do plano · 1 cenários próprios"]) {
    assert.equal(counts(fields), null, fields);
  }
  assert.equal(counts("1 lines of the plan · 2 own scenarios"), "N=1/1 M=2/1");
  assert.equal(counts("1.5 · 1"), 'N=(unparsed: "1.5")/1 M=1/1');
  assert.equal(counts("1,5 · 1"), 'N=(unparsed: "1,5")/1 M=1/1');
  assert.equal(counts("1lines · 1"), 'N=(unparsed: "1lines")/1 M=1/1');
  assert.equal(counts("one · 1"), 'N=(unparsed: "one")/1 M=1/1');
  assert.equal(counts("M=1 · N=1"), 'N=(unparsed: "M=1")/1 M=(unparsed: "N=1")/1');
  assert.equal(counts("1 · "), "N=1/1 M=(empty)/1");
  for (const ambiguous of ["1/2", "1 / 2", "1-2", "1 – 2", "1 of 3", "1 or 2", "1 to 2", "1 de 3", "N=1 of 5"]) {
    assert.equal(counts(`${ambiguous} · 1`), `N=(unparsed: "${ambiguous}")/1 M=1/1`, ambiguous);
  }
  assert.equal(counts("1 · 1 of 3"), 'N=1/1 M=(unparsed: "1 of 3")/1');
});

test("the symptom coverage N reads the leading integer of its field and gates a wrong or unparsed count", () => {
  const { texts } = readFixture("symptom-coverage-n-mismatch");
  const nGate = (n) => {
    const qa = texts["05-qa.md"].replace("Symptom coverage: 3 ·", `Symptom coverage: ${n} ·`);
    const { lines } = evaluateCheck({ check: "05", texts: { ...texts, "05-qa.md": qa }, state: { type: "bug/error" } });
    return lines.find((line) => line.startsWith("GATE: symptom-coverage-n-mismatch — "))?.slice("GATE: symptom-coverage-n-mismatch — ".length) ?? null;
  };
  for (const n of ["2", "2 vectors of the plan's table", "**2**", "`2`", "N=2", "2 (1 in the diff)"]) {
    assert.equal(nGate(n), null, n);
  }
  for (const n of ["3 vectors of the plan's table", "two vectors", "2/2", "2 of 2", "2.0", "2vectors", "N: 2"]) {
    assert.equal(nGate(n), `N=${n} plan=2`, n);
  }
});

test("the filled symptom coverage example of the QA report template passes the check", () => {
  const { texts } = readFixture("symptom-coverage-n-mismatch");
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "skills", "resolve", "references", "deliverables", "qa-report.md"), "utf8");
  const example = /`(Symptom coverage: [^`]*)`/.exec(template)?.[1];
  assert.ok(example, "qa-report.md has no `Symptom coverage:` example");
  assert.equal(example.split(" · ")[0], "Symptom coverage: <N>");
  const filled = example.replace("<N>", "2").replace("<command/criterion of your re-enumeration>", '`grep -rn "x" src`').replace("<file:line | none>", "none");
  assert.ok(!filled.includes("<"), `unfilled placeholder in ${filled}`);
  const qa = texts["05-qa.md"].replace(/^Symptom coverage: .*$/m, () => filled);
  const { lines } = evaluateCheck({ check: "05", texts: { ...texts, "05-qa.md": qa }, state: { type: "bug/error" } });
  assert.deepEqual(lines.filter((line) => line.startsWith("GATE: symptom-coverage-")), []);
});

test("the held-on-pipeline gate counts HELD only set off from the prose", () => {
  const { texts } = readFixture("usage-coverage-held-on-pipeline");
  const gates = (line) => {
    const qa = texts["05-qa.md"].replace("- R2 HELD: export csv still lists archived rows", line);
    const { lines } = evaluateCheck({ check: "05", texts: { ...texts, "05-qa.md": qa }, state: { type: "feature/refactor" } });
    return lines.some((entry) => entry.startsWith("GATE: usage-coverage-held-on-pipeline — "));
  };
  const verdicts = [
    "- R2 HELD: export csv still lists archived rows",
    "- export csv (source=pipeline): HELD. The button stays enabled",
    "- Cancel delivery in progress (source=pipeline): HELD. The register button stays enabled",
    "- R2 (mitigation: x) HELD: export csv",
    "- R2 HELD (by reading): export csv",
    "- export csv: checked. HELD.",
    "- export csv R2 HELD",
    "- R2 **HELD**: export csv",
    "- R2 no-op HELD: export csv",
    "- export csv — HELD by reading",
    "- Cancel delivery in progress (source=pipeline) HELD. The register button stays enabled",
    "- export csv (source=pipeline) → HELD (verified by reading the guard)",
    "- export csv (source=pipeline) - HELD, archived rows still listed",
    "- R2: export csv (source=pipeline) HELD by reading",
    "- R2 HELD by reading: export csv (source=pipeline)",
    "- export csv (source=pipeline) => HELD; the button stays enabled",
    "- export csv (source=pipeline): 🟢 HELD for github-only configs",
    "- R3 export csv — 🟡 HELD na unidade",
    "- [R10] export csv — analytically HELD (the mechanism is",
    "- [R7] export csv — confirmed real, HELD as low impact.",
    "- R1–R9 HELD analytically: export csv",
    "- export csv: PARTIALLY HELD.",
    "- export csv (source=pipeline) HELD",
    "- export csv: not HELD in round 1; now HELD",
    "- R2 run HELD: export csv",
    "- export csv: BROKE for archived rows; HELD for active rows",
  ];
  for (const line of verdicts) assert.equal(gates(line), true, line);
  const notVerdicts = [
    "- export csv (`source=pipeline`): archived rows stay listed; the decision remains unconfirmed by the operator. Not HELD, not a break.",
    "- export csv (source=pipeline): HELD. The decision remains unconfirmed by the operator",
    "- export csv: not HELD",
    "- export csv: isn't HELD",
    "- export csv: non-HELD",
    "- export csv: the `HELD` word",
    '- export csv: "HELD"',
    "- export csv is HELD by the guard and more",
    "- R2 UPHELD: export csv",
    "- export csv: is not HELD",
    "- export csv: never HELD",
    "- R1 (mid-prose HELD no longer gates): BROKE on export csv",
    "- export csv was HELD in round 1, now BROKE",
    "- Plan line 8 (export csv, source=pipeline): Not marked HELD per the rule on pipeline items",
  ];
  for (const line of notVerdicts) assert.equal(gates(line), false, line);
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
  await runCheck(gatedRun.env, "07");
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

test("a completed check 05 --stage analyst records the QA stage A marker and no phase", async (t) => {
  const report = "## Round 1\n## Proven breaks\nNone\n\n## Break hypotheses\n- H1\n\n## Test recipe\nnode --test\n\n## Validated risks\n- R1\n\n## Invalidated assumptions\nNone\n\n## Generated PoCs\nNone — the provers write them\n\n## Verdict\nAPPROVED\n";
  const seeded = seedRun(t, "effects-qa-stage-a", { fixture: {}, texts: { "05-qa.md": report } });
  const { out } = await runCheck(seeded.env, "05", ["--stage", "analyst"]);
  assert.deepEqual(out, ["OK", "VERDICT: APPROVED", "QA-STAGE: provers", "recorded: qa_stage_a APPROVED"]);
  const state = stateOf(seeded);
  assert.deepEqual([state.qaStageA.artifact, state.qaStageA.verdict], ["05-qa.md", "APPROVED"]);
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

test("PoC qa-r4-fence-stale-round vector a (H12): the check closes the open fence and refuses the fenced round, and the lane's appended round converges", async (t) => {
  const fence = "```";
  const open = `## Round 1\n## Checks run\n- npm test\n\n## Verification: FAILED\n\n${fence}text\nunclosed\n\n## Round 2\n## Checks run\n- npm test\n\n## Verification: PASSED\n`;
  const seeded = seedRun(t, "fence-stale-round", { fixture: {}, texts: { "06-verification.md": open } });
  const path = join(seeded.dir, "06-verification.md");
  const first = await runCheck(seeded.env, "06");
  assert.ok(first.out[0].startsWith("MISSING: line 10 of 06-verification.md is a column-0 `## Round 2` inside the code fence opened at line 7 (round 1): append a new `## Round 2`"), first.out.join("\n"));
  assert.equal(first.out[1], `REPAIRED: the code fence of round 1 opened at line 7 of 06-verification.md never closed; the runtime appended \`${fence}\` at line 15`);
  assert.ok(!first.out.some((line) => line.startsWith("VERDICT:")), first.out.join("\n"));
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
  assert.deepEqual(evaluateCheck({ check: "07", texts: { "07-runtime.md": runtime } }).lines, ["OK", "VERDICT: CONFIRMED"]);
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
  for (const check of ["05", "06", "07"]) assert.equal(evaluateCheck({ check, texts }).lines.some((line) => line.startsWith("QA: ")), false, check);
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

test("a second-round INVALIDATED withholds qa, pauses at a gate from `## Validated risks`, and the answered run resumes at qa", async (t) => {
  const seeded = seedRun(t, "invalidated-gate", readFixture("invalidated-second-round"));
  for (const phase of ["triage", "explore", "architecture", "implementation"]) recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase, env: seeded.env });
  const { out } = await runCheck(seeded.env, "05");
  assert.equal(out.filter((line) => line.startsWith("INVALIDATED: ")).length, 3, out.join("\n"));
  assert.ok(!out.some((line) => line.startsWith("recorded: phase_done qa")), out.join("\n"));
  assert.equal(out.at(-1), `recorded: none (${out.find((line) => line.startsWith("INVALIDATED: [H6]"))})`);
  assert.equal(stateOf(seeded).termination, undefined);
  const notice = composeGateNotice({ runDir: seeded.dir, fromArtifact: { file: "05-qa.md", section: "## Validated risks" } });
  assert.match(notice, /R1 UPHELD by test\/list\.test\.mjs/);
  openDb(seeded.env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(jobIdOf(seeded));
  await applyRetry({ id: jobIdOf(seeded), note: "(b) ship as is", env: seeded.env });
  const decision = decideResume({ state: stateOf(seeded) });
  assert.deepEqual([decision.resume, decision.fromPhase], [true, "qa"]);
});

test("a J-258 coverage gate with an open decision records no phase and no termination, composes its notice, and the answered run resumes at architecture", async (t) => {
  const seeded = seedRun(t, "coverage-gate-pause", readFixture("coverage-split-status-confirm"));
  for (const phase of ["triage", "explore"]) recordPhaseDone({ projectId: seeded.projectId, slug: SLUG, phase, env: seeded.env });
  const { out } = await runCheck(seeded.env, "03");
  for (const prefix of ["GATE: coverage-vector-no-reason — V14", "GATE: coverage-enumeration-no-method — ", "CONFIRM: requires-user-confirmation"]) {
    assert.ok(out.some((line) => line.startsWith(prefix)), `check 03 no longer prints ${prefix}: ${out.join("\n")}`);
  }
  assert.ok(!out.some((line) => line.startsWith("recorded: phase_done architecture")), out.join("\n"));
  assert.equal(stateOf(seeded).termination, undefined);
  const confirmation = composeGateNotice({ runDir: seeded.dir, fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" } });
  assert.match(confirmation, /should the escape apply to every git read \(A\)/);
  const coverage = composeGateNotice({ runDir: seeded.dir, fromArtifact: { file: "03-plan.md", section: "## Symptom coverage" } });
  assert.match(coverage, /covered under \(A\) · not-covered under \(B\)/);
  openDb(seeded.env).prepare("UPDATE jobs SET status = 'gate' WHERE id = ?").run(jobIdOf(seeded));
  await applyRetry({ id: jobIdOf(seeded), note: "(A) every git read", env: seeded.env });
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

const CLEARED = "usage-coverage-cond-2-cleared";
const COND_2_GATE = "GATE: usage-coverage-cond-2 — **Always-gate class:** yes — the queries change which rows they return";
const CLEARED_QUOTES = ["the list view shows only active jobs", "keeps the archived rows out of the export"];
const COVERAGE_LINE = 'data access changed, covered by the quoted decisions: "the list view shows only active jobs"; "keeps the archived rows out of the export"';
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "plugin");

// The cond-2 answer of the cleared fixture's plan, one text of it optionally replaced, against the given job prompt.
function cond2Answer({ prompt, from = null, to = "" }) {
  const { texts } = readFixture(CLEARED);
  const plan = from === null ? texts["03-plan.md"] : texts["03-plan.md"].replace(from, to);
  const result = evaluateCheck({ check: "03", texts: { ...texts, "03-plan.md": plan }, state: { type: "feature/refactor" }, prompt });
  return { gated: result.lines.includes(COND_2_GATE), cleared: result.usageCoverageCleared };
}

// The state.json of a seeded check-contract run.
function seededState(seeded) {
  return readRunState({ projectId: seeded.projectId, slug: SLUG, env: seeded.env });
}

test("the plan template's own quoted scenario lines parse, one per label, and the agent doc teaches the same syntax", () => {
  const template = readFileSync(join(PLUGIN, "skills", "resolve", "references", "prompts", "architect.md"), "utf8");
  const quoted = template.split("\n").filter((line) => line.startsWith("- <scenario>") && line.includes("changed=yes"));
  const labels = quoted.map(quotedSourceOf).filter(Boolean).map((source) => source.label);
  assert.deepEqual(labels.sort(), ["literal ticket", "operator decision"], quoted.join("\n"));
  const agent = readFileSync(join(PLUGIN, "agents", "architect.md"), "utf8");
  for (const label of ["literal ticket", "operator decision"]) assert.ok(agent.includes(`source=${label} "<quote>"`), `architect.md lacks source=${label} "<quote>"`);
});

test("cond-2 clears only when every changed=yes line quotes, in three words or more, a source the job prompt holds", () => {
  const prompt = readFixture(CLEARED).fixture.prompt;
  assert.deepEqual(cond2Answer({ prompt }), { gated: false, cleared: CLEARED_QUOTES });
  assert.deepEqual(cond2Answer({ prompt: null }), { gated: true, cleared: null }, "outside a job");
  assert.deepEqual(cond2Answer({ prompt: "  " }), { gated: true, cleared: null }, "an empty prompt");
  const from = 'source=literal ticket "the list view shows only active jobs"';
  const variants = [
    ['source=literal ticket "only active"', true, "a two-word quote"],
    ['source=literal ticket ""', true, "an empty quote"],
    ['source=literal ticket ("the list view shows only active jobs")', true, "the parenthesised form"],
    ['source=literal ticket "The List View shows only active jobs"', true, "another case"],
    ['source=ticket "the list view shows only active jobs"', true, "an unknown label"],
    ['source=literal ticket "the list view shows only active jobs" and more', true, "text after the quote"],
    ['source=literal ticket "the  list\tview shows   only active jobs"', false, "other whitespace"],
    ['source=operator decision "the list view shows only active jobs"', false, "the other label"],
  ];
  for (const [to, gated, name] of variants) assert.equal(cond2Answer({ prompt, from, to }).gated, gated, name);
  assert.equal(cond2Answer({ prompt, from: "after: active rows only", to: "to confirm" }).gated, true, "a bare to confirm field");
});

test("cond-2 gates a scenario item changed in any spelling or indent left unquoted, prose and non-list header lines ignored, a mid-word quote and a `to confirm` inside a field", () => {
  const prompt = readFixture(CLEARED).fixture.prompt;
  const detail = "- detail view · today: one row · after: one row · changed=no · source=pipeline";
  const changedVariants = [
    ["- detail view · today: one row · after: one row · changed=YES · source=pipeline", "an upper-case changed=YES"],
    ["- detail view · today: one row · after: one row · changed=yes (guess) · source=pipeline", "a changed=yes with trailing text"],
    ["  - detail view · today: one row · after: one row · changed=yes · source=pipeline", "an indented changed=yes line"],
    ["- detail view · today: one row · after: one row · Changed = maybe · source=pipeline", "a changed token that is not changed=no"],
    ["> - detail view · today: one row · after: one row · changed=yes · source=pipeline", "a blockquoted changed=yes line"],
    ["- detail view · today: one row · after: one row · changed＝yes · source=pipeline", "a fullwidth changed＝yes"],
    ["* detail view · today: one row · after: one row · changed=yes · source=pipeline", "a `*` item"],
    ["   * detail view · today: one row · after: one row · Changed=Yes trailing · source=pipeline", "an indented `*` item, mixed case, trailing text"],
    ["- detail view · today: one row · after: one row · chаnged=yes · source=pipeline", "a Cyrillic a in the changed word"],
    ["- detail view · today: one row · after: one row · chang​ed=yes · source=pipeline", "a zero-width space in the changed word"],
    ["- detail view · today: one row · after: one row · chan­ged=yes · source=pipeline", "a soft hyphen in the changed word"],
    ['- detail view · today: one row · after: one row · source=pipeline · changed=yes · source=literal ticket "the list view shows only active jobs"', "a pipeline source next to a found quote"],
    ['- **Diff axis:** detail view · today: one row · after: one row · changed=yes · source=literal ticket "bogus"', "a bold-led header label carrying a changed= field"],
    ["- **Scenarios consulted:** every changed=yes query", "a bulleted bold header"],
    ["* **Diff axis:** filter — changed=yes rows", "a `*`-bulleted bold header"],
    ["+ detail view · today: one row · after: one row · changed=yes · source=pipeline", "a `+` item"],
    ["- **Diff axis:** filter — the list rows · changed=YES", "a bulleted bold header with changed=YES"],
    ["  + **Always-gate class:** yes · changed=yes", "an indented `+` bold header"],
    ["1. detail view · today: one row · after: one row · changed=yes · source=pipeline", "an ordered item"],
    ["> * **Diff axis:** filter · changed=yes", "a blockquoted bold header item"],
    ["- **Diff​ axis:** filter · changed=yes", "a zero-width space inside the header label"],
    ["- detail view · today: one row · after: one row · changed=yes · source=pipeline", "a no-break space after the marker"],
  ];
  for (const [to, name] of changedVariants) assert.deepEqual(cond2Answer({ prompt, from: detail, to }), { gated: true, cleared: null }, name);
  const ignoredVariants = [
    ["detail view · today: one row · after: one row · changed=yes · source=pipeline", "a changed=yes line with no list marker"],
    ["the changed=yes rows are listed above", "a prose line"],
    ["> audit log · today: every row logged · after: active rows logged · changed＝yes · source=pipeline", "a blockquote without a list marker"],
    ["- **Diff axis:** filter — only the list rows", "a bulleted bold header with no change token"],
    ["-detail view · today: one row · after: one row · changed=yes · source=pipeline", "a marker glued to the text"],
  ];
  for (const [to, name] of ignoredVariants) assert.deepEqual(cond2Answer({ prompt, from: detail, to }), { gated: false, cleared: CLEARED_QUOTES }, name);
  const unchangedVariants = ["> - detail view · today: one row · after: one row · changed=no · source=pipeline", "- detail view · today: one row · after: one row · changed＝no · source=pipeline", "- **Diff axis:** filter · changed=no"];
  for (const to of unchangedVariants) assert.equal(cond2Answer({ prompt, from: detail, to }).gated, false, to);
  const from = 'source=literal ticket "the list view shows only active jobs"';
  const quoteVariants = [
    ['source=literal ticket "ist view shows only active jo"', true, "a quote cut mid-word at both ends"],
    ['source=literal ticket "list view shows only active job"', true, "a quote cut mid-word at its end"],
    ['source=literal ticket "list view shows only active jobs."', false, "a quote ending on the prompt's punctuation"],
  ];
  for (const [to, gated, name] of quoteVariants) assert.equal(cond2Answer({ prompt, from, to }).gated, gated, name);
  const confirmVariants = ["to confirm (ask)", "after: to confirm with the operator", "after: TO CONFIRM"];
  for (const to of confirmVariants) assert.equal(cond2Answer({ prompt, from: "after: active rows only", to }).gated, true, to);
});

test("a header line of the section mentioning a change never blocks the quotes that clear cond-2", () => {
  const { fixture, texts } = readFixture(CLEARED);
  const headers = texts["03-plan.md"].split("\n").filter((line) => /^\*\*(?:Diff axis|Always-gate class|Scenarios consulted):\*\*/.test(line));
  assert.equal(headers.length, 3, headers.join("\n"));
  for (const from of headers) assert.deepEqual(cond2Answer({ prompt: fixture.prompt, from, to: `${from} — the changed rows` }), { gated: false, cleared: CLEARED_QUOTES }, from);
});

test("a quote found only in the job's current operator note clears cond-2 through `run check 03`", async (t) => {
  const fixture = readFixture(CLEARED);
  const seeded = seedRun(t, "cond-2-note", { fixture: { ...fixture.fixture, prompt: "list the active jobs", operatorNote: fixture.fixture.prompt }, texts: fixture.texts });
  assert.deepEqual((await runCheck(seeded.env, "03")).out, fixture.expected);
});

test("a quote planted in a run file but absent from the job row never clears cond-2", async (t) => {
  const fixture = readFixture(CLEARED);
  const planted = { ...fixture.texts, "00-prompt.md": fixture.fixture.prompt, "00-brief.md": fixture.fixture.prompt };
  const seeded = seedRun(t, "cond-2-forged", { fixture: { ...fixture.fixture, prompt: "list the active jobs" }, texts: planted });
  assert.ok((await runCheck(seeded.env, "03")).out.includes(COND_2_GATE));
  assert.equal("usageCoverageCleared" in seededState(seeded), false);
});

test("a cleared run lists its quotes in the report and before the PR footer, and a later check 03 that gates drops them", async (t) => {
  const fixture = readFixture(CLEARED);
  const seeded = seedRun(t, "cond-2-record", fixture);
  await runCheck(seeded.env, "03");
  assert.deepEqual(seededState(seeded).usageCoverageCleared.quotes, CLEARED_QUOTES);
  assert.equal(coverageRecordLine(seededState(seeded)), COVERAGE_LINE);

  const report = [];
  assert.equal(await run(["run", "report", "--json"], { env: seeded.env, out: (line) => report.push(line), err: () => {}, stdout: { write: () => {} } }), 0);
  assert.ok(JSON.parse(report[0]).openItems.includes(`usage coverage: ${COVERAGE_LINE}`), report[0]);

  const bodyFile = join(seeded.dir, "pr-body.md");
  writeFileSync(bodyFile, "## Report\nthe body\n");
  const published = publishedBodyFile({ bodyFile, runDir: seeded.dir, jobId: null, coverageLine: coverageRecordLine(seededState(seeded)) });
  assert.equal(readFileSync(published, "utf8"), `## Report\nthe body\n\n${COVERAGE_LINE}\n\n${PR_FOOTER}\n`);

  writeFileSync(join(seeded.dir, "03-plan.md"), readFixture("usage-coverage-cond-2-quote-absent").texts["03-plan.md"]);
  assert.ok((await runCheck(seeded.env, "03")).out.includes(COND_2_GATE));
  assert.equal("usageCoverageCleared" in seededState(seeded), false);
  assert.equal(coverageRecordLine(seededState(seeded)), null);
});

test("`run_set` refuses the runtime's usage coverage record", async (t) => {
  const seeded = seedRun(t, "cond-2-run-set", readFixture(CLEARED));
  const refused = recordRunFields({ projectId: seeded.projectId, slug: SLUG, fields: { usageCoverageCleared: { quotes: CLEARED_QUOTES } }, env: seeded.env });
  assert.deepEqual(refused, { status: "kept", path: null, reason: "`usageCoverageCleared` is written by the runtime only" });
});

test("the job prompt text is the row's prompt then its current note, and null outside a job or for an unknown job", async (t) => {
  const fixture = readFixture(CLEARED);
  const seeded = seedRun(t, "job-prompt", { fixture: { ...fixture.fixture, operatorNote: "keep  the \"raw\" note" }, texts: {} });
  const own = { jobId: Number(seeded.env.NIGHTQUEUE_JOB_ID) };
  assert.equal(await jobPromptText(own, seeded.env), `${fixture.fixture.prompt}\n\nkeep  the "raw" note`);
  assert.equal(await jobPromptText({ jobId: null }, seeded.env), null);
  assert.equal(await jobPromptText({ jobId: 99999 }, seeded.env), null);
});
