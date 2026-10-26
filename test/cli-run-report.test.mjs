import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { reportRows } from "../src/cli/run-report.mjs";
import { jobLogPath, logsDir, pendingWritesPath, runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { readRunState, saveRunState } from "../src/queue/resume.mjs";
import { recordOutcome, recordPhaseDone, recordPrUrl, recordRunFields, recordTermination } from "../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject } from "../test-support/memory.mjs";
import { makeSickHome } from "../test-support/sick-home.mjs";
import { toNdjson, toolResultEvent, toolUseEvent } from "../test-support/streams.mjs";

const SLUG = "add-slugify";
const PR = "https://github.com/acme/api/pull/7";

// A home, a job bound to its run and the type the run recorded.
function makeRun(t, name, { type = "feature/refactor" } = {}) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "add slugify" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const run = { projectId: ensureProject(env, "alpha"), slug: SLUG, env };
  recordRunFields({ ...run, fields: { type } });
  return { env, id, run };
}

// Records the phases in order, each as `[phase, verdict, note]`.
function recordPhases(run, phases) {
  for (const [phase, verdict, note] of phases) recordPhaseDone({ ...run, phase, verdict, note, artifact: `${phase}.md` });
}

// Records the delivery the way `run pr` does: the outcome done and the pull request URL.
function recordDelivery(run) {
  recordOutcome({ ...run, status: "done" });
  recordPrUrl({ ...run, prUrl: PR });
}

// Runs `run report` as the job and answers its lines.
async function report(env, id, argv = []) {
  const out = [];
  const err = [];
  const code = await run(["run", "report", ...argv], {
    env: { ...env, NIGHTQUEUE_JOB_ID: String(id) },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  assert.equal(code, 0, err.join("\n"));
  return out;
}

const COMPLEX_CLEAN = [
  ["triage", "PROCEED", "confirmed the missing helper"],
  ["explore", "ok", "12 files mapped"],
  ["architecture", "ok", "one module, 3 risks"],
  ["implementation", "ok", "slugify added"],
  ["qa", "APPROVED", "no break proven"],
  ["verification", "## Verification: PASSED", "suite green"],
  ["runtime", "CONFIRMED", "real run confirmed"],
  ["commit", "ok", "committed"],
];

const HEADER = ["| Step | Agent | Result | Note | Time |", "|-------|--------|--------|------|-------|"];

// The Step cells of the printed table, in order.
function stepCells(lines) {
  return lines.filter((line) => line.startsWith("| ") && !line.startsWith("| Step |")).map((line) => line.split(" | ")[0].slice(2));
}

test("a legacy fast-track run is read as the one pipeline: the full table, its never-recorded exploration ⚠️, so it is not happy", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-simple-legacy");
  saveRunState({ projectId: target.projectId, slug: SLUG, env, state: { tier: "simple", type: "feature/refactor" } });
  recordPhases(target, [
    ["triage", "PROCEED", "confirmed the missing helper"],
    ["implementation", "ok", "slugify added"],
    ["verification", "PASSED", "suite green"],
  ]);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.deepEqual(lines.slice(2, 4), HEADER, lines.join("\n"));
  assert.equal(lines.some((line) => line.startsWith("Verification ")), false, "the compact fast-track line is still printed");
  assert.ok(lines.includes("Happy: no — 2 Exploration ⚠️ not recorded"), lines.join("\n"));
  assert.equal("tier" in JSON.parse((await report(env, id, ["--json"]))[0]), false, "the json report carries a tier");
});

test("a clean run prints one table, every step ✅ with its verdict word, then the Total and the Happy line", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-complex-happy");
  recordPhases(target, COMPLEX_CLEAN);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.deepEqual(lines.slice(0, 4), [`## 🗂️ Report — ${SLUG}`, "", ...HEADER]);
  assert.equal(lines[4], "| 1 Triage | 🔍 Triager | ✅ PROCEED | confirmed the missing helper | - |");
  assert.equal(lines[5], "| 2 Exploration | 🧭 Explore | ✅ OK | 12 files mapped | - |");
  assert.equal(lines[9], "| 6 Verification | ✅ Verifier | ✅ PASSED | suite green | - |");
  assert.equal(lines[10], "| 7 Runtime | 📱 Runtime | ✅ CONFIRMED | real run confirmed | - |");
  assert.equal(lines[11], `| 8 Commit/PR | 🚀 Commit/PR | ✅ OK | PR ${PR} | - |`);
  assert.equal(lines[12], "| 9 Report | 🗂️ Report | ⏳ | this report | - |");
  assert.ok(lines.includes("**Total:** ⏱️ -"), lines.join("\n"));
  assert.ok(lines.includes("Happy: yes"), lines.join("\n"));
  assert.equal(lines.filter((line) => line.startsWith("| Step |")).length, 1, "the report prints more than one table");
  assert.equal(lines.some((line) => line.includes("{{")), false, "a placeholder reached the output");
  assert.deepEqual(lines.slice(-3), ["## Open items", "", "- none"]);
});

