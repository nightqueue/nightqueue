import assert from "node:assert/strict";
import { test } from "node:test";
import { briefBody } from "../../src/queue/prompt-brief.mjs";

test("briefBody returns the text of the Brief section up to the next heading", () => {
  const prompt = ["intro", "## Brief", "fix the bug", "in two places", "## Context", "more"].join("\n");
  assert.equal(briefBody(prompt), "fix the bug\nin two places");
});

test("briefBody runs to the end of the prompt when no heading follows the Brief", () => {
  assert.equal(briefBody("## Brief\nonly this"), "only this");
});

test("briefBody ignores a Brief heading and a later heading quoted inside a fenced block", () => {
  const prompt = ["```", "## Brief", "quoted", "```", "## Brief", "real", "~~~", "## Not a heading", "~~~", "still real", "## Next"].join("\n");
  assert.equal(briefBody(prompt), ["real", "~~~", "## Not a heading", "~~~", "still real"].join("\n"));
});

test("briefBody answers null for a prompt without a Brief, or with one only inside a fence", () => {
  assert.equal(briefBody("## Task\nno brief"), null);
  assert.equal(briefBody("```\n## Brief\n```"), null);
  assert.equal(briefBody(null), null);
});
