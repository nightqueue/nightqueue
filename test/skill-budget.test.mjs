import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { loadedBytes, loadedFiles } from "../test-support/skill-size.mjs";

// Ceiling of the resolve skill bytes a run loads; a ratchet: lower it when the skill shrinks, never raise it to fit a change.
const CEILING_BYTES = 112347;

test("every file a run loads exists, so a moved file cannot drop out of the budget", () => {
  for (const path of loadedFiles()) assert.ok(existsSync(path), `a run loads ${path}, which is not on disk`);
});

test("a run loads no more resolve skill bytes than its ceiling", () => {
  const bytes = loadedBytes();
  assert.ok(bytes <= CEILING_BYTES, `a run loads ${bytes} bytes of the resolve skill, over its ceiling of ${CEILING_BYTES}`);
});