test("every step is planned: a step never recorded is ⚠️ at its nominal slot, and the runtime is ⏭️ only after a PASSED verification", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-skips", { type: "bug/error" });
  recordPhases(target, [["implementation", "ok", "fixed"], ["verification", "PASSED", "green"]]);
  recordDelivery(target);

  const { rows, happy, reason } = JSON.parse((await report(env, id, ["--json"]))[0]);
  const icons = Object.fromEntries(rows.map((row) => [row.phase, row.icon]));

  assert.deepEqual(icons, {
    triage: "⚠️",
    explore: "⚠️",
    architecture: "⚠️",
    implementation: "✅",
    qa: "⚠️",
    verification: "✅",
    runtime: "⏭️",
    commit: "✅",
    null: "⏳",
  });
  assert.deepEqual(
    rows.map((row) => row.step),
    ["1 Triage", "2 Exploration", "3 Architecture", "4 Implementation", "5 QA", "6 Verification", "7 Runtime", "8 Commit/PR", "9 Report"],
  );
  assert.equal(happy, false);
  assert.equal(reason, "1 Triage ⚠️ not recorded");
});

test("a phase recorded twice is its own 🔁2 row: the run is not happy and the one table carries its total", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-rerun");
  recordPhases(target, [
    ["implementation", "ok", "first try"],
    ["implementation", "ok", "fixed the failures"],
    ["verification", "PASSED", "green"],
  ]);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.ok(lines.includes("| 4 Implementation | ⚙️ Coder | ✅ OK | first try | - |"), lines.join("\n"));
  assert.ok(lines.includes("| 4 Implementation 🔁2 | ⚙️ Coder | ✅ OK | fixed the failures | - |"), lines.join("\n"));
  assert.ok(lines.includes("Happy: no — 4 Implementation 🔁2 fixed the failures"), lines.join("\n"));
  assert.equal(lines.some((line) => line.includes("Summary")), false, "the second table is still printed");
  assert.equal(lines.filter((line) => line.startsWith("**Total:**")).length, 1, lines.join("\n"));
  assert.ok(lines.includes("**Total:** ⏱️ -"), lines.join("\n"));
  assert.deepEqual(lines.slice(-3), ["## Open items", "", "- none"]);
});

