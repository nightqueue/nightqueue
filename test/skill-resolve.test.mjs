import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { buildPrompt } from "../src/queue/spawn.mjs";

const SKILL = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
const OPERATOR_TIER_LITERAL = "(set by the operator - the pipeline may only raise it, with evidence, never lower it)";

// The cells of a markdown table row, trimmed and without the outer pipes.
function cellsOf(line) {
  return line.split("|").slice(1, -1).map((cell) => cell.trim());
}

// The row of the model table whose first cell ends with the given agent name.
function modelRow(agent) {
  const row = SKILL.split("\n").find((line) => line.includes("|") && cellsOf(line)[0]?.endsWith(agent));
  assert.ok(row, `the model table has no row for ${agent}`);
  return cellsOf(row);
}

test("a tier is raised only on evidence, never lowered, and the mandatory escalation block is gone", () => {
  assert.equal(/[Mm]andatory escalation/.test(SKILL), false, "the mandatory escalation block survived");
  assert.ok(SKILL.includes("raise only on evidence found, never on the shape of the change"), SKILL);
  assert.ok(SKILL.includes("Tier raised: <from> -> <to>: <evidence>"), SKILL);
  assert.ok(SKILL.includes("never lowers an operator tier"), SKILL);
});

test("the operator-tier line of the prompt is the same literal in the skill and in the runtime", () => {
  assert.ok(SKILL.includes(OPERATOR_TIER_LITERAL), SKILL);
  const prompt = buildPrompt({ job: { id: 1, prompt: "p", tier: "simple" } });
  assert.ok(prompt.includes(`Tier: simple ${OPERATOR_TIER_LITERAL}`), prompt);
});

test("both fast tracks are documented with their time targets", () => {
  assert.ok(SKILL.includes('### Fast Lite Track — execute this block if the tier is "trivial"'), SKILL);
  assert.ok(SKILL.includes('### Fast Track — execute this block if the tier is "simple"'), SKILL);
  assert.ok(SKILL.includes("under 5 minutes"), SKILL);
  assert.ok(SKILL.includes("under 15 minutes"), SKILL);
});

test("the model table drops the architect and the qa-guardian from the simple tier", () => {
  const header = modelRow("Agent");
  const simple = header.indexOf("simple");
  assert.ok(simple > 0, `the model table has no \`simple\` column: ${header.join(" | ")}`);
  assert.equal(modelRow("architect")[simple], "—");
  assert.equal(modelRow("qa-guardian")[simple], "—");
  assert.equal(modelRow("coder")[simple], "sonnet", "the parser read the wrong column");
});

test("the telemetry paragraph names the two new parameters, under the names the operator chose", () => {
  assert.ok(SKILL.includes("tier_operator"), SKILL);
  assert.ok(SKILL.includes("tier_raise_reason"), SKILL);
  assert.equal(SKILL.includes("operator_tier"), false, "the old column name came back");
});
