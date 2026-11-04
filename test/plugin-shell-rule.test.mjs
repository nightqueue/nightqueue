import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/queue/spawn.mjs";
import { phasePrompts } from "../test-support/skill-size.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS_DIR = join(ROOT, "plugin/agents");
const REFUSAL = "too complex to verify that it stays inside the worktree";
const RUN_AGENTS = ["triager", "explore", "architect", "coder", "qa-guardian", "verifier", "reflector"];
const RULE_PREFIX = "Shell rule: ";
const REFUSED = [/<<\s*['"]?[A-Z]/, /\bcd [^`\n]*&&/, /python3 - /, /node -e /];

// The host refuses Bash it cannot prove stays inside the worktree; the skill says each block carries the rule, and only a run reads it.
test("the worktree shell rule reaches the skill, stays out of the root prompt, and no agent file carries it", () => {
  const skill = readFileSync(join(ROOT, "plugin/skills/resolve/SKILL.md"), "utf8");
  assert.ok(skill.includes("Every block carries the shell rule through `<LANE>`"), "the skill does not point at the shell rule of the blocks");
  assert.match(skill, /every test command a phase runs goes under an explicit `timeout`/);
  const agents = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"));
  assert.ok(agents.length >= 6, "the agent files were not found");
  for (const name of agents) {
    const text = readFileSync(join(AGENTS_DIR, name), "utf8");
    assert.equal(text.includes("## Shell inside the worktree"), false, `${name} still carries the shell rule`);
    assert.equal(text.includes(REFUSAL), false, `${name} carries the shell rule`);
    assert.equal(text.includes(RULE_PREFIX), false, `${name} carries the shell rule`);
  }
  const prompt = buildPrompt({ job: { id: 1, prompt: "fix it" } });
  assert.equal(prompt.includes("Shell rule"), false, "the root prompt still carries the shell rule");
});

// The rule lives only in the blocks, so no agent prescribes a command the host refuses.
test("no run agent prescribes a command the host refuses", () => {
  for (const agent of RUN_AGENTS) {
    const prose = readFileSync(join(AGENTS_DIR, `${agent}.md`), "utf8").replaceAll("<<<UNTRUSTED DATA>>>", "");
    for (const refused of REFUSED) assert.equal(refused.test(prose), false, `${agent} prescribes a command the host refuses: ${refused}`);
  }
});

// Every launch carries the rule through the shared `<LANE>` snippet, and no block prescribes a command the host refuses.
test("every block expands `<LANE>` into the one-line shell rule and prescribes no command the host refuses", () => {
  const { snippets, blocks, written } = phasePrompts();
  const rule = snippets.LANE.find((line) => line.startsWith(RULE_PREFIX));
  assert.ok(rule?.includes(REFUSAL), "the `<LANE>` snippet does not state the shell rule");
  assert.match(rule, /one simple command per Bash call, no heredocs \(`<<`\)/);
  for (const [target, lines] of Object.entries(blocks)) {
    assert.ok(written[target].includes("<LANE>"), `the ${target} block does not carry \`<LANE>\``);
    assert.equal(lines.filter((line) => line === rule).length, 1, `the ${target} block does not state the shell rule once`);
    const body = lines.filter((line) => line !== rule).join("\n");
    for (const refused of REFUSED) assert.equal(refused.test(body), false, `the ${target} block prescribes a command the host refuses: ${refused}`);
  }
});
