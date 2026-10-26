import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { jobLogPath, logsDir, pendingWritesPath, runDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { saveRunState } from "../src/queue/resume.mjs";
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

test("a legacy fast-track run is read as the one pipeline: the full step table, its never-recorded exploration ⚠️, so it is not happy", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-simple-legacy");
  saveRunState({ projectId: target.projectId, slug: SLUG, env, state: { tier: "simple", type: "feature/refactor" } });
  recordPhases(target, [
    ["triage", "PROCEED", "confirmed the missing helper"],
    ["implementation", "ok", "slugify added"],
    ["verification", "PASSED", "suite green"],
  ]);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.deepEqual(lines.slice(2, 4), ["| Step | Agent | Status | Highlight |", "|-------|--------|--------|----------|"], lines.join("\n"));
  assert.equal(lines.some((line) => line.startsWith("Verification ")), false, "the compact fast-track line is still printed");
  assert.ok(lines.includes("Happy: no — 2 Exploration ⚠️ not recorded"), lines.join("\n"));
  assert.equal("tier" in JSON.parse((await report(env, id, ["--json"]))[0]), false, "the json report carries a tier");
});

test("a clean run prints the step table, every step ✅", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-complex-happy");
  recordPhases(target, COMPLEX_CLEAN);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.deepEqual(lines.slice(0, 4), [`## 🗂️ Report — ${SLUG}`, "", "| Step | Agent | Status | Highlight |", "|-------|--------|--------|----------|"]);
  assert.equal(lines[4], "| 1 Triage | 🔍 Triager | ✅ | confirmed the missing helper |");
  assert.equal(lines[10], "| 7 Runtime | 📱 Runtime | ✅ | real run confirmed |");
  assert.equal(lines[11], `| 8 Commit/PR | 🚀 Commit/PR | ✅ | PR ${PR} |`);
  assert.equal(lines[12], "| 9 Report | 🗂️ Report | ⏳ | this report |");
  assert.ok(lines.includes("Happy: yes"), lines.join("\n"));
  assert.deepEqual(lines.slice(-3), ["## Open items", "", "- none"]);
});

test("every step is planned: a step never recorded is ⚠️, and the runtime is ⏭️ only after a PASSED verification", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-skips", { type: "bug/error" });
  recordPhases(target, [["implementation", "ok", "fixed"], ["verification", "PASSED", "green"]]);
  recordDelivery(target);

  const { steps, happy, reason } = JSON.parse((await report(env, id, ["--json"]))[0]);
  const icons = Object.fromEntries(steps.map((step) => [step.phase, step.icon]));

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
  assert.equal(happy, false);
  assert.equal(reason, "1 Triage ⚠️ not recorded");
});

test("a phase recorded twice is a 🔁 re-run: not happy, with the execution table and its total", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-rerun");
  recordPhases(target, [
    ["implementation", "ok", "first try"],
    ["implementation", "ok", "fixed the failures"],
    ["verification", "PASSED", "green"],
  ]);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.ok(lines.includes("Happy: no — 4 Implementation 🔁 fixed the failures"), lines.join("\n"));
  assert.ok(lines.includes("| Step | Agent | Status | Summary | Time |"));
  assert.ok(lines.includes("| implementation | ⚙️ Coder | ok | first try | - |"));
  assert.ok(lines.includes("| implementation | ⚙️ Coder | ok | fixed the failures | - |"));
  assert.ok(lines.includes("**Total:** ⏱️ -"), lines.join("\n"));
  assert.deepEqual(lines.slice(-3), ["## Open items", "", "- none"]);
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
  assert.ok(lines.includes("| 7 Runtime | 📱 Runtime | ⏭️ | purely static change |"), lines.join("\n"));
  assert.ok(lines.includes("Happy: yes"), lines.join("\n"));
  assert.deepEqual(lines.slice(-3), ["## Open items", "", "- none"]);
});

test("a note with `|` or a line break stays inside its table cell and on the Happy line", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-cell-escape");
  recordPhases(target, COMPLEX_CLEAN.map((row) => (row[0] === "qa" ? ["qa", "APPROVED", "3 risks | 1 red"] : row)));
  recordPhases(target, [["implementation", "ok", "a | b\nsecond line"]]);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.ok(lines.includes("| 5 QA | 🛡️ QA-Guardian | ✅ | 3 risks \\| 1 red |"), lines.join("\n"));
  assert.ok(lines.includes("| 4 Implementation | ⚙️ Coder | 🔁 | a \\| b second line |"), lines.join("\n"));
  assert.ok(lines.includes("Happy: no — 4 Implementation 🔁 a \\| b second line"), lines.join("\n"));
  assert.ok(lines.includes("| implementation | ⚙️ Coder | ok | a \\| b second line | - |"), lines.join("\n"));
  assert.equal(lines.includes("second line"), false, lines.join("\n"));
});

test("a run with no delivery recorded is not happy", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-no-delivery");
  recordPhases(target, COMPLEX_CLEAN.filter(([phase]) => phase !== "commit"));
  const lines = await report(env, id);
  assert.ok(lines.includes("Happy: no — 8 Commit/PR ⚠️ no pull request recorded"), lines.join("\n"));
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
