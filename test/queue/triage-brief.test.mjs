import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMIT_TYPES } from "../../src/queue/branch-name.mjs";
import { briefCommitType, briefSlug, briefType } from "../../plugin/skills/resolve/pipeline/brief.mjs";

const FILLED = { "Affected area": "src/a.mjs", Context: "c", Objective: "o", "Expected outcome": "e", "Commit type": "fix" };

// A triage whose Brief carries the filled fields with the given overrides, one `**Field:** value` line each.
function triageWith(overrides = {}) {
  const fields = { ...FILLED, ...overrides };
  const lines = Object.entries(fields).map(([field, value]) => `**${field}:** ${value}`);
  return `## Brief\n${lines.join("\n")}\n`;
}

test("the Slug, Type and commit-type hints copied verbatim read as absent, so they neither rename nor record", () => {
  const triage = triageWith({ Type: "<bug/error | feature/refactor>", Slug: "<a short kebab-case slug of the request>", "Commit type": `<one of ${COMMIT_TYPES.join(", ")}>` });
  assert.equal(briefSlug(triage), null);
  assert.equal(briefType(triage), null);
  assert.equal(briefCommitType(triage), null);
});

test("a closed placeholder word reads as absent", () => {
  assert.equal(briefSlug(triageWith({ Slug: "TBD" })), null);
  assert.equal(briefCommitType(triageWith({ "Commit type": "n/a" })), null);
});

test("a Brief with no field at all, or no Brief, reads every fact as absent", () => {
  for (const text of ["## Brief\n", "# Triage\nno brief here\n", ""]) {
    assert.deepEqual([briefType(text), briefCommitType(text), briefSlug(text)], [null, null, null], JSON.stringify(text));
  }
});

test("a Type or commit type is read by its leading token, so a suffix passes and a value that merely starts alike does not", () => {
  const types = [
    ["bug/error (security)", "bug/error"],
    ["**Feature/Refactor** — the listing", "feature/refactor"],
    ["feature", null],
    ["bug/error-ish", null],
    ["(security) bug/error", null],
  ];
  for (const [value, expected] of types) assert.equal(briefType(triageWith({ Type: value })), expected, value);
  const commitTypes = [
    ["fix(queue)", "fix"],
    ["refactor everything", "refactor"],
    ["feature", null],
    ["3 fix", null],
  ];
  for (const [value, expected] of commitTypes) assert.equal(briefCommitType(triageWith({ "Commit type": value })), expected, value);
});

test("an option list reads as undecided, while a value that names one type passes", () => {
  const types = ["bug/error | feature/refactor", "bug/error or feature/refactor", "bug/error / feature/refactor", "bug/error, feature/refactor", "bug/error vs feature/refactor"];
  for (const value of types) assert.equal(briefType(triageWith({ Type: value })), null, value);
  for (const value of ["feat | fix | refactor | docs", "fix or feat"]) assert.equal(briefCommitType(triageWith({ "Commit type": value })), null, value);
  const decided = [
    ["fix — not a refactor", "fix"],
    ["refactor everything", "refactor"],
    ["fix or chore-ish", "fix"],
    ["fix, in the queue", "fix"],
  ];
  for (const [value, expected] of decided) assert.equal(briefCommitType(triageWith({ "Commit type": value })), expected, value);
});