test("the rows follow the order the run recorded: a re-run sits where it happened, an unrecorded step at its nominal slot", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-temporal");
  recordPhases(target, [
    ["triage", "PROCEED", "confirmed"],
    ["implementation", "ok", "first try"],
    ["verification", "FAILED", "lint red"],
    ["implementation", "ok", "fixed"],
    ["verification", "PASSED", "green"],
    ["runtime", "CONFIRMED", "real run"],
  ]);
  recordDelivery(target);

  const lines = await report(env, id);
  const { reason } = JSON.parse((await report(env, id, ["--json"]))[0]);

  assert.deepEqual(stepCells(lines), [
    "1 Triage",
    "2 Exploration",
    "3 Architecture",
    "4 Implementation",
    "5 QA",
    "6 Verification",
    "4 Implementation 🔁2",
    "6 Verification 🔁2",
    "7 Runtime",
    "8 Commit/PR",
    "9 Report",
  ]);
  assert.ok(lines.includes("| 6 Verification | ✅ Verifier | ❌ FAILED | lint red | - |"), lines.join("\n"));
  assert.ok(lines.includes("| 6 Verification 🔁2 | ✅ Verifier | ✅ PASSED | green | - |"), lines.join("\n"));
  assert.equal(reason, "6 Verification ❌ lint red");
  assert.equal(stepCells(lines).filter((cell) => cell === "5 QA").length, 1);
});

test("three launches of a phase are 🔁2 then 🔁3", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-three-launches");
  recordPhases(target, [
    ["implementation", "ok", "first"],
    ["implementation", "ok", "second"],
    ["implementation", "ok", "third"],
  ]);
  recordDelivery(target);

  const cells = stepCells(await report(env, id));

  assert.deepEqual(cells.filter((cell) => cell.startsWith("4 Implementation")), ["4 Implementation", "4 Implementation 🔁2", "4 Implementation 🔁3"]);
});

test("the commit row reads the delivery the runtime recorded", async (t) => {
  const cases = [
    ["pr-opened", (target) => { recordPhases(target, [["commit", "PR opened"]]); recordDelivery(target); }, `| 8 Commit/PR | 🚀 Commit/PR | ✅ PR OPENED | PR ${PR} | - |`],
    ["committed", (target) => recordPhases(target, [["commit", "ok"]]), "| 8 Commit/PR | 🚀 Commit/PR | ✅ OK | committed, no pull request recorded | - |"],
    ["no-change", (target) => recordOutcome({ ...target, status: "no_change", notice: "the helper already exists" }), "| 8 Commit/PR | 🚀 Commit/PR | ✅ | no change needed - resolved without a pull request | - |"],
    ["nothing", () => {}, "| 8 Commit/PR | 🚀 Commit/PR | ⚠️ | no pull request recorded | - |"],
  ];
  for (const [name, arrange, expected] of cases) {
    const { env, id, run: target } = makeRun(t, `report-commit-${name}`);
    recordPhases(target, COMPLEX_CLEAN.filter(([phase]) => phase !== "commit"));
    arrange(target);
    const lines = await report(env, id);
    assert.ok(lines.includes(expected), `${name}:\n${lines.join("\n")}`);
  }
});

test("the reason and the note of an entry share its Note cell", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-reason-note");
  recordPhases(target, COMPLEX_CLEAN.filter(([phase]) => phase !== "qa"));
  recordPhaseDone({ ...target, phase: "qa", verdict: "APPROVED", reason: "GATE: coverage-x", note: "revised", artifact: "qa.md" });
  recordDelivery(target);

  const lines = await report(env, id);

  assert.ok(lines.includes("| 5 QA | 🛡️ QA-Guardian | ✅ APPROVED | GATE: coverage-x — revised | - |"), lines.join("\n"));
});

test("the Time of a row is the measurement of its own launch: the k-th measured lane of a phase meets its k-th recorded row", () => {
  const state = {
    phases: [
      { phase: "implementation", verdict: "ok" },
      { phase: "verification", verdict: "FAILED" },
      { phase: "implementation", verdict: "ok" },
    ],
  };
  const measured = [
    { phase: "implementation", durationS: 41 },
    { phase: "verification", durationS: null },
    { phase: "implementation", durationS: 30 },
  ];

  const rows = reportRows(state, measured).filter((row) => row.launch > 0);

  assert.deepEqual(rows.map((row) => [row.phase, row.launch, row.durationS]), [["implementation", 1, 41], ["verification", 1, null], ["implementation", 2, 30]]);
});

