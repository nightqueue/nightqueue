import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/queue/spawn.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS_DIR = join(ROOT, "plugin/agents");
const REFUSAL = "too complex to verify that it stays inside the worktree";
const PROMPTS = join(ROOT, "plugin/skills/resolve/references/prompts");

// The host refuses Bash it cannot prove stays inside the worktree; the skill points at the rule every prompt carries, the unattended prompt says it, and an agent gets the rule from its request, never its own file.
test("the worktree shell rule reaches the skill and the unattended prompt, and no agent file carries it", () => {
  const skill = readFileSync(join(ROOT, "plugin/skills/resolve/SKILL.md"), "utf8");
  assert.ok(skill.includes("Every prompt carries the shell rule (`references/prompts/_shell-rule.md`)"), "the skill does not point at the shell rule of the prompts");
  assert.match(skill, /every test command a phase runs goes under an explicit `timeout`/);
  assert.ok(readFileSync(join(PROMPTS, "_shell-rule.md"), "utf8").includes(REFUSAL), "the shell rule the skill points at does not name the refusal");
  const agents = readdirSync(AGENTS_DIR).filter((name) => name.endsWith(".md"));
  assert.ok(agents.length >= 6, "the agent files were not found");
  for (const name of agents) {
    const text = readFileSync(join(AGENTS_DIR, name), "utf8");
    assert.equal(text.includes("## Shell inside the worktree"), false, `${name} still carries the shell rule`);
  }
  const prompt = buildPrompt({ job: { id: 1, prompt: "fix it" } });
  assert.match(prompt, /Shell rule: .*one simple command per Bash call, no heredocs/);
  assert.ok(!prompt.includes("Open pull requests"), "a caller that brings no pull request answer gets the prompt it has today");
});

// The subagent prompts are rendered from templates now, so the one-line rule the skill asked every brief to repeat lives in them.
test("every subagent prompt template repeats the shell rule in one line and prescribes no command the host refuses", () => {
  const rule = readFileSync(join(PROMPTS, "_shell-rule.md"), "utf8").trim();
  assert.equal(rule.split("\n").length, 1, "the shell rule of the prompts is not one line");
  assert.ok(rule.includes(REFUSAL), "the shell rule of the prompts does not name the refusal");
  assert.match(rule, /one simple command per Bash call, no heredocs \(`<<`\)/);
  assert.ok(readFileSync(join(PROMPTS, "triager.md"), "utf8").includes("{{>_shell-rule}}"), "the triager request does not carry the shell rule");
  for (const name of readdirSync(PROMPTS).filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(join(PROMPTS, name), "utf8");
    if (!name.startsWith("_")) assert.ok(text.includes("{{>_shell-rule}}"), `${name} does not repeat the shell rule`);
    const body = name === "_shell-rule.md" ? "" : text;
    for (const refused of [/<<\s*['"]?[A-Z]/, /\bcd [^`\n]*&&/, /python3 - /, /node -e /]) {
      assert.equal(refused.test(body), false, `${name} prescribes a command the host refuses: ${refused}`);
    }
  }
});
