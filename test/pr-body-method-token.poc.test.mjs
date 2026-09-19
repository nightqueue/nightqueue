import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bodyProblems } from "../src/cli/pr-body.mjs";
import { NIGHTSHIFT_SECTIONS } from "../src/cli/pr-template.mjs";
import { makeDir } from "../test-support/memory.mjs";

const TEMPLATE = { source: "nightshift", headings: NIGHTSHIFT_SECTIONS };

// A nightshift-shaped body whose QA table has exactly one row, built from a QA cell's text.
function bodyWithQaRow(cell) {
  return `## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n| Method | Executed | Result |\n| --- | --- | --- |\n| ${cell} | ran it | it passed |\nNot tested: nothing\n`;
}

test("a QA row genuinely run and evidenced via API is not falsely MISSING because its text also says 'automated'", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-api-automated");
  writeFileSync(join(evidenceDir, "api-postman.log"), "200 OK\n");
  const body = bodyWithQaRow("API (verified via an automated Postman run)");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), []);
});

test("a QA row whose cell starts with no known method name is MISSING a known method, even when its text says 'device' later", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-browser-device");
  writeFileSync(join(evidenceDir, "browser-e2e.log"), "PASSED\n");
  const body = bodyWithQaRow("Chrome headless run on a CI device farm");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), [
    { missing: "a known method in QA row Chrome headless run on a CI device farm (Automated, API, Browser, Android / iOS emulator or device)" },
  ]);
});

test("a QA row genuinely run on the iOS emulator is not falsely MISSING because its text also says 'API'", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-emulator-api");
  writeFileSync(join(evidenceDir, "emulator-boot.log"), "booted\n");
  const body = bodyWithQaRow("iOS simulator, hit the API and read the response");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), []);
});

test("'bios' and 'scenarios' do not falsely trip the iOS pattern (word-boundary holds)", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-ios-boundary");
  writeFileSync(join(evidenceDir, "automated-run.log"), "PASSED\n");
  const body = bodyWithQaRow("Automated: covered several bios and scenarios edge cases");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), []);
});

test("'rapid' does not falsely trip the API pattern (word-boundary holds)", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-api-boundary");
  writeFileSync(join(evidenceDir, "automated-run.log"), "PASSED\n");
  const body = bodyWithQaRow("Automated: rapid regression suite");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), []);
});
