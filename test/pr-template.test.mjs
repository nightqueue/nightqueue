import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// The part of a template the precedence decides: where it came from and which headings it has.
function picked(checkout) {
  const { source, path, label, headings } = findPrTemplate(checkout);
  return { source, path, label, headings };
}

test("the first candidate the checkout carries wins, in the fixed order, and nothing at all falls back to nightshift's", (t) => {
  const checkout = checkoutWith(t, "pr-template-precedence", {
    ".github/PULL_REQUEST_TEMPLATE.md": "## Upper\n",
    "docs/PR_TEMPLATE.md": "## Docs\n",
    "CONTRIBUTING.md": "# Contributing\n\n## Pull requests\n\n```markdown\n## Contributing\n```\n",
    "CLAUDE.md": ACME_CLAUDE_MD,
  });
  assert.deepEqual(picked(checkout).headings, ["## Upper"]);
  rmSync(join(checkout, ".github"), { recursive: true });
  assert.deepEqual(picked(checkout), { source: "repo", path: "docs/PR_TEMPLATE.md", label: "docs/PR_TEMPLATE.md", headings: ["## Docs"] });
  rmSync(join(checkout, "docs"), { recursive: true });
  assert.deepEqual(picked(checkout), { source: "repo", path: "CONTRIBUTING.md", label: "CONTRIBUTING.md § Pull requests", headings: ["## Contributing"] });
  rmSync(join(checkout, "CONTRIBUTING.md"));
  assert.equal(picked(checkout).path, "CLAUDE.md");
  rmSync(join(checkout, "CLAUDE.md"));
  assert.deepEqual(picked(checkout), { source: "nightshift", path: null, label: "fallback", headings: NIGHTSHIFT_SECTIONS });
});

test("the lowercase `.github` template counts when it is the only one, and it outranks `docs/PR_TEMPLATE.md`", (t) => {
  const checkout = checkoutWith(t, "pr-template-lowercase", {
    ".github/pull_request_template.md": "## Lower\n",
    "docs/PR_TEMPLATE.md": "## Docs\n",
  });
  assert.deepEqual(picked(checkout).headings, ["## Lower"]);
});

test("the real acme-mobile-app CLAUDE.md yields its PR template, not the Branch or Commits block that precede it", (t) => {
  const checkout = checkoutWith(t, "pr-template-acme", { "CLAUDE.md": ACME_CLAUDE_MD });
  assert.deepEqual(picked(checkout), { source: "repo", path: "CLAUDE.md", label: "CLAUDE.md § Git & PR workflow", headings: ACME_HEADINGS });
});

test("a PR section with no heading-bearing markdown block is no template, and the search moves on", (t) => {
  const contributing = "# Contributing\n\n## Pull requests\n\nOpen one per change.\n\n```bash\n# install\nnpm ci\n```\n";
  const checkout = checkoutWith(t, "pr-template-fallthrough", { "CONTRIBUTING.md": contributing, "CLAUDE.md": ACME_CLAUDE_MD });
  assert.equal(picked(checkout).path, "CLAUDE.md");
  rmSync(join(checkout, "CLAUDE.md"));
  assert.equal(picked(checkout).source, "nightshift");
});

test("only a whole-word `PR` or `pull request` heading opens a section", (t) => {
  const approval = "## Critério de aprovação\n\n```markdown\n## Wrong\n```\n";
  assert.equal(picked(checkoutWith(t, "pr-template-word", { "CLAUDE.md": approval })).source, "nightshift");
  const checklist = "## Pull request checklist\n\n```\n## Right\n```\n";
  assert.deepEqual(picked(checkoutWith(t, "pr-template-checklist", { "CLAUDE.md": checklist })).headings, ["## Right"]);
});

test("a whole-file template skips the headings inside fences and HTML comments, and one with none is still the repository's", (t) => {
  const file = "## Why\n\n<!--\n## Hidden\n-->\n<!-- ## Inline -->\n\n```\n## Example\n```\n\n## How\n";
  const checkout = checkoutWith(t, "pr-template-file", { ".github/PULL_REQUEST_TEMPLATE.md": file });
  assert.deepEqual(picked(checkout).headings, ["## Why", "## How"]);
  const empty = checkoutWith(t, "pr-template-empty", { ".github/PULL_REQUEST_TEMPLATE.md": "- [ ] tested\n" });
  assert.deepEqual(picked(empty), { source: "repo", path: ".github/PULL_REQUEST_TEMPLATE.md", label: ".github/PULL_REQUEST_TEMPLATE.md", headings: [] });
});

test("a repository template with no heading accepts any body except one carrying a nightshift heading", (t) => {
  const template = { source: "repo", path: "x.md", label: "x.md", headings: [] };
  assert.deepEqual(bodyProblems({ body: "just a description\n", template }), []);
  assert.deepEqual(bodyProblems({ body: "## Report\n\nx\n", template }), [
    { rejected: "the body carries the nightshift heading `## Report`, which the repository template (x.md) does not have" },
  ]);
});

test("a `Not tested:` line above the QA table does not count", (t) => {
  const evidenceDir = makeDir(t, "pr-body-evidence");
  writeFileSync(join(evidenceDir, "automated-verification.md"), "PASSED\n");
  const body = "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\nNot tested: nothing\n| Method | Executed | Result |\n| --- | --- | --- |\n| Automated | `npm test` | PASSED |\n";
  const template = { source: "nightshift", headings: NIGHTSHIFT_SECTIONS };
  assert.deepEqual(bodyProblems({ body, template, evidenceDir }), [{ missing: "Not tested: line after the QA table" }]);
  assert.deepEqual(bodyProblems({ body: `${body}Not tested: the real device; low risk\n`, template, evidenceDir }), []);
});
