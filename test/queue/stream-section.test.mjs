import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmationSection, sectionOf, unfencedLines } from "../../src/queue/stream.mjs";

const PLAN = [
  "# Plan",
  "",
  "```md",
  "## Usage coverage",
  "- quoted · changed=yes · source=pipeline",
  "```",
  "",
  "## Usage coverage (2 lines)",
  "- list view · changed=yes",
  "```",
  "## Not a heading",
  "```",
  "- export · changed=no",
  "### Sub-heading stays inside",
  "",
  "## Requires user confirmation",
  "- Question: approve?",
  "",
  "## Assumptions",
  "- none",
].join("\n");

test("`sectionOf` matches the heading by prefix outside a fence and ends at the next level-2 heading outside a fence", () => {
  assert.equal(
    sectionOf(PLAN, "## Usage coverage"),
    ["## Usage coverage (2 lines)", "- list view · changed=yes", "```", "## Not a heading", "```", "- export · changed=no", "### Sub-heading stays inside"].join("\n"),
  );
  assert.equal(sectionOf(PLAN, "## Assumptions"), "## Assumptions\n- none");
  assert.equal(sectionOf(PLAN, "## Not a heading"), null);
  assert.equal(sectionOf("", "## Brief"), null);
});

test("`unfencedLines` drops every fenced line, the fence markers included", () => {
  const lines = unfencedLines(sectionOf(PLAN, "## Usage coverage"));
  assert.deepEqual(lines, ["## Usage coverage (2 lines)", "- list view · changed=yes", "- export · changed=no", "### Sub-heading stays inside"]);
});

test("`confirmationSection` still answers the confirmation section verbatim, and null without one", () => {
  assert.equal(confirmationSection(PLAN), "## Requires user confirmation\n- Question: approve?");
  assert.equal(confirmationSection("```\n## Requires user confirmation\n```\n"), null);
  assert.equal(confirmationSection("# Plan\n\n### Requires user confirmation\nwhy\n## Next\n"), "### Requires user confirmation\nwhy");
});
