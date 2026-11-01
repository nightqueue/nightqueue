import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SILENT_STOP_NOTICE, classifyJobResult } from "../../src/queue/classify.mjs";
import { composeGateNotice } from "../../src/queue/gate-notice.mjs";
import { confirmationSection, extractResultText, hasGateMarker } from "../../src/queue/stream.mjs";
import { GATE_MARKER, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const LOG_FIXTURE = fileURLToPath(new URL("./fixtures/job-42/attempt1-result.jsonl", import.meta.url));
const PLAN_FIXTURE = fileURLToPath(new URL("./fixtures/job-42/03-plan.md", import.meta.url));

// Job #42's real shape: the final `result` of attempt 1 carries the whole `## Requires user
// confirmation` block, and nothing was recorded through `run_outcome`: the heading alone never opens a gate.
test("job #42's real attempt-1 result: a printed confirmation heading with no record is a failure with the no-outcome notice", () => {
  const log = readFileSync(LOG_FIXTURE, "utf8");
  assert.equal(hasGateMarker(extractResultText(log)), true, "setup: the result still carries the confirmation heading");

  const outcome = classifyJobResult({ log, exitCode: 0 });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
});

// The `run_outcome` path: the runtime composed the notice from the plan's own section, and the final
// text is one plain line with no `## Notice` - the record alone makes it a real gate.
test("a gate recorded with a notice composed from the plan, and a final text without `## Notice`, is a real gate", () => {
  const notice = composeGateNotice({
    runDir: dirname(PLAN_FIXTURE),
    jobId: 42,
    fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" },
  });
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused at the architecture gate." })]);
  const state = { outcome: { status: "gate", notice } };

  const outcome = classifyJobResult({ log, exitCode: 0, state });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.noticeMd, notice);
  assert.ok(notice.startsWith(confirmationSection(readFileSync(PLAN_FIXTURE, "utf8"))), "the plan's section is carried verbatim");
  assert.ok(notice.endsWith('Answer with: nightqueue queue retry J-42 --note "<your answer>"'));
});

// A run directory whose plan holds a confirmation section of 1000+ code points and whose runtime asks for a device.
function longPlanRun(t) {
  const dir = mkdtempSync(join(tmpdir(), "nightqueue-nested-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const points = Array.from({ length: 12 }, (_, i) => `- C${i + 1}: ${"decision detail ".repeat(5)}`).join("\n");
  writeFileSync(join(dir, "03-plan.md"), `# Plan\n\n## Requires user confirmation\n\n${points}\n\n## Next\n\nx\n`);
  writeFileSync(join(dir, "07-runtime.md"), "## Runtime verdict\n\nNEEDS-DEVICE: open the app on a phone and tap the button once.\n");
  return { dir, planPath: join(dir, "03-plan.md") };
}

test("a recorded notice nesting another artifact's section is a gate even when the plan's section is far longer", (t) => {
  const { dir, planPath } = longPlanRun(t);
  const notice = composeGateNotice({ runDir: dir, jobId: 7, fromArtifact: { file: "07-runtime.md", section: "## Runtime verdict" } });
  assert.ok([...confirmationSection(readFileSync(planPath, "utf8"))].length - [...notice].length > 200, "setup: the notice is 200+ cp shorter");

  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused at the device gate." })]);
  const recorded = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "gate", notice } } });
  assert.deepEqual([recorded.status, recorded.noticeMd], ["gate", notice]);
});

test("a short recorded notice is a gate: a notice is never measured against the plan's section", () => {
  const notice = `${GATE_MARKER}\n\nApproved?`;
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused." })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "gate", notice } } });
  assert.deepEqual([outcome.status, outcome.noticeMd], ["gate", notice]);
});

test("a recorded notice with no confirmation heading is a gate: the record is the gate, not the heading", () => {
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused." })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "gate", notice: "Pick A or B." } } });
  assert.deepEqual([outcome.status, outcome.noticeMd], ["gate", "Pick A or B."]);
});

test("a notice composed from the plan's own section plus a question is a gate", (t) => {
  const { dir } = longPlanRun(t);
  const notice = composeGateNotice({
    runDir: dir,
    jobId: 7,
    question: "Is this a bug or a feature/refactor? the diff adds a flag",
    fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" },
  });
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused at the architecture gate." })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "gate", notice } } });
  assert.deepEqual([outcome.status, outcome.noticeMd], ["gate", notice]);
});