test("a malformed entry in state.json is skipped, never a crash: the launches count only the phases named", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-malformed");
  saveRunState({
    projectId: target.projectId,
    slug: SLUG,
    env,
    state: {
      type: "feature/refactor",
      phases: [{ phase: "triage", verdict: "PROCEED", note: "first" }, null, { verdict: "x" }, { phase: "triage", verdict: "PROCEED", note: "again" }],
    },
  });
  recordDelivery(target);

  const cells = stepCells(await report(env, id));

  assert.deepEqual(cells.slice(0, 2), ["1 Triage", "1 Triage 🔁2"]);
});

test("a phase the steps do not know is a row at its temporal place, with no agent", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-unknown-phase");
  recordPhases(target, COMPLEX_CLEAN);
  // `recordPhaseDone` refuses a phase outside the pipeline, so the entry lands in state.json the way a hand edit would.
  const state = readRunState({ projectId: target.projectId, slug: SLUG, env });
  saveRunState({ projectId: target.projectId, slug: SLUG, env, state: { ...state, phases: [...state.phases, { phase: "reflect", verdict: "ok", note: "L12, M3", at: new Date().toISOString() }] } });
  recordDelivery(target);

  const lines = await report(env, id);
  const cells = stepCells(lines);

  assert.ok(lines.includes("| reflect | - | ✅ OK | L12, M3 | - |"), lines.join("\n"));
  assert.deepEqual(cells.slice(cells.indexOf("8 Commit/PR")), ["8 Commit/PR", "reflect", "9 Report"]);
});

test("every failing gate of the fail-safe rule makes the run not happy", async (t) => {
  const cases = [
    ["failed verdict", (target) => recordPhases(target, COMPLEX_CLEAN.map((row) => (row[0] === "qa" ? ["qa", "NEEDS FIX", "two breaks"] : row))), /^Happy: no — 5 QA ❌ two breaks$/],
    [
      "PASSED-STATIC with no runtime",
      (target) => recordPhases(target, COMPLEX_CLEAN.filter(([phase]) => phase !== "runtime").map((row) => (row[0] === "verification" ? ["verification", "PASSED-STATIC", "static only"] : row))),
      /^Happy: no — 6 Verification ⚠️ static only$/,
    ],
    [
      "a plan asking for confirmation",
      (target) => {
        recordPhases(target, COMPLEX_CLEAN);
        mkdirSync(runDir(target.projectId, SLUG, target.env), { recursive: true });
        writeFileSync(join(runDir(target.projectId, SLUG, target.env), "03-plan.md"), "## Implementation plan\n\n## Requires user confirmation\n\nwhich one?\n");
      },
      /^Happy: no — the plan carries ## Requires user confirmation$/,
    ],
    ["a termination", (target) => {
      recordPhases(target, COMPLEX_CLEAN);
      recordTermination({ ...target, phase: "triage", reason: "NOT-REPRODUCIBLE" });
    }, /^Happy: no — terminated at triage: NOT-REPRODUCIBLE$/],
  ];
  for (const [name, arrange, expected] of cases) {
    const { env, id, run: target } = makeRun(t, `report-gate-${name.replace(/\W+/g, "-")}`);
    arrange(target);
    recordDelivery(target);
    const lines = await report(env, id);
    assert.ok(lines.some((line) => expected.test(line)), `${name}:\n${lines.join("\n")}`);
  }
});

test("a PASSED run that recorded no runtime lane skips 7 as a static change", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-static");
  recordPhases(target, COMPLEX_CLEAN.filter(([phase]) => phase !== "runtime"));
  recordDelivery(target);
  const lines = await report(env, id);
  assert.ok(lines.includes("| 7 Runtime | 📱 Runtime | ⏭️ | purely static change | - |"), lines.join("\n"));
  assert.ok(lines.includes("Happy: yes"), lines.join("\n"));
  assert.ok(lines.some((line) => line.startsWith("**Total:** ⏱️ ")), lines.join("\n"));
  assert.deepEqual(lines.slice(-3), ["## Open items", "", "- none"]);
});

