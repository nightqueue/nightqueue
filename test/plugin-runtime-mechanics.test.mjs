import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const AGENTS = ["coder", "qa-guardian", "verifier", "triager", "explore", "architect"];
const SKILL = join(ROOT, "plugin/skills/resolve/SKILL.md");
const REPOSITORY_LINE = "Repository: [CWD PATH]";
const PROJECT_LINE = "Project: [PROJECT — the same identifier used in RUN_DIR]";
const RUNTIME_WORK = {
  verifier: "nightshift verify",
  explore: "nightshift libs",
  architect: "nightshift libs",
  "qa-guardian": "nightshift run secrets-sweep",
  triager: "Open pull requests matching this job:",
};

// Lists every file under plugin/ as an absolute path
function pluginFiles() {
  const dir = join(ROOT, "plugin");
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? entry.path, entry.name));
}

// Reads one plugin agent file with its line wrapping collapsed
function readAgent(agent) {
  return readFileSync(join(ROOT, `plugin/agents/${agent}.md`), "utf8").replace(/\s+/g, " ");
}

// The runtime resolves a path to its registered project, so no agent derives the project by hand.
test("no plugin file derives the project with git rev-parse", () => {
  const files = pluginFiles();
  assert.ok(files.length >= AGENTS.length + 1, "the plugin directory was not walked");
  const offenders = files.filter((file) => readFileSync(file, "utf8").includes("git-common-dir"));
  assert.deepEqual(offenders, [], `${offenders.length} plugin file(s) still derive the project by hand`);
});

// Each agent whose mechanical work moved into the runtime points at what replaced it.
test("each agent names the runtime work that replaced its prose", () => {
  for (const [agent, mention] of Object.entries(RUNTIME_WORK)) {
    assert.ok(readAgent(agent).includes(mention), `${agent} does not name \`${mention}\``);
  }
  assert.equal(
    readAgent("explore").includes("nightshift run index-save"),
    true,
    "explore does not say the runtime persists the index from its artifact",
  );
});

// The verifier reads the scale of the diff off the block instead of running its own git commands.
test("the verifier reads the diff-hygiene line instead of running git itself", () => {
  const agent = readAgent("verifier");
  assert.ok(agent.includes("The `diff-hygiene` line of the `nightshift verify` block"), "the verifier lost the diff-hygiene pointer");
  assert.ok(agent.includes("the summary of `git diff --stat`"), "the verifier does not report the scale of the change");
});

// Every orchestrator prompt template that carries the repository path also names the project.
test("each Repository template of the skill carries a Project line", () => {
  const lines = readFileSync(SKILL, "utf8").split("\n");
  const projectLines = lines.filter((line) => line.trim() === PROJECT_LINE);
  assert.equal(projectLines.length, 11, "the skill does not carry 11 Project lines");
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== REPOSITORY_LINE) continue;
    assert.equal(
      lines[index + 1]?.trim(),
      PROJECT_LINE,
      `the Repository template at line ${index + 1} is not followed by its Project line`,
    );
  }
});

// The secret-in-a-log sweep is a runtime command now, and its mandatory readings survive a host where the plugin root does not resolve.
test("the qa-guardian calls the sweep and still resolves its own plugin paths", () => {
  const agent = readAgent("qa-guardian");
  const skill = readFileSync(SKILL, "utf8");
  assert.ok(agent.includes("nightshift run secrets-sweep --files"), "qa-guardian does not call the sweep command");
  assert.equal(agent.includes("grep -niE"), false, "qa-guardian still runs the greps the command replaced");
  assert.ok(
    agent.includes("fall back to `Glob` for `**/skills/qa-guardian/SKILL.md`"),
    "qa-guardian lost the Glob fallback for a prompt that brings no absolute path",
  );
  assert.equal(
    skill.split("\n").filter((line) => line.startsWith("QA_SKILL: ")).length,
    3,
    "the three qa-guardian prompts do not all carry the plugin paths",
  );
  assert.ok(
    skill.replace(/\s+/g, " ").includes("If it does not resolve, omit those three lines entirely"),
    "the skill does not tell the orchestrator to omit the paths it could not resolve",
  );
});

// The agents have a standalone caller too, so the contract must stay safe for a prompt with no Project.
test("each agent states the fallback for a prompt that carries no Project", () => {
  for (const agent of AGENTS) {
    const text = readAgent(agent);
    assert.ok(
      text.includes("pass that path verbatim"),
      `${agent} does not say a bare Repository: path is a valid project value`,
    );
    assert.ok(
      text.includes("With neither, call it without `project`"),
      `${agent} does not say what to pass when the prompt carries neither`,
    );
    assert.ok(
      text.includes("cross-project lessons, not an error"),
      `${agent} does not state the degraded outcome of a project-less recall`,
    );
  }
});
