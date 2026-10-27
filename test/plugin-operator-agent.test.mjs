import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { OPERATOR_AGENT, operatorAgentPath } from "../src/host/operator.mjs";
import { OPERATOR_CLI_COMMANDS, PIPELINE_AGENTS } from "../src/queue/operator-scope.mjs";
import { pluginDir } from "../src/queue/spawn.mjs";

const AGENTS_DIR = join(pluginDir(), "agents");
const OPERATOR = readFileSync(operatorAgentPath(), "utf8");
const TRIAGER = readFileSync(join(AGENTS_DIR, "triager.md"), "utf8");
const DELEGATED = ["triager", "explore", "architect", "qa-guardian", "verifier", "coder", "reviewer"];

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

// The body of one `## <heading>` section of operator.md, or "" when it is absent.
function sectionOf(heading) {
  return OPERATOR.split(`\n## ${heading}\n`)[1]?.split("\n## ")[0] ?? "";
}

test("the operator agent is `nightqueue-operator`, and `nightqueue open` addresses it by its plugin-scoped name", () => {
  const name = frontmatterValue(OPERATOR, "name");
  assert.equal(name, "nightqueue-operator");
  assert.equal(OPERATOR_AGENT, `nightqueue:${name}`);
});

test("the operator's tools carry the four edit tools, which the guard holds to a consent, and the two web reads", () => {
  assert.deepEqual(toolsOf(OPERATOR), [
    "Agent", "Read", "Grep", "Glob", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit",
    "WebFetch", "WebSearch", "TodoWrite", "SendMessage", "Skill", "mcp__nightqueue__*",
  ]);
});

test("the operator offers the reflect skill in its Reflect section, saving with `project`", () => {
  const section = sectionOf("Reflect");
  assert.ok(section.includes("`nightqueue:reflect`"), "operator.md has no Reflect section naming nightqueue:reflect");
  assert.ok(section.includes("Only confirmed candidates are saved."));
  assert.ok(OPERATOR.includes("`lesson_save`, `memory_save`,"));
});

// The cap went from 170 to 200 when the three-band table, the seven delegated agents and the direct-change steps landed.
test("operator.md is at most 200 lines, names the operator guard, and holds nothing of the operator runs, the decisions or the deleted agents", () => {
  assert.ok(OPERATOR.split("\n").length <= 200, `operator.md has ${OPERATOR.split("\n").length} lines`);
  assert.ok(OPERATOR.includes("## The operator guard contract (read first)"));
  assert.ok(OPERATOR.includes("starts with `operator guard:`"));
  assert.ok(OPERATOR.includes("## Operator decisions (binding)"));
  assert.equal(/\bD-\d+/.test(OPERATOR), false, "operator.md still cites a D-<n> ref");
  for (const gone of ["RUN_DIR", "run_set", "PRIOR RUN", "operator-qa", "run check", "decision_", "Standing decisions", "decision export", "nightqueue:qa`", "nightqueue:triage`", "QA_WORKTREE"]) {
    assert.equal(OPERATOR.includes(gone), false, `operator.md still names ${gone}`);
  }
});

test("operator.md states the three bands, never the old never-edits contract, and says what needs consent", () => {
  assert.equal(/never (edits?|executes?)\b/i.test(OPERATOR), false, "operator.md still says it never edits or executes");
  const bands = sectionOf("What you may do");
  for (const band of ["| **Free** |", "| **With consent** |", "| **Never** |"]) assert.ok(bands.includes(band), `the table has no ${band} row`);
  for (const kind of ["`edit`", "`create`", "`run`", "`git-write`", "`connection-write`", "`home-maintenance`", "`operator_consent`", "`revoke: true`"]) {
    assert.ok(bands.includes(kind), `What you may do does not name ${kind}`);
  }
  assert.ok(bands.includes("| **Home cleanup (with consent)** |"), "the table has no Home cleanup row");
  assert.ok(bands.includes("Never `runs/`, `worktrees/` or a project's whole directory"), "the table does not state the whole-directory rule");
  const flat = OPERATOR.replace(/\s+/g, " ");
  assert.ok(flat.includes("say what needs the person's consent"));
  assert.ok(flat.includes("The runtime record is the audit and the guard; the host's permission prompt is the barrier for Edit, Write and Bash only"));
  assert.ok(flat.includes("`operator_consent` and `connection_call` are pre-approved: for them the guard's record is the only control"));
  assert.ok(flat.includes("`git push origin` covers every ref, so the ask shows that reach"), "operator.md does not state the prefix semantics");
  assert.equal(/tier/i.test(OPERATOR), false, "operator.md still queues a tier");
});

