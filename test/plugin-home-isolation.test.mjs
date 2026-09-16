import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const RESOLVE = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
const VERIFIER = readFileSync(new URL("../plugin/agents/verifier.md", import.meta.url), "utf8");

const INVARIANTS = ["nightshift sandbox <cmd>", "not verifiable here"];

test("the resolve skill tells the pipeline to verify against a throwaway home and host", () => {
  for (const invariant of INVARIANTS) {
    assert.ok(RESOLVE.includes(invariant), `\`${invariant}\` is missing from the resolve skill`);
  }
  assert.ok(
    RESOLVE.includes("Manual acceptance never runs against the operator's own home"),
    "the resolve skill never states the rule as a rule",
  );
  assert.ok(RESOLVE.includes("isolation rule of Phase 6"), "Phase 6.5 does not point at the isolation rule of Phase 6");
});

test("the verifier agent carries the same rule as its own step, before the report", () => {
  for (const invariant of INVARIANTS) {
    assert.ok(VERIFIER.includes(invariant), `\`${invariant}\` is missing from the verifier agent`);
  }
  const step = VERIFIER.indexOf("### Step 2.9 — Manual acceptance never runs against the operator's own home");
  assert.notEqual(step, -1, "the verifier agent has no step about the operator's own home");
  assert.ok(step < VERIFIER.indexOf("### Step 3 — Report"), "the rule was written after the report step");
});

test("neither file tells the operator to hand-roll a throwaway home with mktemp anymore", () => {
  assert.equal(RESOLVE.includes("mktemp"), false, "the resolve skill still mentions mktemp");
  assert.equal(VERIFIER.includes("mktemp"), false, "the verifier agent still mentions mktemp");
});