test("a note with `|` or a line break stays inside its table cell and on the Happy line", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-cell-escape");
  recordPhases(target, COMPLEX_CLEAN.map((row) => (row[0] === "qa" ? ["qa", "APPROVED", "3 risks | 1 red"] : row)));
  recordPhases(target, [["implementation", "ok", "a | b\nsecond line"]]);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.ok(lines.includes("| 5 QA | 🛡️ QA-Guardian | ✅ APPROVED | 3 risks \\| 1 red | - |"), lines.join("\n"));
  assert.ok(lines.includes("| 4 Implementation 🔁2 | ⚙️ Coder | ✅ OK | a \\| b second line | - |"), lines.join("\n"));
  assert.ok(lines.includes("Happy: no — 4 Implementation 🔁2 a \\| b second line"), lines.join("\n"));
  assert.equal(lines.includes("second line"), false, lines.join("\n"));
});

test("a run with no delivery recorded is not happy", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-no-delivery");
  recordPhases(target, COMPLEX_CLEAN.filter(([phase]) => phase !== "commit"));
  const lines = await report(env, id);
  assert.ok(lines.includes("Happy: no — 8 Commit/PR ⚠️ no pull request recorded"), lines.join("\n"));
});

test("the json report carries the rows and the verdict of the one table, nothing of the old two", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-json-keys");
  recordPhases(target, COMPLEX_CLEAN);
  recordDelivery(target);

  const json = JSON.parse((await report(env, id, ["--json"]))[0]);

  assert.deepEqual(Object.keys(json), ["slug", "rows", "happy", "reason", "durationS", "openItems", "recorded"]);
  assert.deepEqual(Object.keys(json.rows[0]), ["phase", "step", "agent", "launch", "icon", "word", "note", "durationS"]);
});

test("the report carries no lesson audit, even when the stream has `lesson_save` calls: Phase 10's reflector reports the saves", async (t) => {
  const log = toNdjson([
    toolUseEvent({ name: "mcp__nightqueue__lesson_save", id: "toolu_1", input: { title: "x", target: "coder" } }),
    toolResultEvent({ toolUseId: "toolu_1" }),
  ]);
  for (const type of ["bug/error", "feature/refactor"]) {
    const { env, id, run: target } = makeRun(t, `report-no-lessons-${type.replace("/", "-")}`, { type });
    recordPhases(target, COMPLEX_CLEAN);
    recordDelivery(target);
    mkdirSync(logsDir(env), { recursive: true });
    writeFileSync(jobLogPath(id, env), log);
    const lines = await report(env, id);
    assert.equal(lines.some((line) => line.includes("Lessons saved")), false, lines.join("\n"));
    assert.ok(lines.includes("Happy: yes"), type);
  }
});

// The pipeline runs recorded for the slug, with their phases in order.
function recordedRuns(env) {
  const db = openDb(env);
  return db
    .prepare("SELECT id, outcome, gate_stop, task_type FROM pipeline_runs WHERE slug = ? ORDER BY id")
    .all(SLUG)
    .map((row) => ({
      outcome: row.outcome,
      gateStop: row.gate_stop,
      taskType: row.task_type,
      phases: db
        .prepare("SELECT phase, status, retry FROM pipeline_phases WHERE run_id = ? ORDER BY seq")
        .all(row.id)
        .map((phase) => `${phase.phase}:${phase.status}:${Number(phase.retry)}`),
    }));
}

// Starts the job's current attempt a minute ago, the instant a run is recorded once since.
function startAttempt(env, id) {
  openDb(env).prepare("UPDATE jobs SET attempt_started_at = datetime('now', '-1 minute') WHERE id = ?").run(id);
}