test("operator.md delegates to the seven pipeline agents with an inline request, and lists the direct-change steps", () => {
  const delegation = sectionOf("Delegation");
  for (const agent of DELEGATED) assert.ok(delegation.includes(`\`nightqueue:${agent}\``), `Delegation does not name nightqueue:${agent}`);
  for (const part of ["**Inputs**", "**Deliver**", "**Return**", "capped at 2", "`cd <checkout> && <command>`"]) {
    assert.ok(delegation.includes(part), `Delegation does not name ${part}`);
  }
  const direct = sectionOf("Direct changes");
  for (const step of ["`operator_consent`", "`nightqueue:coder`", "no worktree", "`git -C <checkout> diff --stat`", "`git-write`", "`/nightqueue:reflect`"]) {
    assert.ok(direct.includes(step), `Direct changes does not name ${step}`);
  }
});

test("the nightqueue commands operator.md names are exactly the guard's allowed list", () => {
  assert.ok(OPERATOR.includes(`\`nightqueue|nq ${OPERATOR_CLI_COMMANDS.allowed.join("|")} …\``));
});

test("the operator opens naming itself and the projects, and asks for project and memory before queueing", () => {
  for (const named of [
    "**the nightqueue operator**",
    "`name · key · <n> pending`",
    "`Registered projects`",
    "no `nightqueue project list`, no `queue_status`, no `lesson_recall`",
    "Current project (preselected by nightqueue open)",
    "`lesson_recall` once, with that `project`",
    "1. Queue from the brief.",
    "call `queue_add` with `project`",
    "`nightqueue memory unavailable: run nightqueue doctor --fix and retry`",
  ]) {
    assert.ok(OPERATOR.replace(/\s+/g, " ").includes(named), `operator.md does not name ${named}`);
  }
});

test("PIPELINE_AGENTS is the plugin's agents but the operator, every agent name is unique, and triage.md and qa.md are gone", () => {
  const files = readdirSync(AGENTS_DIR).filter((file) => file.endsWith(".md"));
  const names = files.map((file) => frontmatterValue(readFileSync(join(AGENTS_DIR, file), "utf8"), "name"));
  assert.equal(new Set(names).size, names.length, `duplicate agent names: ${names.join(", ")}`);
  assert.deepEqual([...PIPELINE_AGENTS].sort(), names.filter((name) => name !== "nightqueue-operator").sort());
  for (const gone of ["triage.md", "qa.md"]) assert.equal(existsSync(join(AGENTS_DIR, gone)), false, `${gone} still exists`);
});

test("the triager's request opens its verdict with `Evidence level: <1-4>`, and the 0-4 scale is gone", () => {
  const request = readFileSync(join(pluginDir(), "skills/resolve/references/prompts/triager.md"), "utf8");
  const lines = request.split("\n");
  const verdict = lines.findIndex((line) => line.startsWith("## Verdict:"));
  assert.notEqual(verdict, -1, "the triager request has no `## Verdict:` template");
  const firstLine = lines.slice(verdict + 1).find((line) => line.trim() !== "");
  assert.equal(firstLine, "Evidence level: <1-4>");
  for (const text of [TRIAGER, request]) {
    assert.equal(text.includes("0-4"), false);
    assert.equal(/evidence level 0\b/i.test(text), false);
  }
});
