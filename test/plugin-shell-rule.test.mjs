import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/queue/spawn.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS = ["coder", "qa-guardian", "verifier", "triager", "explore", "architect"];
const REFUSAL = "too complex to verify that it stays inside the worktree";
const PROMPTS = join(ROOT, "plugin/skills/resolve/references/prompts");

// The host refuses Bash it cannot prove stays inside the worktree; every place that briefs an agent has to say how to write commands it accepts.
test("the worktree shell rule reaches the skill, every agent and the unattended prompt", () => {
  const skill = readFileSync(join(ROOT, "plugin/skills/resolve/SKILL.md"), "utf8");
  assert.ok(skill.includes(REFUSAL), "the skill does not name the refusal");
  assert.match(skill, /no heredocs \(`<<`\)/);
  for (const agent of AGENTS) {
    const text = readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8");
    assert.ok(text.includes("## Shell inside the worktree (mandatory)"), `${agent} carries no shell rule`);
    assert.ok(text.includes(REFUSAL), `${agent} does not name the refusal`);
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
  for (const name of readdirSync(PROMPTS).filter((file) => file.endsWith(".md"))) {
    const text = readFileSync(join(PROMPTS, name), "utf8");
    if (!name.startsWith("_")) assert.ok(text.includes("{{>_shell-rule}}"), `${name} does not repeat the shell rule`);
    const body = name === "_shell-rule.md" ? "" : text;
    for (const refused of [/<<\s*['"]?[A-Z]/, /\bcd [^`\n]*&&/, /python3 - /, /node -e /]) {
      assert.equal(refused.test(body), false, `${name} prescribes a command the host refuses: ${refused}`);
    }
  }
});
