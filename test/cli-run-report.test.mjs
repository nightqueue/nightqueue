import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "../src/cli/index.mjs";
import { jobLogPath, logsDir, runDir } from "../src/config/paths.mjs";
import { savedLessons } from "../src/cli/run-report.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob } from "../src/memory/jobs.mjs";
import { recordOutcome, recordPhaseDone, recordPrUrl, recordRunFields, recordTermination } from "../src/queue/run-state.mjs";
import { ensureProject, makeHome, makeProject } from "../test-support/memory.mjs";
import { attemptMarker, toNdjson, toolResultEvent, toolUseEvent } from "../test-support/streams.mjs";

const SLUG = "add-slugify";
const PR = "https://github.com/acme/api/pull/7";

// A home, a job bound to its run and the tier and type the run recorded.
function makeRun(t, name, { tier, type = "feature/refactor" }) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "add slugify" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  const run = { projectId: ensureProject(env, "alpha"), slug: SLUG, env };
  recordRunFields({ ...run, fields: { tier, type } });
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

test("a clean simple run prints the compact line, the lesson audit and `Happy: yes`, with no execution table", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-simple-happy", { tier: "simple" });
  recordPhases(target, [
    ["implementation", "ok", "slugify added"],
    ["verification", "PASSED", "suite green"],
  ]);
  recordDelivery(target);

  assert.deepEqual(await report(env, id), [
    `## 🗂️ Report — ${SLUG}`,
    "",
    `Verification ✅ · PR ${PR}`,
    "",
    "Lessons saved: 0",
    "Happy: yes",
  ]);
});

test("a clean complex run prints the step table, every step ✅", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-complex-happy", { tier: "complex" });
  recordPhases(target, COMPLEX_CLEAN);
  recordDelivery(target);

  const lines = await report(env, id);

  assert.deepEqual(lines.slice(0, 4), [`## 🗂️ Report — ${SLUG}`, "", "| Step | Agent | Status | Highlight |", "|-------|--------|--------|----------|"]);
  assert.equal(lines[4], "| 1 Triage | 🔍 Triager | ✅ | confirmed the missing helper |");
  assert.equal(lines[10], "| 6.5 Runtime | 📱 Runtime | ✅ | real run confirmed |");
  assert.equal(lines[11], `| 7 Commit/PR | 🚀 Commit/PR | ✅ | PR ${PR} |`);
  assert.equal(lines.at(-1), "Happy: yes");
});

test("the steps a tier does not run are ⏭️, and a planned step never recorded is ⚠️", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-skips", { tier: "simple", type: "bug/error" });
  recordPhases(target, [["implementation", "ok", "fixed"], ["verification", "PASSED", "green"]]);
  recordDelivery(target);

  const { steps, happy, reason } = JSON.parse((await report(env, id, ["--json"]))[0]);
  const icons = Object.fromEntries(steps.map((step) => [step.phase, step.icon]));

  assert.deepEqual(icons, {
    triage: "⚠️",
    explore: "⏭️",
    architecture: "⏭️",
    implementation: "✅",
    qa: "⏭️",
    verification: "✅",
    runtime: "⏭️",
    commit: "✅",
  });
  assert.equal(happy, false);
  assert.equal(reason, "1 Triage ⚠️ not recorded");
});

test("a phase recorded twice is a 🔁 re-run: not happy, with the execution table and its total", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-rerun", { tier: "simple" });
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
  assert.equal(lines.at(-1), "**Total:** ⏱️ -");
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
    const { env, id, run: target } = makeRun(t, `report-gate-${name.replace(/\W+/g, "-")}`, { tier: "complex" });
    arrange(target);
    recordDelivery(target);
    const lines = await report(env, id);
    assert.ok(lines.some((line) => expected.test(line)), `${name}:\n${lines.join("\n")}`);
  }
});

test("a PASSED complex run that recorded no runtime lane skips 6.5 as a static change", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-static", { tier: "complex" });
  recordPhases(target, COMPLEX_CLEAN.filter(([phase]) => phase !== "runtime"));
  recordDelivery(target);
  const lines = await report(env, id);
  assert.ok(lines.includes("| 6.5 Runtime | 📱 Runtime | ⏭️ | purely static change |"), lines.join("\n"));
  assert.equal(lines.at(-1), "Happy: yes");
});

test("a note with `|` or a line break stays inside its table cell and on the Happy line", async (t) => {
  const { env, id, run: target } = makeRun(t, "report-cell-escape", { tier: "complex" });
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
  const { env, id, run: target } = makeRun(t, "report-no-delivery", { tier: "simple" });
  recordPhases(target, [["implementation", "ok", "done"], ["verification", "PASSED", "green"]]);
  const lines = await report(env, id);
  assert.ok(lines.includes("Happy: no — 7 Commit/PR ⚠️ no pull request recorded"), lines.join("\n"));
});

test("the lesson audit counts the orchestrator's successful `lesson_save` calls of the last attempt only", async (t) => {
  const save = (id, target, extra = {}) => toolUseEvent({ name: "mcp__nightqueue__lesson_save", id, input: { title: "x", target }, ...extra });
  const log = [
    attemptMarker(1),
    toNdjson([save("toolu_old", "qa")]),
    attemptMarker(2),
    toNdjson([
      save("toolu_1", "coder"),
      toolResultEvent({ toolUseId: "toolu_1" }),
      save("toolu_2", "architect"),
      toolResultEvent({ toolUseId: "toolu_2", isError: true }),
      save("toolu_3", "verifier", { parentToolUseId: "toolu_lane" }),
      save("toolu_4", "coder"),
    ]),
  ].join("\n");
  assert.deepEqual(savedLessons(log), { count: 2, targets: ["coder"] });

  const { env, id, run: target } = makeRun(t, "report-lessons", { tier: "simple" });
  recordPhases(target, [["implementation", "ok", "done"], ["verification", "PASSED", "green"]]);
  recordDelivery(target);
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), log);
  assert.ok((await report(env, id)).includes("Lessons saved: 2 (targets: coder)"));
});
