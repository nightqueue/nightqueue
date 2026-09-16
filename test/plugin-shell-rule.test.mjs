import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPrompt } from "../src/queue/spawn.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS = ["coder", "qa-guardian", "verifier", "triager", "explore", "architect"];
const REFUSAL = "too complex to verify that it stays inside the worktree";

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
