import assert from "node:assert/strict";
import { test } from "node:test";
import { fixRoute, planStageNumbers, planStageQa, qaWindow } from "../plugin/skills/resolve/pipeline/contract.mjs";

// A plan whose `## Implementation plan` holds the given lines.
function plan(...lines) {
  return `# Plan\n\n## Implementation plan\n${lines.join("\n")}\n\n## Assumptions\n- QA: none\n`;
}

test("planStageQa reads the first QA line of each stage, in its plain, bullet, bold and backtick forms", () => {
  const words = planStageQa(plan("### Stage 1 — one", "- a", "QA: attack", "QA: none", "### Stage 2 — two", "- **QA:** None", "### Stage 3 — three", "QA: `none`", "### Stage 4 — four", "**QA**: maybe"));
  assert.deepEqual([...words], [[1, "attack"], [2, "none"], [3, "none"], [4, "maybe"]]);
});

test("planStageQa keys an unstaged plan's line by null, never reads past the section and skips a fenced line", () => {
  assert.deepEqual([...planStageQa(plan("- Add the filter.", "QA: none"))], [[null, "none"]]);
  assert.deepEqual([...planStageQa(plan("- Add the filter."))], []);
  assert.deepEqual([...planStageQa(plan("### Stage 1 — one", "```", "QA: none", "```"))], []);
});

test("planStageQa leaves out a QA mode line, which is no stage QA line", () => {
  assert.deepEqual([...planStageQa(plan("### Stage 1 — one", "QA mode: lite"))], []);
});

test("fixRoute: design wins over code, code alone is code, and no mark is null", () => {
  assert.equal(fixRoute("## Failures\n- x\n\nfix: code\n- **fix:** design\n"), "design");
  assert.equal(fixRoute("## Verdict\nNEEDS FIX\n\n`fix: code`\n"), "code");
  assert.equal(fixRoute("## Verdict\nFAILED\n\nThe fix is in the code.\n"), null);
});

test("fixRoute ignores a mark inside a code fence or an HTML comment", () => {
  assert.equal(fixRoute("```\nfix: design\n```\nfix: code\n"), "code");
  assert.equal(fixRoute("<!-- fix: design -->\n"), null);
});

test("fixRoute reads a mark alone or before a separator, never a prose line that names a route", () => {
  assert.equal(fixRoute("fix: code\n- fix: design is not needed\n"), "code");
  assert.equal(fixRoute("fix: design — the plan misses the archive path\n"), "design");
});

test("planStageNumbers leaves out a stage inside an HTML comment", () => {
  assert.deepEqual(planStageNumbers(plan("### Stage 1 — one", "<!--", "### Stage 2 — dropped", "-->")), [1]);
});

test("qaWindow answers every round after the last QA triage round, else the last round", () => {
  const raw = "## Round 1\nsource: qa-triage\n\n## QA mode\nlite — x\n\n## Round 2\nfix: design\n\n## Round 3\nsource: qa-triage\n\n## QA mode\nfull — y\n\n## Round 4\nH1\n\n## Round 5\nfix: code\n";
  const window = qaWindow(raw);
  assert.match(window, /## Round 4/);
  assert.match(window, /## Round 5/);
  assert.doesNotMatch(window, /fix: design/);
  assert.equal(fixRoute(window), "code");
  assert.equal(qaWindow("## Round 1\n## Verdict\nAPPROVED\n"), "## Round 1\n## Verdict\nAPPROVED\n");
});
