import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyJobResult } from "../../src/queue/classify.mjs";
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
  const notice = `${block}\n\nAnswer with: nightshift queue retry 42 --note "approve C1-C8"`;
  const log = toNdjson([systemInitEvent(), resultEvent({ text: noticeText(notice) })]);

  const outcome = classifyJobResult({ log, exitCode: 0, planPath: PLAN_FIXTURE });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.noticeMd, notice);
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
