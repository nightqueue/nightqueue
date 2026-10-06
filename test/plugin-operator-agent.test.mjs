import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_AGENT, operatorAgentPath } from "../src/host/operator.mjs";
import { newId } from "../src/config/ids.mjs";
import { OPERATOR_CLI_COMMANDS, OPERATOR_ROLES, qaBashAllowed } from "../src/queue/operator-scope.mjs";
import { pluginDir } from "../src/queue/spawn.mjs";

const AGENTS_DIR = join(pluginDir(), "agents");
const OPERATOR = readFileSync(operatorAgentPath(), "utf8");
const TRIAGER = readFileSync(join(AGENTS_DIR, "triager.md"), "utf8");
const QA = readFileSync(join(AGENTS_DIR, "qa.md"), "utf8");

// The value of one key of the leading frontmatter block, or null when the key is absent.
function frontmatterValue(text, key) {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/);
  const line = block?.[1].split("\n").find((entry) => entry.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1).trim() : null;
}

// The tools listed in an agent's frontmatter.
function toolsOf(text) {
  return (frontmatterValue(text, "tools") ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
}

// Reads one agent file of the plugin by its file name.
function readAgent(name) {
  return readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
}

test("the operator agent is `nightqueue-operator`, and `nightqueue open` addresses it by its plugin-scoped name", () => {
  const name = frontmatterValue(OPERATOR, "name");
  assert.equal(name, "nightqueue-operator");
  assert.equal(OPERATOR_AGENT, `nightqueue:${name}`);
});

test("the operator's tools carry no edit tool: it coordinates and never edits", () => {
  assert.deepEqual(toolsOf(OPERATOR), ["Agent", "Read", "Grep", "Glob", "Bash", "TodoWrite", "SendMessage", "mcp__nightqueue__*"]);
});

test("operator.md is at most 160 lines, names D-58 and its three subagents, and holds nothing of the operator runs", () => {
  assert.ok(OPERATOR.split("\n").length <= 160, `operator.md has ${OPERATOR.split("\n").length} lines`);
  assert.ok(OPERATOR.includes("D-58"));
  for (const role of OPERATOR_ROLES) assert.ok(OPERATOR.includes(`nightqueue:${role}`), `operator.md does not name nightqueue:${role}`);
  for (const gone of ["RUN_DIR", "run_set", "PRIOR RUN", "operator-qa", "run check", "nightqueue:triager", "nightqueue:architect", "nightqueue:verifier"]) {
    assert.equal(OPERATOR.includes(gone), false, `operator.md still names ${gone}`);
  }
});

test("the nightqueue commands operator.md names are exactly the guard's allowed list", () => {
  assert.ok(OPERATOR.includes(`\`nightqueue|nq ${OPERATOR_CLI_COMMANDS.allowed.join("|")} …\``));
});

test("the operator opens naming itself and the projects, and asks for project, memory and an issue before queueing", () => {
  for (const named of [
    "**the nightqueue operator**",
    "`name · key · <n> pending",
    "Current project (preselected by nightqueue open)",
    "`lesson_recall` and `decision_recall`",
    "`issue_save`",
    "call `queue_add` with `project`",
    "(set by the operator - the pipeline may only raise it, with evidence, never lower it)",
    "`nightqueue memory unavailable: run nightqueue doctor --fix and retry`",
  ]) {
    assert.ok(OPERATOR.replace(/\s+/g, " ").includes(named), `operator.md does not name ${named}`);
  }
});

test("triage, qa and reviewer parse, carry their own names, and collide with no other agent", () => {
  const files = readdirSync(AGENTS_DIR).filter((file) => file.endsWith(".md"));
  const names = files.map((file) => frontmatterValue(readFileSync(join(AGENTS_DIR, file), "utf8"), "name"));
  assert.equal(new Set(names).size, names.length, `duplicate agent names: ${names.join(", ")}`);
  for (const role of OPERATOR_ROLES) {
    const text = readAgent(role);
    assert.equal(frontmatterValue(text, "name"), role);
    assert.ok(frontmatterValue(text, "description"), `${role}.md has no description`);
    assert.ok(toolsOf(text).length > 0, `${role}.md has no tools`);
  }
});

test("only qa may edit among the operator's subagents", () => {
  assert.ok(toolsOf(QA).includes("Edit") && toolsOf(QA).includes("Write"));
  for (const role of ["triage", "reviewer"]) {
    for (const writer of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) assert.equal(toolsOf(readAgent(role)).includes(writer), false, `${role} ${writer}`);
  }
});

test("qa.md states the anchor is not a sandbox, and the only Bash shapes the guard accepts", () => {
  const flat = QA.replace(/\s+/g, " ");
  for (const named of [
    "**anchor, not a sandbox**",
    "`nightqueue sandbox worktree <project>`",
    "`nightqueue sandbox worktree --drop <path>`",
    "`cd <path> && <command>`",
    "a bare command is refused",
    "`QA_WORKTREE: <path>`",
  ]) {
    assert.ok(flat.includes(named), `qa.md does not name ${named}`);
  }
});

test("every command qa.md shows is one the qa guard accepts, and a bare command is refused", () => {
  const env = { NIGHTQUEUE_HOME: "/tmp/nightqueue-plugin-agent-home" };
  const path = join(env.NIGHTQUEUE_HOME, "qa", newId(), newId());
  const shown = [...QA.matchAll(/`((?:cd <path> && |nightqueue sandbox worktree )[^`]*)`/g)].map((match) => match[1]);
  assert.ok(shown.length >= 5, `only ${shown.length} commands found in qa.md`);
  for (const command of shown.filter((text) => !text.includes("<command>") && text.trim() !== "cd <path> &&")) {
    const concrete = command.replaceAll("<path>", path).replace("<project>", "demo").replace("…", "npm test");
    assert.equal(qaBashAllowed(concrete, env), true, concrete);
  }
  assert.equal(qaBashAllowed("npm test", env), false);
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
