import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { phasePrompts } from "../test-support/skill-size.mjs";

const AGENTS = new URL("../plugin/agents/", import.meta.url);

const RESOLVE = readFileSync(new URL("../plugin/skills/resolve/SKILL.md", import.meta.url), "utf8");
const VERIFIER = readFileSync(new URL("../plugin/agents/verifier.md", import.meta.url), "utf8");

const QA_AGENT = readFileSync(new URL("../plugin/agents/qa-guardian.md", import.meta.url), "utf8");
const QA_SKILL = readFileSync(new URL("../plugin/skills/qa-guardian/SKILL.md", import.meta.url), "utf8");

const INVARIANTS = ["nightqueue sandbox <cmd>", "not verifiable here"];

const GUARD_RULES_BLOCK = [
  "**Real pull requests and nightqueue guards — hard rules.**",
  "",
  "- **(a)** Never unset, stub, override or work around a nightqueue guard or its environment variables (`NIGHTQUEUE_JOB_ID`, `NIGHTQUEUE_JOB_HOME`, `NIGHTQUEUE_JOB_CLAUDE_DIR`, `NIGHTQUEUE_JOB_CLAIM`, or any refusal nightqueue prints) — not in a child env, not by calling the internal function behind the refusing command, not by a 'simulation'. A refusal is the guard working. A verification that can only proceed by bypassing one stops and is reported as an open item, never worked around.",
  "- **(b)** Any verification that creates, merges or closes a real pull request runs only in the configured demo repository (the request names it; `nightqueue project demo-repo <project>` shows it) — never in the project's own repository or any other remote. With none configured, no real pull request is created, merged or closed: the scenario is reported as an open item. The only publication ever made to the project's own origin is the runtime's own publish step, which opens it through the runtime's pull-request path.",
].join("\n");

const GUARD_RULE_FILES = { "verifier agent": VERIFIER, "qa-guardian agent": QA_AGENT, "qa-guardian skill": QA_SKILL };

test("the three QA and verification instruction files carry the real pull request and guard rules, byte-identical", () => {
  for (const [name, text] of Object.entries(GUARD_RULE_FILES)) {
    assert.ok(text.includes(GUARD_RULES_BLOCK), `the ${name} lost or changed the hard rules on real pull requests and nightqueue guards`);
  }
});

test("the verifier agent states the guard rules as Step 2.10, after Step 2.9 and before proving by execution", () => {
  const step = VERIFIER.indexOf("### Step 2.10 — Real pull requests and nightqueue guards in verification");
  const proving = VERIFIER.indexOf("\n## Proving by execution\n");
  assert.notEqual(step, -1, "the verifier agent has no Step 2.10");
  assert.notEqual(proving, -1, "the verifier agent has no `## Proving by execution`");
  assert.ok(step > VERIFIER.indexOf("### Step 2.9 —"), "Step 2.10 sits before Step 2.9");
  assert.ok(step < VERIFIER.indexOf(GUARD_RULES_BLOCK), "the rules are not under Step 2.10");
  assert.ok(VERIFIER.indexOf(GUARD_RULES_BLOCK) < proving, "the rules were written after proving by execution");
});

test("the resolve skill carries no subagent method: no sandbox rule, no guard rules, no demo path", () => {
  for (const text of ["Manual acceptance never runs", "hard rules", "nstest-demo"]) {
    assert.equal(RESOLVE.includes(text), false, `the resolve skill still carries \`${text}\``);
  }
});

test("the agents keep the configured demo repository and no machine path", () => {
  for (const [name, text] of Object.entries(GUARD_RULE_FILES)) {
    assert.ok(text.includes("nightqueue project demo-repo <project>"), `the ${name} does not point at the configured demo repository`);
    assert.equal(/~\/Dev|nstest-demo/.test(text), false, `the ${name} still names a machine path`);
  }
});

test("the verifier agent carries the same rule as its own step, before proving by execution", () => {
  for (const invariant of INVARIANTS) {
    assert.ok(VERIFIER.includes(invariant), `\`${invariant}\` is missing from the verifier agent`);
  }
  const step = VERIFIER.indexOf("### Step 2.9 — Manual acceptance never runs against the operator's own home");
  assert.notEqual(step, -1, "the verifier agent has no step about the operator's own home");
  assert.ok(step < VERIFIER.indexOf("\n## Proving by execution\n"), "the rule was written after proving by execution");
});

test("neither file tells the operator to hand-roll a throwaway home with mktemp anymore", () => {
  assert.equal(RESOLVE.includes("mktemp"), false, "the resolve skill still mentions mktemp");
  assert.equal(VERIFIER.includes("mktemp"), false, "the verifier agent still mentions mktemp");
});

test("the agents a run launches and their blocks keep the home isolation: no hand-rolled home, and the runtime lane goes through the sandbox", () => {
  const names = readdirSync(AGENTS).filter((name) => name.endsWith(".md"));
  assert.ok(names.length >= 7, "the agent files were not found");
  const texts = [["SKILL.md", RESOLVE], ...names.map((name) => [name, readFileSync(new URL(name, AGENTS), "utf8")])];
  for (const [name, text] of texts) {
    assert.equal(text.includes("mktemp"), false, `${name} tells a subagent to hand-roll a throwaway home`);
    assert.equal(/NIGHTQUEUE_HOME=/.test(text), false, `${name} tells a subagent to export a home`);
    assert.equal(/NIGHTQUEUE_JOB_(ID|HOME|CLAUDE_DIR)=/.test(text), false, `${name} tells a subagent to override a nightqueue guard`);
  }
  const runtime = phasePrompts().blocks.runtime.join("\n");
  assert.ok(runtime.includes("`nightqueue sandbox`"), "the runtime lane lost the sandbox rule");
});