// Writes one file of the run directory.
function writeRunFile(target, file, text) {
  const dir = runDir(target.projectId, SLUG, target.env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
}

test("the report lists the QA's dedicated-ticket suggestions and the runtime's open scenarios under `## Open items`", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-open-items");
  recordPhases(target, COMPLEX_CLEAN);
  recordDelivery(target);
  writeRunFile(target, "05-qa.md", "## Round 1\n\n## Suggestions\n- old.mjs:1 — stale · dedicated ticket: yes\n\n## Round 2\n\n## Suggestions\n- foo.mjs:3 — leak\n  on close · dedicated ticket: yes\n- bar.mjs:9 — rename · dedicated ticket: no\n");
  writeRunFile(
    target,
    "07-runtime.md",
    "## Round 1\n\n## Runtime verdict\nCONFIRMED\n\nDiff applies plan: n/a\n\n| # | Scenario (declared entry point) | Result | Evidence |\n|---|---|---|---|\n| 1 | queue retry J-1 | MET | evidence/a.log |\n| 2 | sms login | NOT MET / to confirm — needs a phone | evidence/b.log |\n",
  );

  const lines = await report(env, id);

  const at = lines.indexOf("## Open items");
  assert.ok(at > 0, lines.join("\n"));
  assert.deepEqual(lines.slice(at + 2), ["- dedicated ticket: foo.mjs:3 — leak on close · dedicated ticket: yes", "- 07 open: sms login — to confirm"]);
  const json = JSON.parse((await report(env, id, ["--json"]))[0]);
  assert.deepEqual(json.openItems, ["dedicated ticket: foo.mjs:3 — leak on close · dedicated ticket: yes", "07 open: sms login — to confirm"]);
});

test("the report records the run from state.json once per attempt: a second report and its --json add no row", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-records-once");
  startAttempt(env, id);
  recordPhases(target, [
    ["triage", "PROCEED", "confirmed"],
    ["verification", "FAILED", "lint red"],
    ["verification", "PASSED", "green"],
  ]);
  recordDelivery(target);

  const first = JSON.parse((await report(env, id, ["--json"]))[0]);
  await report(env, id);
  const again = JSON.parse((await report(env, id, ["--json"]))[0]);

  assert.deepEqual([first.recorded, again.recorded], ["recorded", "already recorded"]);
  assert.deepEqual(recordedRuns(env), [
    { outcome: "pr_opened", gateStop: null, taskType: "feature/refactor", phases: ["triage:ok:0", "verification:failed:0", "verification:ok:1"] },
  ]);
});

test("a terminated run records no_commit with the gate it stopped at, and a gate pause records the user's", async (t) => {
  const terminated = makeRun(t, "report-records-terminated", { type: "bug/error" });
  startAttempt(terminated.env, terminated.id);
  recordPhases(terminated.run, [["triage", "NOT-REPRODUCIBLE", "no repro"]]);
  recordTermination({ ...terminated.run, phase: "triage", reason: "NOT-REPRODUCIBLE" });
  await report(terminated.env, terminated.id);
  assert.deepEqual(recordedRuns(terminated.env).map(({ outcome, gateStop }) => ({ outcome, gateStop })), [{ outcome: "no_commit", gateStop: "triage" }]);

  const paused = makeRun(t, "report-records-gate");
  startAttempt(paused.env, paused.id);
  recordPhases(paused.run, [["triage", "PROCEED", "ok"], ["architecture", "ok", "two options"]]);
  recordOutcome({ ...paused.run, status: "gate" });
  await report(paused.env, paused.id);
  assert.deepEqual(recordedRuns(paused.env).map(({ outcome, gateStop }) => ({ outcome, gateStop })), [{ outcome: "no_commit", gateStop: "user" }]);
});

// A home with a project and a run recorded outside any job.
function makeOutsideRun(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const run = { projectId: ensureProject(env, "alpha"), slug: SLUG, env };
  recordRunFields({ ...run, fields: { type: "bug/error" } });
  return { env, run };
}

// Runs `run report --json` outside a job, naming the run, and answers its JSON.
async function reportOutside(env) {
  const out = [];
  const err = [];
  const code = await run(["run", "report", "--json", "--project", "alpha", "--slug", SLUG], {
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { write: () => {} },
  });
  assert.equal(code, 0, err.join("\n"));
  return JSON.parse(out[0]);
}

