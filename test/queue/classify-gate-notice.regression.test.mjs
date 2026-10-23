import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyJobResult } from "../../src/queue/classify.mjs";
import { composeGateNotice } from "../../src/queue/gate-notice.mjs";
import { confirmationSection, extractNoticeFromStream, extractResultText, hasGateMarker } from "../../src/queue/stream.mjs";
import { GATE_MARKER, noticeText, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const LOG_FIXTURE = fileURLToPath(new URL("./fixtures/job-42/attempt1-result.jsonl", import.meta.url));
const PLAN_FIXTURE = fileURLToPath(new URL("./fixtures/job-42/03-plan.md", import.meta.url));

// The fixed notice of a broken gate, naming the plan path the way classify.mjs does.
function brokenGateNotice(planPath) {
  return `the run stopped at a gate but its notice does not carry the question - see ${planPath ?? "an unknown plan path"}`;
}

// Job #42's real shape: the final `result` of attempt 1 carries the whole `## Requires user
// confirmation` block (8 points, C1-C8), but the `## Notice` that follows it is a 3-line summary
// that never repeats the heading - exactly the bug (queue status gives the operator nothing to
// decide) this classification exists to catch.
test("job #42's real attempt-1 result: a gate whose notice does not carry the question is failed, not gate", () => {
  const log = readFileSync(LOG_FIXTURE, "utf8");
  const resultText = extractResultText(log);
  const rejectedNotice = extractNoticeFromStream(log);

  assert.equal(hasGateMarker(resultText), true, "setup: the result still carries the confirmation heading, so the run really asked for a decision");
  assert.equal(hasGateMarker(rejectedNotice), false, "setup: the notice the run wrote is a summary that never repeats the heading");
  assert.equal(rejectedNotice.split("\n").length, 3, "setup: the rejected notice is the 3-line summary job #42 actually wrote");

  const withoutPlan = classifyJobResult({ log, exitCode: 0 });
  assert.notEqual(withoutPlan.status, "gate", "the notice does not carry the question; today's baseline of `gate` is not trusted anymore");
  assert.equal(withoutPlan.status, "failed");
  assert.equal(withoutPlan.noticeMd, brokenGateNotice(null));

  const withPlan = classifyJobResult({ log, exitCode: 0, planPath: PLAN_FIXTURE });
  assert.equal(withPlan.status, "failed");
  assert.equal(withPlan.noticeMd, brokenGateNotice(PLAN_FIXTURE));
});

// A synthetic run whose `## Notice` body is the plan's own `## Requires user confirmation`
// block, verbatim, plus the answer line - the shape the fixed SKILL template now prescribes.
test("a gate notice that carries the plan's confirmation block verbatim, plus the answer line, is a real gate", () => {
  const plan = readFileSync(PLAN_FIXTURE, "utf8");
  const block = confirmationSection(plan);
  const notice = `${block}\n\nAnswer with: nightqueue queue retry 42 --note "approve C1-C8"`;
  const log = toNdjson([systemInitEvent(), resultEvent({ text: noticeText(notice) })]);

  const outcome = classifyJobResult({ log, exitCode: 0, planPath: PLAN_FIXTURE });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.noticeMd, notice);
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

  const outcome = classifyJobResult({ log, exitCode: 0, state, planPath: PLAN_FIXTURE });
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
  writeFileSync(join(dir, "06-runtime.md"), "## Runtime verdict\n\nNEEDS-DEVICE: open the app on a phone and tap the button once.\n");
  return { dir, planPath: join(dir, "03-plan.md") };
}

test("a recorded notice nesting another artifact's section is a gate even when the plan's section is far longer", (t) => {
  const { dir, planPath } = longPlanRun(t);
  const notice = composeGateNotice({ runDir: dir, jobId: 7, fromArtifact: { file: "06-runtime.md", section: "## Runtime verdict" } });
  assert.ok([...confirmationSection(readFileSync(planPath, "utf8"))].length - [...notice].length > 200, "setup: the notice is 200+ cp shorter");

  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused at the device gate." })]);
  const recorded = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "gate", notice } }, planPath });
  assert.deepEqual([recorded.status, recorded.noticeMd], ["gate", notice]);

  const inText = classifyJobResult({ log: toNdjson([systemInitEvent(), resultEvent({ text: noticeText(notice) })]), exitCode: 0, planPath });
  assert.equal(inText.status, "failed", "the `## Notice` in the final text is measured as before");
});

test("a short recorded notice that nests nothing is still measured against the plan's section", (t) => {
  const { planPath } = longPlanRun(t);
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused." })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "gate", notice: `${GATE_MARKER}\n\nApproved?` } }, planPath });
  assert.equal(outcome.status, "failed");
});

test("a notice composed from the plan's own section plus a question is a gate", (t) => {
  const { dir, planPath } = longPlanRun(t);
  const notice = composeGateNotice({
    runDir: dir,
    jobId: 7,
    question: "Is this a bug or a feature/refactor? the diff adds a flag",
    fromArtifact: { file: "03-plan.md", section: "## Requires user confirmation" },
  });
  const log = toNdjson([systemInitEvent(), resultEvent({ text: "Paused at the architecture gate." })]);
  const outcome = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "gate", notice } }, planPath });
  assert.deepEqual([outcome.status, outcome.noticeMd], ["gate", notice]);
});

// The margin: a notice that keeps the heading but drops almost every point of the plan's own
// section is a paraphrase in disguise, not a real answer to the question - still failed.
test("the margin: a notice that has the heading but drops the plan's points is still failed", () => {
  const notice = `${GATE_MARKER}\n\nApproved as proposed.`;
  const log = toNdjson([systemInitEvent(), resultEvent({ text: noticeText(notice) })]);

  const outcome = classifyJobResult({ log, exitCode: 0, planPath: PLAN_FIXTURE });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.noticeMd, brokenGateNotice(PLAN_FIXTURE));
});
