import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { TIERS, loadedBytes, loadedFiles } from "../test-support/skill-size.mjs";

// Ceiling of the resolve skill bytes each tier loads; a ratchet: lower it when the skill shrinks, never raise it to fit a change.
const CEILING_BYTES = Object.freeze({ trivial: 104104, simple: 104104, complex: 112347 });

test("every file a tier loads exists, so a moved file cannot drop out of the budget", () => {
  for (const tier of TIERS) {
    for (const path of loadedFiles(tier)) assert.ok(existsSync(path), `${tier} loads ${path}, which is not on disk`);
  }
});

test("every tier loads no more resolve skill bytes than its ceiling", () => {
  for (const tier of TIERS) {
    const bytes = loadedBytes(tier);
    assert.ok(bytes <= CEILING_BYTES[tier], `${tier} loads ${bytes} bytes of the resolve skill, over its ceiling of ${CEILING_BYTES[tier]}`);
  }
});