test("outside a job a stopped run reported, then resumed and delivered, is recorded again as pr_opened", async (t) => {
  const { env, run: target } = makeOutsideRun(t, "report-outside-resumed");
  recordPhases(target, [["triage", "NOT-REPRODUCIBLE", "no repro"]]);
  recordTermination({ ...target, phase: "triage", reason: "NOT-REPRODUCIBLE" });
  assert.equal((await reportOutside(env)).recorded, "recorded");

  recordPhases(target, [["implementation", "ok", "x"], ["verification", "PASSED", "green"], ["commit", "ok", "committed"]]);
  recordDelivery(target);
  const second = await reportOutside(env);

  assert.equal(second.recorded, "recorded");
  assert.deepEqual(recordedRuns(env).map(({ outcome }) => outcome), ["no_commit", "pr_opened"]);
});

test("outside a job two reports of an unchanged run leave one row", async (t) => {
  const { env, run: target } = makeOutsideRun(t, "report-outside-unchanged");
  recordPhases(target, [["implementation", "ok", "x"], ["commit", "ok", "committed"]]);
  recordDelivery(target);

  const words = [(await reportOutside(env)).recorded, (await reportOutside(env)).recorded];

  assert.deepEqual(words, ["recorded", "already recorded"]);
  assert.equal(recordedRuns(env).length, 1);
});

test("inside a job with no recorded attempt start two reports leave one row", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-null-attempt");
  openDb(env).prepare("UPDATE jobs SET attempt_started_at = NULL WHERE id = ?").run(id);
  recordPhases(target, [["commit", "ok", "committed"]]);
  recordDelivery(target);

  const first = JSON.parse((await report(env, id, ["--json"]))[0]);
  const again = JSON.parse((await report(env, id, ["--json"]))[0]);

  assert.deepEqual([first.recorded, again.recorded], ["recorded", "already recorded"]);
  assert.equal(recordedRuns(env).length, 1);
});

test("a NO-CHANGE-NEEDED run records no_commit with no gate stop", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-records-no-change", { type: "bug/error" });
  startAttempt(env, id);
  recordPhases(target, [["triage", "NO-CHANGE-NEEDED", "already handled"]]);
  recordTermination({ ...target, phase: "triage", reason: "NO-CHANGE-NEEDED" });
  await report(env, id);
  assert.deepEqual(recordedRuns(env).map(({ outcome, gateStop }) => ({ outcome, gateStop })), [{ outcome: "no_commit", gateStop: null }]);
});

test("a telemetry failure leaves a fixed open item: the raw reason stays only in `recorded`", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-records-fixed-phrase");
  saveRunState({ projectId: target.projectId, slug: SLUG, env, state: { type: "bogus-type /tmp/secret-path" } });
  recordPhases(target, COMPLEX_CLEAN);
  recordDelivery(target);

  const json = JSON.parse((await report(env, id, ["--json"]))[0]);

  assert.deepEqual(json.openItems, ["the run was not recorded in the telemetry"]);
  assert.equal(json.openItems.some((item) => item.includes("bogus-type") || item.includes("/tmp/secret-path")), false);
  assert.ok(json.recorded.startsWith("not recorded: "), json.recorded);
  const lines = await report(env, id);
  assert.equal(lines.some((line) => line.includes("secret-path")), false, lines.join("\n"));
});

test("an unavailable database never fails the report: the run is queued for replay", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-records-sick");
  saveRunState({ projectId: target.projectId, slug: SLUG, env, state: { type: "feature/refactor", job: { id, projectKey: "alpha" } } });
  recordPhases(target, COMPLEX_CLEAN);
  recordDelivery(target);
  const sick = makeSickHome(env);
  t.after(() => sick.restore());

  const json = JSON.parse((await report(env, id, ["--json"]))[0]);

  assert.equal(json.recorded, "queued", JSON.stringify(json));
  assert.ok(existsSync(pendingWritesPath(target.projectId, SLUG, env)), "the run was neither recorded nor queued");
});
