import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { COMMIT_TYPES } from "../../src/queue/branch-name.mjs";
import { skillReferencesDir } from "../../src/queue/skill-template.mjs";
import { briefGates, briefSlug, briefType, hintPatterns, REQUIRED_FIELDS } from "../../src/queue/triage-brief.mjs";

const TEMPLATE = readFileSync(join(skillReferencesDir(), "prompts", "triager.md"), "utf8");
const FILLED = { "Affected area": "src/a.mjs", Context: "c", Objective: "o", "Expected outcome": "e", "Commit type": "fix" };

// A triage whose Brief carries the filled fields with the given overrides, one `**Field:** value` line each.
function triageWith(overrides = {}) {
  const fields = { ...FILLED, ...overrides };
  const lines = Object.entries(fields).map(([field, value]) => `**${field}:** ${value}`);
  return `## Brief\n${lines.join("\n")}\n`;
}

test("a real bracketed value is filled: a component name, a bare type parameter, an empty array", () => {
  assert.deepEqual(briefGates(triageWith({ "Affected area": "`<LoginForm>`" }), "PROCEED"), []);
  assert.deepEqual(briefGates(triageWith({ "Affected area": "<T>" }), "PROCEED"), []);
  assert.deepEqual(briefGates(triageWith({ Context: "[]" }), "PROCEED"), []);
});

test("the template's own hint copied verbatim is an empty field", () => {
  const hint = "<module / component / file(s) — specific>";
  assert.deepEqual(briefGates(triageWith({ "Affected area": hint }), "PROCEED"), [{ code: "brief-field-empty", evidence: "Affected area" }]);
  const spaced = "<module  /  component / file(s) — specific>";
  assert.deepEqual(briefGates(triageWith({ "Affected area": spaced }), "PROCEED"), [{ code: "brief-field-empty", evidence: "Affected area" }]);
});

test("the commit-type hint rendered with the real list is empty, never an invalid commit type", () => {
  const rendered = `<one of ${COMMIT_TYPES.join(", ")} — the one that describes the change>`;
  assert.deepEqual(briefGates(triageWith({ "Commit type": rendered }), "PROCEED"), [{ code: "brief-field-empty", evidence: "Commit type" }]);
});

test("a closed placeholder word is an empty field", () => {
  assert.deepEqual(briefGates(triageWith({ Objective: "TBD" }), "PROCEED"), [{ code: "brief-field-empty", evidence: "Objective" }]);
  assert.deepEqual(briefGates(triageWith({ Context: "n/a" }), "PROCEED"), [{ code: "brief-field-empty", evidence: "Context" }]);
});

test("the Slug and Type hints read as absent, so they neither rename nor gate", () => {
  const triage = triageWith({ Type: "<bug/error | feature/refactor>", Slug: "<a short kebab-case slug of the request>" });
  assert.equal(briefSlug(triage), null);
  assert.equal(briefType(triage), null);
  assert.deepEqual(briefGates(triage, "PROCEED"), []);
});

test("hintPatterns keeps each `**Field:** <…>` line, strips a section wrapper and lets a placeholder match any value", () => {
  const patterns = hintPatterns("**Objective:** <what to change>\n{{#X}}**Commit type:** <one of {{LIST}}>{{/X}}\n**Context:** plain text\n");
  assert.deepEqual([...patterns.keys()], ["Objective", "Commit type"]);
  assert.ok(patterns.get("Objective").test("<What to change>"));
  assert.ok(patterns.get("Commit type").test("<one of feat, fix>"));
  assert.equal(patterns.get("Objective").test("what to change"), false);
  assert.equal(hintPatterns("").size, 0);
});

test("the shipped triager template gives a hint for every required field", () => {
  const patterns = hintPatterns(TEMPLATE);
  for (const field of REQUIRED_FIELDS) assert.ok(patterns.has(field), `the triager template has no hint for ${field}`);
});
