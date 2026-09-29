import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyProblems } from "../../src/cli/pr-body.mjs";

// The traceability refusals of a body, ignoring the structure rules of the template.
function traceability(body) {
  return bodyProblems({ body, template: { source: "nightqueue" }, evidenceDir: "", slug: null, jobId: null })
    .map((problem) => problem.rejected ?? "")
    .filter((line) => line.includes("which `run pr` appends from the job row"));
}

test("a code span hard-wrapped over two lines is a code span: its J-12 is not a job id", () => {
  const wrapped = "run `nightqueue queue status\nJ-12` to see it";
  assert.deepEqual(traceability(wrapped), [], "a wrapped code span was refused as a job id");
});

test("a bare J-12 on its own line is still refused", () => {
  assert.equal(traceability("this ran as J-12 before").length, 1);
});
