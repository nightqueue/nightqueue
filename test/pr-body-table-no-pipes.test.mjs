import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { bodyProblems } from "../src/cli/pr-body.mjs";
import { NIGHTQUEUE_SECTIONS } from "../src/cli/pr-template.mjs";
import { makeDir } from "../test-support/memory.mjs";

const TEMPLATE = { source: "nightqueue", headings: NIGHTQUEUE_SECTIONS };

const HEAD = "## Report\nx\n## Cause\ny\n## Changes\n- z\n## QA\n";

const NOT_TESTED = "Not tested: nothing else\n";

const TABLE_REFUSAL = { missing: "QA subsections (### Automated, ### API, ### Browser, ### Device, one bullet per test) instead of a table" };

const NO_SUBSECTION = { missing: "a QA subsection for a method that ran (### Automated, ### API, ### Browser, ### Device)" };

// A run directory holding the evidence file of each named method.
function withEvidence(t, name, methods = ["automated"]) {
  const evidenceDir = makeDir(t, name);
  for (const method of methods) writeFileSync(join(evidenceDir, `${method}-verification.md`), "PASSED\n");
  return evidenceDir;
}

// The problems of a body made of the QA text under `## QA`, against the evidence of the named methods.
function qaProblems(t, name, qa, methods) {
  return bodyProblems({ body: HEAD + qa, template: TEMPLATE, evidenceDir: withEvidence(t, name, methods) });
}

test("subsections in any order, one bullet per test, with optional ✅/❌ and a reasoned SKIPPED are accepted", (t) => {
  const qa =
    "### Browser\n- http://localhost:3000/login, flow login → dashboard — the redirect was observed, PASSED ✅\n### Automated\n- `npm test` — PASSED ✅\n- `npm run lint` — FAILED ❌\n- `npm run e2e` — SKIPPED (no display)\n### Device\n- iOS simulator, login — PASSED\n" +
    NOT_TESTED;
  assert.deepEqual(qaProblems(t, "pr-body-any-order", qa, ["automated", "browser", "emulator"]), []);
});

test("a table under `## QA` is refused, with or without outer pipes", (t) => {
  const piped = "| Method | Executed | Result |\n| --- | --- | --- |\n| Automated | `npm test` | PASSED |\n" + NOT_TESTED;
  assert.deepEqual(qaProblems(t, "pr-body-table", piped), [TABLE_REFUSAL, NO_SUBSECTION]);
  const bare = "Method | Executed | Result\n--- | --- | ---\nAutomated | `npm test` | PASSED\n" + NOT_TESTED;
  assert.deepEqual(qaProblems(t, "pr-body-no-pipes", bare), [NO_SUBSECTION]);
});

test("a method outside the four is refused, `### Manual` included", (t) => {
  const qa = "### Automated\n- `npm test` — PASSED ✅\n### Manual\n- clicked around — PASSED\n" + NOT_TESTED;
  assert.deepEqual(qaProblems(t, "pr-body-manual", qa), [{ missing: "a known QA subsection instead of ### Manual (### Automated, ### API, ### Browser, ### Device)" }]);
});

test("an N/A bullet is rejected and an N/A subsection is no known method", (t) => {
  const bullet = qaProblems(t, "pr-body-na-bullet", "### Automated\n- `npm test` — N/A\n" + NOT_TESTED);
  assert.equal(bullet.length, 1);
  assert.match(bullet[0].rejected, /^QA subsection Automated has a N\/A bullet/);
  const subsection = qaProblems(t, "pr-body-na-subsection", "### Automated\n- `npm test` — PASSED ✅\n### N/A\n- nothing — PASSED\n" + NOT_TESTED);
  assert.deepEqual(subsection, [{ missing: "a known QA subsection instead of ### N/A (### Automated, ### API, ### Browser, ### Device)" }]);
});

test("a bullet whose result does not end in PASSED, FAILED or SKIPPED (<reason>) is refused", (t) => {
  for (const [index, line] of ["- `npm test` — the run went fine", "- `npm test` PASSED", "- `npm test` — SKIPPED", "- `npm test` — SKIPPED ()", "- `npm test` — PASSED and more"].entries()) {
    const problems = qaProblems(t, `pr-body-bad-bullet-${index}`, `### Automated\n${line}\n${NOT_TESTED}`);
    assert.equal(problems.length, 1, line);
    assert.match(problems[0].missing, /^QA bullet .* in subsection Automated/, line);
  }
});

test("a subsection with no bullet is refused", (t) => {
  assert.deepEqual(qaProblems(t, "pr-body-empty-subsection", "### Automated\n" + NOT_TESTED), [{ missing: "a bullet under QA subsection Automated" }]);
});

test("`Not tested:` missing, empty, or before the last subsection is refused", (t) => {
  const missing = { missing: "Not tested: line after the last QA subsection" };
  assert.deepEqual(qaProblems(t, "pr-body-no-not-tested", "### Automated\n- `npm test` — PASSED ✅\n"), [missing]);
  assert.deepEqual(qaProblems(t, "pr-body-not-tested-empty", "### Automated\n- `npm test` — PASSED ✅\nNot tested:\n"), [missing]);
  assert.deepEqual(qaProblems(t, "pr-body-not-tested-before", "Not tested: nothing\n### Automated\n- `npm test` — PASSED ✅\n"), [missing]);
});

test("each subsection needs its own `<method>-*` evidence, Device mapping to `emulator`", (t) => {
  const qa = "### Automated\n- `npm test` — PASSED ✅\n### API\n- GET /health — 200, PASSED ✅\n### Device\n- Android emulator — PASSED ✅\n" + NOT_TESTED;
  assert.deepEqual(qaProblems(t, "pr-body-evidence", qa), [{ missing: "evidence for QA section API" }, { missing: "evidence for QA section Device" }]);
  assert.deepEqual(qaProblems(t, "pr-body-evidence-all", qa, ["automated", "api", "emulator"]), []);
});
