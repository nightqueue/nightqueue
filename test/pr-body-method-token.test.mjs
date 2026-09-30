import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bodyProblems } from "../src/cli/pr-body.mjs";
import { NIGHTQUEUE_SECTIONS } from "../src/cli/pr-template.mjs";
import { makeDir } from "../test-support/memory.mjs";

const TEMPLATE = { source: "nightqueue", headings: NIGHTQUEUE_SECTIONS };

// A nightqueue-shaped body whose QA section has exactly one subsection, built from its heading and bullet text.
function bodyWithQaSubsection(heading, bullet) {
  return `## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n### ${heading}\n- ${bullet} — PASSED ✅\nNot tested: nothing\n`;
}

test("an API subsection evidenced via API is not falsely MISSING because its bullet also says 'automated'", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-api-automated");
  writeFileSync(join(evidenceDir, "api-postman.log"), "200 OK\n");
  const body = bodyWithQaSubsection("API", "verified via an automated Postman run");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), []);
});

test("a subsection whose heading is no known method is refused, even when its bullet says 'device'", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-browser-device");
  writeFileSync(join(evidenceDir, "browser-e2e.log"), "PASSED\n");
  const body = bodyWithQaSubsection("Chrome headless", "run on a CI device farm");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), [
    { missing: "a known QA subsection instead of ### Chrome headless (### Automated, ### API, ### Browser, ### Device)" },
  ]);
});

test("a Device subsection is backed by `emulator-*` evidence, not by its bullet text saying 'API'", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-emulator-api");
  writeFileSync(join(evidenceDir, "emulator-boot.log"), "booted\n");
  const body = bodyWithQaSubsection("Device", "iOS simulator, hit the API and read the response");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), []);
});

test("a Device subsection without `emulator-*` evidence is MISSING it", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-device-missing");
  writeFileSync(join(evidenceDir, "api-postman.log"), "200 OK\n");
  const body = bodyWithQaSubsection("Device", "iOS simulator, hit the API and read the response");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), [{ missing: "evidence for QA section Device" }]);
});

test("'scenarios' and 'bios' in a bullet do not change the subsection's method", (t) => {
  const evidenceDir = makeDir(t, "pr-body-method-token-ios-boundary");
  writeFileSync(join(evidenceDir, "automated-run.log"), "PASSED\n");
  const body = bodyWithQaSubsection("Automated", "covered several bios and scenarios edge cases");
  assert.deepEqual(bodyProblems({ body, template: TEMPLATE, evidenceDir }), []);
});
