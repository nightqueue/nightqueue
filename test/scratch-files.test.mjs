import assert from "node:assert/strict";
import { test } from "node:test";
import { isScratchName, scratchFiles } from "../src/cli/scratch-files.mjs";

test("a scratch name is `*.poc.*`, `*SCRATCH*` or `*-QA-*`", () => {
  for (const path of ["test/foo.poc.test.mjs", "SHIP-QA-SCRATCH.md", "docs/X-QA-notes.md", "src/SCRATCH.txt", "a/b.poc.js"]) {
    assert.equal(isScratchName(path), true, path);
  }
});

test("real names pass: `qa`, `poc-helper` and lowercase `-qa-` are not scratch markers", () => {
  for (const path of ["test/foo.test.mjs", "src/qa.mjs", "test/poc-helper.test.mjs", "scripts/close-qa-demo.mjs", "docs/poc.md", "README.md"]) {
    assert.equal(isScratchName(path), false, path);
  }
  assert.equal(isScratchName(undefined), false);
});

test("scratchFiles keeps the scratch paths, and the paths under a run directory inside the worktree", () => {
  const paths = ["src/a.mjs", "test/a.poc.test.mjs", ".nq/run/notes.md", "docs/QA.md"];
  assert.deepEqual(scratchFiles(paths), ["test/a.poc.test.mjs"]);
  assert.deepEqual(scratchFiles(paths, { cwd: "/wt", runDir: "/wt/.nq/run" }), ["test/a.poc.test.mjs", ".nq/run/notes.md"]);
  assert.deepEqual(scratchFiles(paths, { cwd: "/wt", runDir: "/elsewhere/run" }), ["test/a.poc.test.mjs"]);
  assert.deepEqual(scratchFiles(null), []);
});
