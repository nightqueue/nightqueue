import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_AGENT, operatorAgentPath } from "../src/host/operator.mjs";
import { OPERATOR_BASH_RULES } from "../src/queue/orchestrator-scope.mjs";
import { pluginDir } from "../src/queue/spawn.mjs";

const OPERATOR = readFileSync(operatorAgentPath(), "utf8");
const TRIAGER = readFileSync(join(pluginDir(), "agents", "triager.md"), "utf8");

// The value of one key of the leading frontmatter block, or null when the key is absent.
function frontmatterValue(text, key) {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/);
  const line = block?.[1].split("\n").find((entry) => entry.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : null;
}

test("the operator agent is `nightshift-operator`, and `nightshift open` addresses it by its plugin-scoped name", () => {
  const name = frontmatterValue(OPERATOR, "name");
  assert.equal(name, "nightshift-operator");
  assert.equal(OPERATOR_AGENT, `nightshift:${name}`);
});

test("the operator's tools carry no Edit nor Write: it coordinates and never edits", () => {
  const tools = frontmatterValue(OPERATOR, "tools").split(",").map((tool) => tool.trim());
  assert.deepEqual(tools, ["Agent", "Read", "Bash", "TodoWrite", "SendMessage", "mcp__nightshift__*"]);
  for (const writer of ["Edit", "Write", "NotebookEdit", "MultiEdit"]) assert.equal(tools.includes(writer), false, writer);
});

test("the operator's text names only commands its guard allows: no fetch, no run commit, the QA worktree by its relative path", () => {
  assert.equal(OPERATOR.includes("git fetch"), false);
  assert.equal(OPERATOR.includes("nightshift run commit"), false);
  assert.equal(OPERATOR.includes("nightshift run pr"), false);
  for (const named of ["gh issue list|view", "adb devices", "gh pr list|view|status|checks", "git log --oneline -n <N>", ".claude/worktrees/operator-qa-<slug>"]) {
    assert.ok(OPERATOR.includes(named), `operator.md does not name ${named}`);
  }
  assert.ok(OPERATOR_BASH_RULES.some(({ argv }) => argv.join(" ") === "adb devices"));
});

test("every `nightshift run check` the operator runs names its run, the only way the check resolves outside a job", () => {
  const checks = [...OPERATOR.matchAll(/nightshift run check ([0-9.a]+)([^`]*)`/g)];
  assert.ok(checks.length >= 5, `only ${checks.length} checks found`);
  for (const [whole, , rest] of checks) assert.match(rest, /--project <project> --slug <slug>/, whole);
});

test("the operator records what the resume needs, and a session that queues nothing still leaves its row", () => {
  for (const named of ["run_dir", "investigated", "`origin: \"operator\"`", "evidence_level", "plan_status", "skills/resolve/references/qa-phase.md"]) {
    assert.ok(OPERATOR.includes(named), `operator.md does not name ${named}`);
  }
});

test("the triager's verdict opens with `Evidence level: <1|2|3|4>`, and the 0-4 scale is gone", () => {
  const lines = TRIAGER.split("\n");
  const verdict = lines.findIndex((line) => line.startsWith("## Verdict:"));
  assert.notEqual(verdict, -1, "triager.md has no `## Verdict:` template");
  const firstLine = lines.slice(verdict + 1).find((line) => line.trim() !== "");
  assert.equal(firstLine, "Evidence level: <1|2|3|4>");
  assert.equal(TRIAGER.includes("0-4"), false);
  assert.equal(/evidence level 0\b/i.test(TRIAGER), false);
});
