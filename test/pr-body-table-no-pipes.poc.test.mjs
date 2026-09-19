import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bodyProblems } from "../src/cli/pr-body.mjs";
import { NIGHTSHIFT_SECTIONS } from "../src/cli/pr-template.mjs";
import { makeDir } from "../test-support/memory.mjs";

const TEMPLATE = { source: "nightshift", headings: NIGHTSHIFT_SECTIONS };

function withEvidence(t, name) {
  const evidenceDir = makeDir(t, name);
  writeFileSync(join(evidenceDir, "automated-verification.md"), "PASSED\n");
  return evidenceDir;
}

// Group C: a QA table without outer pipes is valid GFM; the header itself is present and readable.
test("a QA table without outer pipes is reported as a MISSING header naming the exact piped form the template requires", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-no-pipes");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\nMethod | Executed | Result\n--- | --- | ---\nAutomated | `npm test` | PASSED\nNot tested: nothing else\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, [{ missing: "QA table header | Method | Executed | Result |" }]);
});

// R9 open sub-case: `Not tested:` written AS a pipe-prefixed table row, mixed into the data rows.
test("`Not tested:` written as a table row is absorbed as a bogus method row, and the plain `Not tested:` line is still reported missing", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-not-tested-as-row");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n| Method | Executed | Result |\n| --- | --- | --- |\n| Automated | `npm test` | PASSED |\n| Not tested: nothing else |\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, [
    { missing: "a known method in QA row Not tested: nothing else (Automated, API, Browser, Android / iOS emulator or device)" },
    { missing: "Not tested: line after the QA table" },
  ]);
});

// Header separator with GFM alignment colons must still be recognized.
test("a separator with alignment colons is accepted", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-align-colons");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n| Method | Executed | Result |\n| :--- | :---: | ---: |\n| Automated | `npm test` | PASSED |\nNot tested: nothing else\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, []);
});

// Extra inner spaces and trailing whitespace on every table line must not break parsing.
test("extra spaces and trailing whitespace around cells are tolerated", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-extra-spaces");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n|  Method  |  Executed  |  Result  |   \n|  ---  |  ---  |  ---  |  \n|  Automated  |  `npm test`  |  PASSED  |  \nNot tested: nothing else\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, []);
});

// A blank line between the header/separator and the first data row ends the table early, same as a real markdown renderer would.
test("a blank line between the separator and the data rows ends the table before any row", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-blank-before-rows");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n| Method | Executed | Result |\n| --- | --- | --- |\n\n| Automated | `npm test` | PASSED |\nNot tested: nothing else\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, [{ missing: "a QA table row for a method that ran" }]);
});

// A blank line between the header and its separator makes the whole table unrecognized, same as a real markdown renderer would.
test("a blank line between the header and the separator makes the header unrecognized", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-blank-before-separator");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n| Method | Executed | Result |\n\n| --- | --- | --- |\n| Automated | `npm test` | PASSED |\nNot tested: nothing else\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, [{ missing: "QA table header | Method | Executed | Result |" }]);
});

// A row whose Result is FAILED is not blocked (only an explicit N/A row is rejected).
test("a FAILED result does not block publication", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-failed-result");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n| Method | Executed | Result |\n| --- | --- | --- |\n| Automated | `npm test` | FAILED |\nNot tested: nothing else\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, []);
});

// `Not tested:` with no text of its own must be treated the same as an absent line.
test("`Not tested:` with empty text is reported missing", (t) => {
  const evidenceDir = withEvidence(t, "pr-body-not-tested-empty");
  const body =
    "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n| Method | Executed | Result |\n| --- | --- | --- |\n| Automated | `npm test` | PASSED |\nNot tested:\n";
  const problems = bodyProblems({ body, template: TEMPLATE, evidenceDir });
  assert.deepEqual(problems, [{ missing: "Not tested: line after the QA table" }]);
});
