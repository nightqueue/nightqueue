import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { bodyProblems } from "../src/cli/pr-body.mjs";
import { findPrTemplate, NIGHTSHIFT_SECTIONS } from "../src/cli/pr-template.mjs";
import { makeDir } from "../test-support/memory.mjs";

// Lines 228-301 of the real acme-mobile-app CLAUDE.md, copied verbatim: the Branch and Commits blocks come before the template.
const ACME_CLAUDE_MD = readFileSync(new URL("./fixtures/acme-mobile-app-claude-md.md", import.meta.url), "utf8");
const ACME_HEADINGS = ["## Summary", "## Changes", "## Test plan", "## OTA-able?"];

// Writes one file of a checkout, creating its directories.
function writeFile(checkout, path, text) {
  const absolute = join(checkout, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

// A checkout holding exactly the given files.
function checkoutWith(t, name, files) {
  const checkout = makeDir(t, name);
  for (const [path, text] of Object.entries(files)) writeFile(checkout, path, text);
  return checkout;
}

test("Group B: an HTML comment opened mid-line (after a real heading on the same line) does not hide the commented-out heading that follows it", (t) => {
  const file = [
    "## Summary",
    "",
    "## Old section <!-- keep this around for now",
    "## Actually dead, ignore this one",
    "-->",
    "",
    "## Changes",
    "",
  ].join("\n");
  const checkout = checkoutWith(t, "pr-template-midline", { ".github/PULL_REQUEST_TEMPLATE.md": file });
  const { headings } = findPrTemplate(checkout);
  // The text before `<!--` renders as a heading; the commented-out `## Actually dead, ignore this one` must never leak in.
  assert.deepEqual(headings, ["## Summary", "## Old section", "## Changes"]);
});

test("Group B (embedded path): a mid-line comment inside a repository's PR section fence still hides the heading commented out after it", (t) => {
  const contributing = [
    "# Contributing",
    "",
    "## Pull requests",
    "",
    "```markdown",
    "## Summary <!-- one-line summary of the change",
    "## Old, unused section",
    "-->",
    "## Changes",
    "```",
    "",
  ].join("\n");
  const checkout = checkoutWith(t, "pr-template-midline-embedded", { "CONTRIBUTING.md": contributing });
  const { headings } = findPrTemplate(checkout);
  assert.deepEqual(headings, ["## Summary", "## Changes"]);
});

test("probe: CRLF line endings on the acme-shaped fixture still yield the 4 real headings", (t) => {
  const crlf = ACME_CLAUDE_MD.replace(/\n/g, "\r\n");
  const checkout = checkoutWith(t, "pr-template-crlf", { "CLAUDE.md": crlf });
  const { headings } = findPrTemplate(checkout);
  assert.deepEqual(headings, ACME_HEADINGS);
});

test("probe: a CRLF body still validates against the nightshift template", (t) => {
  const evidenceDir = makeDir(t, "pr-body-crlf-evidence");
  writeFileSync(join(evidenceDir, "automated-verification.md"), "PASSED\n");
  const body = [
    "## Report",
    "x",
    "## Cause",
    "y",
    "## Changes",
    "- z",
    "## QA",
    "| Method | Executed | Result |",
    "| --- | --- | --- |",
    "| Automated | `npm test` | PASSED |",
    "Not tested: the real device; low risk",
    "",
  ].join("\r\n");
  const template = { source: "nightshift", headings: NIGHTSHIFT_SECTIONS };
  assert.deepEqual(bodyProblems({ body, template, evidenceDir }), []);
});

test("probe: a ~~~markdown fence is recognized the same as a ``` one", (t) => {
  const contributing = ["# Contributing", "", "## Pull requests", "", "~~~markdown", "## Summary", "## Changes", "~~~", ""].join("\n");
  const checkout = checkoutWith(t, "pr-template-tilde-fence", { "CONTRIBUTING.md": contributing });
  const { headings } = findPrTemplate(checkout);
  assert.deepEqual(headings, ["## Summary", "## Changes"]);
});

test("probe: a fence indented by up to 3 spaces (valid CommonMark) is still recognized", (t) => {
  const contributing = ["# Contributing", "", "## Pull requests", "", "   ```markdown", "## Summary", "## Changes", "   ```", ""].join("\n");
  const checkout = checkoutWith(t, "pr-template-indented-fence", { "CONTRIBUTING.md": contributing });
  const { headings } = findPrTemplate(checkout);
  assert.deepEqual(headings, ["## Summary", "## Changes"]);
});

test("probe: a realistic GitHub PULL_REQUEST_TEMPLATE.md, mostly guidance comments, does not lose a heading commented out mid-line", (t) => {
  const file = [
    "<!--",
    "Thank you for contributing! Please fill out the template below.",
    "-->",
    "",
    "## Description <!-- describe your changes here, keep the old wording below for reference",
    "## Old wording, delete before merging",
    "-->",
    "",
    "## Type of change",
    "<!-- Please delete options that are not relevant -->",
    "- [ ] Bug fix",
    "- [ ] New feature",
    "",
  ].join("\n");
  const checkout = checkoutWith(t, "pr-template-github-shape", { ".github/PULL_REQUEST_TEMPLATE.md": file });
  const { headings } = findPrTemplate(checkout);
  assert.deepEqual(headings, ["## Description", "## Type of change"]);
});
