import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const RESOLVE = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
const VERIFIER = readFileSync(new URL("../plugin/agents/verifier.md", import.meta.url), "utf8");

const QA_AGENT = readFileSync(new URL("../plugin/agents/qa-guardian.md", import.meta.url), "utf8");
const QA_SKILL = readFileSync(new URL("../plugin/skills/qa-guardian/SKILL.md", import.meta.url), "utf8");

const INVARIANTS = ["nightshift sandbox <cmd>", "not verifiable here"];

const GUARD_RULES_BLOCK = [
  "**Real pull requests and nightshift guards — hard rules.**",
  "",
  "- **(a)** Never unset, stub, override or work around a nightshift guard or its environment variables (`NIGHTSHIFT_JOB_ID`, `NIGHTSHIFT_JOB_HOME`, `NIGHTSHIFT_JOB_CLAUDE_DIR`, or any refusal nightshift prints) — not in a child env, not by calling the internal function behind the refusing command, not by a 'simulation'. A refusal is the guard working. A verification that can only proceed by bypassing one stops and is reported as a gate (`## Requires user confirmation`), never worked around.",
  "- **(b)** Any verification that creates, merges or closes a real pull request runs only in `~/Dev/nstest-demo` (remote `maykonVinicius/nstest-demo`) — never in the project's own repository or any other remote. If that checkout does not exist on this machine, no real pull request is created, merged or closed: the scenario is reported as a gate. The only publication the pipeline ever makes to the project's own origin is Phase 7's `nightshift run pr`.",
].join("\n");

const GUARD_RULE_FILES = { "resolve skill": RESOLVE, "verifier agent": VERIFIER, "qa-guardian agent": QA_AGENT, "qa-guardian skill": QA_SKILL };

test("the four pipeline and QA instruction files carry the real pull request and guard rules, byte-identical", () => {
  for (const [name, text] of Object.entries(GUARD_RULE_FILES)) {
    assert.ok(text.includes(GUARD_RULES_BLOCK), `the ${name} lost or changed the hard rules on real pull requests and nightshift guards`);
  }
});

test("the verifier agent states the guard rules as Step 2.10, after Step 2.9 and before the report", () => {
  const step = VERIFIER.indexOf("### Step 2.10 — Real pull requests and nightshift guards in verification");
  assert.notEqual(step, -1, "the verifier agent has no Step 2.10");
  assert.ok(step > VERIFIER.indexOf("### Step 2.9 —"), "Step 2.10 sits before Step 2.9");
  assert.ok(step < VERIFIER.indexOf(GUARD_RULES_BLOCK), "the rules are not under Step 2.10");
  assert.ok(VERIFIER.indexOf(GUARD_RULES_BLOCK) < VERIFIER.indexOf("### Step 3 — Report"), "the rules were written after the report step");
});

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
