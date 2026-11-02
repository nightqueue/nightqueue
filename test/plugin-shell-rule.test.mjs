import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/queue/spawn.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS_DIR = join(ROOT, "plugin/agents");
const REFUSAL = "too complex to verify that it stays inside the worktree";
const RUN_AGENTS = ["triager", "explore", "architect", "coder", "qa-guardian", "verifier", "reflector"];
const RULE_PREFIX = "Shell rule: ";

// The `## Inside a run` section of one run agent.
function runSection(agent) {
  const text = readFileSync(join(AGENTS_DIR, `${agent}.md`), "utf8");
  return text.slice(text.indexOf("## Inside a run"));
}

// The host refuses Bash it cannot prove stays inside the worktree; the skill says each agent carries the rule, the guard answers each refusal with its reason, and only a run reads it.
test("the worktree shell rule reaches the skill, stays out of the root prompt, and no agent file carries it outside a run", () => {
  const skill = readFileSync(join(ROOT, "plugin/skills/resolve/SKILL.md"), "utf8");
  assert.ok(skill.includes("Every agent definition carries the shell rule"), "the skill does not point at the shell rule of the agents");
  assert.match(skill, /every test command a phase runs goes under an explicit `timeout`/);
  const agents = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"));
  assert.ok(agents.length >= 6, "the agent files were not found");
  for (const name of agents) {
    const text = readFileSync(join(AGENTS_DIR, name), "utf8");
    assert.equal(text.includes("## Shell inside the worktree"), false, `${name} still carries the shell rule`);
    assert.equal(text.split("## Inside a run")[0].includes(REFUSAL), false, `${name} carries the shell rule outside a run`);
  }
  const prompt = buildPrompt({ job: { id: 1, prompt: "fix it" } });
  assert.equal(prompt.includes("Shell rule"), false, "the root prompt still carries the shell rule");
});

// The rule moved from the rendered prompts into the run section of every agent a run launches.
test("every run agent states the shell rule in one line and prescribes no command the host refuses", () => {
  for (const agent of RUN_AGENTS) {
    const lines = runSection(agent).split("\n");
    const rule = lines.find((line) => line.startsWith(RULE_PREFIX));
    assert.ok(rule, `${agent} does not repeat the shell rule`);
    assert.ok(rule.includes(REFUSAL), `the shell rule of ${agent} does not name the refusal`);
    assert.match(rule, /one simple command per Bash call, no heredocs \(`<<`\)/);
    const body = lines.filter((line) => line !== rule).join("\n");
    for (const refused of [/<<\s*['"]?[A-Z]/, /\bcd [^`\n]*&&/, /python3 - /, /node -e /]) {
      assert.equal(refused.test(body), false, `${agent} prescribes a command the host refuses: ${refused}`);
    }
  }
});
