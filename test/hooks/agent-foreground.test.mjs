import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgentForeground } from "../../src/hooks/agent-foreground.mjs";

const ENV = { NIGHTSHIFT_JOB_ID: "7" };
const REASON = "the unattended run keeps subagents in the foreground so the CLI never kills one at its wait ceiling";

// Event JSON the host sends for a PreToolUse call of the orchestrator's main thread, with the given tool and its input.
function preToolUse(toolName, toolInput) {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput };
}

// Event JSON the host sends for a PreToolUse call made by a subagent: the same payload plus its agent_id and agent_type.
function subagentPreToolUse(toolName, toolInput) {
  return { ...preToolUse(toolName, toolInput), agent_id: "a83ebd0b428a73e4b", agent_type: "general-purpose" };
}

test("a launch without run_in_background is normalised to false, every original key kept", () => {
  const answer = runAgentForeground({
    input: preToolUse("Agent", { description: "verifier", prompt: "check the diff" }),
    env: ENV,
  });
  assert.deepEqual(JSON.parse(answer), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { description: "verifier", prompt: "check the diff", run_in_background: false },
    },
  });
});

test("run_in_background: true is normalised to false, with the reason", () => {
  const answer = runAgentForeground({
    input: preToolUse("Task", { prompt: "run the qa pass", run_in_background: true }),
    env: ENV,
  });
  assert.deepEqual(JSON.parse(answer), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: REASON,
      updatedInput: { prompt: "run the qa pass", run_in_background: false },
    },
  });
});

test("a tool call that already asks for the foreground answers nothing", () => {
  const answer = runAgentForeground({
    input: preToolUse("Agent", { prompt: "run the qa pass", run_in_background: false }),
    env: ENV,
  });
  assert.equal(answer, "");
});

test("a subagent's Read, or a tool the hook does not scope, answers nothing", () => {
  assert.equal(runAgentForeground({ input: subagentPreToolUse("Read", { file_path: "a.mjs" }), env: ENV }), "");
  assert.equal(runAgentForeground({ input: preToolUse("Edit", { file_path: "a.mjs" }), env: ENV }), "");
});

const DENY_REASON_SUFFIX = "restrict the search to the worktree (`$WORKTREE`) or the project checkout";

test("a background Bash call is rewritten to the foreground, with the same reason, every other key kept", () => {
  const answer = runAgentForeground({
    input: subagentPreToolUse("Bash", { command: "npm test", timeout: 60000, run_in_background: true }),
    env: ENV,
  });
  assert.deepEqual(JSON.parse(answer), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: REASON,
      updatedInput: { command: "npm test", timeout: 60000, run_in_background: false },
    },
  });
});

test("a foreground Bash call, with the key false or absent, answers nothing (unlike Agent, the key is never added)", () => {
  assert.equal(runAgentForeground({ input: subagentPreToolUse("Bash", { command: "ls" }), env: ENV }), "");
  assert.equal(
    runAgentForeground({ input: subagentPreToolUse("Bash", { command: "ls", run_in_background: false }), env: ENV }),
    "",
  );
});

test("outside a job, Bash is untouched: neither a background call nor a root scan", () => {
  assert.equal(runAgentForeground({ input: preToolUse("Bash", { command: "ls", run_in_background: true }), env: {} }), "");
  assert.equal(runAgentForeground({ input: preToolUse("Bash", { command: "find /" }), env: {} }), "");
});

const DENY_TABLE = [
  ["find /", "find /"],
  ["find ~", "find /"],
  ["find $HOME", "find /"],
  ["find ${HOME}", "find /"],
  ["grep -r /", "grep -r"],
  ["grep -rn foo ~", "grep -r"],
  ["rg foo /", "rg"],
  ["rg x $HOME", "rg"],
  ["ls -R /", "ls -R"],
  [
    'find ~/nightshift/.claude/worktrees/feat+decisions-adr-log -path "*agents/explore.md" 2>/dev/null; find / -path "*plugin/agents/explore.md" 2>/dev/null | head -5',
    "find /",
  ],
];

for (const [command, ruleName] of DENY_TABLE) {
  test(`a root/home scan is denied: ${command}`, () => {
    const answer = runAgentForeground({ input: subagentPreToolUse("Bash", { command }), env: ENV });
    const reason = `the unattended run refuses a scan from the filesystem root or the home (${ruleName}); ${DENY_REASON_SUFFIX}`;
    assert.deepEqual(JSON.parse(answer), {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
    });
  });
}

const PASS_TABLE = [
  'find ~/nightshift/.claude/worktrees/feat+bash-foreground-root-scan-deny -path "*agents/explore.md"',
  "find . -name x",
  "grep -r foo src/",
  "ls -R plugin",
  "ls -R plugin | grep /",
  "rg foo src; echo ~",
];

for (const command of PASS_TABLE) {
  test(`a search scoped to a real path is never denied: ${command}`, () => {
    assert.equal(runAgentForeground({ input: subagentPreToolUse("Bash", { command }), env: ENV }), "");
  });
}

test("a denied Bash command wins over a background flag", () => {
  const answer = runAgentForeground({
    input: subagentPreToolUse("Bash", { command: "find /", run_in_background: true }),
    env: ENV,
  });
  assert.equal(JSON.parse(answer).hookSpecificOutput.permissionDecision, "deny");
});

test("an interactive session, with no job id, answers nothing", () => {
  const answer = runAgentForeground({ input: preToolUse("Agent", { prompt: "check the diff" }), env: {} });
  assert.equal(answer, "");
});

test("an event that is not PreToolUse answers nothing", () => {
  const answer = runAgentForeground({
    input: { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { prompt: "check the diff" } },
    env: ENV,
  });
  assert.equal(answer, "");
});

test("a malformed tool_input never throws and answers nothing", () => {
  assert.doesNotThrow(() => {
    assert.equal(runAgentForeground({ input: preToolUse("Agent", undefined), env: ENV }), "");
    assert.equal(runAgentForeground({ input: preToolUse("Agent", "run the qa pass"), env: ENV }), "");
    assert.equal(runAgentForeground({ input: preToolUse("Agent", null), env: ENV }), "");
    assert.equal(runAgentForeground({ input: preToolUse("Agent", ["run the qa pass"]), env: ENV }), "");
  });
});

test("an empty or malformed event answers nothing and never throws", () => {
  assert.doesNotThrow(() => {
    assert.equal(runAgentForeground({ input: {}, env: ENV }), "");
    assert.equal(runAgentForeground({ input: null, env: ENV }), "");
    assert.equal(runAgentForeground({ env: ENV }), "");
  });
});

const ORCHESTRATOR_REDIRECT = "the orchestrator does not read the repository - hand the path to the coder / ask the verifier";

// A job home with one run dir, a plugin dir and a worktree, all under a temp dir, plus the env the runtime pins on the child.
function jobFixture(t) {
  const base = mkdtempSync(join(tmpdir(), "ns-orchestrator-scope-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, "home");
  const runDir = join(home, "runs", "demo", "slug");
  const plugin = join(base, "plugin");
  const worktree = join(base, "worktree");
  for (const dir of [runDir, join(plugin, "skills"), join(worktree, "src")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(runDir, "03-plan.md"), "## Plan\n");
  writeFileSync(join(worktree, "src", "app.mjs"), "export {};\n");
  const env = {
    NIGHTSHIFT_JOB_ID: "7",
    NIGHTSHIFT_HOME: home,
    NIGHTSHIFT_JOB_HOME: home,
    NIGHTSHIFT_PLUGIN_DIR: plugin,
    HOME: base,
    CLAUDE_CONFIG_DIR: join(base, "claude-config"),
  };
  return { env, runDir, plugin, worktree };
}

// The PreToolUse payload of the main thread, shaped like the one the CLI sends (cwd, session and tool_use ids).
function mainCall(toolName, toolInput, cwd) {
  return { session_id: "s-1", cwd, tool_use_id: "toolu_1", ...preToolUse(toolName, toolInput) };
}

// Parses a deny answer and returns its reason, failing when the answer is not a deny.
function denyReasonOf(answer) {
  assert.notEqual(answer, "", "the call was allowed");
  const { hookSpecificOutput } = JSON.parse(answer);
  assert.equal(hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(hookSpecificOutput.permissionDecision, "deny");
  return hookSpecificOutput.permissionDecisionReason;
}

test("the orchestrator reads its run's handoff files and the plugin, and nothing else", (t) => {
  const { env, runDir, plugin, worktree } = jobFixture(t);
  const allowed = [
    ["Read", { file_path: join(runDir, "03-plan.md") }],
    ["Read", { file_path: join(plugin, "skills", "resolve", "SKILL.md") }],
    ["Grep", { pattern: "Verdict", path: runDir }],
    ["Glob", { pattern: `${runDir}/*.md` }],
    ["Glob", { pattern: "*.md", path: runDir }],
  ];
  for (const [tool, toolInput] of allowed) {
    assert.equal(runAgentForeground({ input: mainCall(tool, toolInput, worktree), env }), "", `${tool} ${JSON.stringify(toolInput)}`);
  }
  const denied = [
    ["Read", { file_path: join(worktree, "src", "app.mjs") }, join(worktree, "src", "app.mjs")],
    ["Read", { file_path: "src/app.mjs" }, join(worktree, "src", "app.mjs")],
    ["Grep", { pattern: "export" }, worktree],
    ["Glob", { pattern: "**/*.mjs" }, worktree],
    ["Glob", { pattern: "../*.md", path: runDir }, null],
    ["Read", { file_path: join(runDir, "..", "..", "..", "..", "worktree", "src", "app.mjs") }, join(worktree, "src", "app.mjs")],
  ];
  for (const [tool, toolInput, shown] of denied) {
    const reason = denyReasonOf(runAgentForeground({ input: mainCall(tool, toolInput, worktree), env }));
    assert.ok(reason.startsWith(ORCHESTRATOR_REDIRECT), reason);
    assert.match(reason, /handoff file under RUN_DIR/);
    if (shown) assert.ok(reason.includes(shown), `${reason} does not name ${shown}`);
  }
});

test("the orchestrator reads the file its own session spilled a large tool result into, and nothing else of the host's configuration", (t) => {
  const { env, worktree } = jobFixture(t);
  const project = join(env.CLAUDE_CONFIG_DIR, "projects", "-tmp-worktree");
  const spilled = join(project, "0b6f3c1e-session", "tool-results", "toolu_01big.txt");
  const otherJob = join(project, "9d2a7f00-other", "tool-results", "toolu_02big.txt");
  for (const file of [spilled, otherJob]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "a large Bash output\n");
  }
  const ownSession = { session_id: "0b6f3c1e-session", transcript_path: join(project, "0b6f3c1e-session.jsonl") };
  const read = (file_path, session) => runAgentForeground({ input: { ...mainCall("Read", { file_path }, worktree), ...session }, env });
  assert.equal(read(spilled, ownSession), "");
  assert.ok(denyReasonOf(read(otherJob, ownSession)).startsWith(ORCHESTRATOR_REDIRECT), "another session's spill was readable");
  assert.ok(denyReasonOf(read(spilled, {})).startsWith(ORCHESTRATOR_REDIRECT), "a spill was readable without the session's transcript path");
  assert.ok(denyReasonOf(read(spilled, { transcript_path: ownSession.transcript_path, session_id: undefined })).startsWith(ORCHESTRATOR_REDIRECT));
  assert.ok(denyReasonOf(read(join(env.CLAUDE_CONFIG_DIR, "settings.json"), ownSession)).startsWith(ORCHESTRATOR_REDIRECT));
});

test("a subagent's read of the worktree is never scoped: the payload carries agent_id", (t) => {
  const { env, worktree } = jobFixture(t);
  const input = { ...mainCall("Read", { file_path: join(worktree, "src", "app.mjs") }, worktree), agent_id: "a83ebd0b428a73e4b", agent_type: "general-purpose" };
  assert.equal(runAgentForeground({ input, env }), "");
  const grep = { ...mainCall("Grep", { pattern: "x" }, worktree), agent_id: "a1", agent_type: "coder" };
  assert.equal(runAgentForeground({ input: grep, env }), "");
});

test("a session outside a job is never scoped, the same orchestrator payload answering nothing", (t) => {
  const { env, worktree } = jobFixture(t);
  const { NIGHTSHIFT_JOB_ID, ...interactive } = env;
  assert.equal(NIGHTSHIFT_JOB_ID, "7");
  assert.equal(runAgentForeground({ input: mainCall("Read", { file_path: join(worktree, "src", "app.mjs") }, worktree), env: interactive }), "");
  assert.equal(runAgentForeground({ input: mainCall("Bash", { command: "git log -5" }, worktree), env: interactive }), "");
  assert.equal(runAgentForeground({ input: mainCall("Bash", { command: "git log" }, worktree), env: { ...env, NIGHTSHIFT_JOB_ID: "  " } }), "");
});

test("the orchestrator's Bash outside the closed list is denied with the list and the way out", (t) => {
  const { env, worktree } = jobFixture(t);
  const commands = [
    "git log --oneline",
    "cat src/app.mjs",
    "git diff",
    "gh pr diff 3",
    "git -C /other/repo push --force",
    "git push --force origin main",
    "git commit --amend -m x",
    "gh pr merge 3",
    "/usr/bin/git status --short",
  ];
  for (const command of commands) {
    const reason = denyReasonOf(runAgentForeground({ input: mainCall("Bash", { command }, worktree), env }));
    assert.ok(reason.startsWith(ORCHESTRATOR_REDIRECT), reason);
    assert.match(reason, /closed command list \(git rev-parse, .*nightshift run check\|log\|index-save\|commit\|pr\), each as the bare program name/);
    assert.match(reason, /or use `git diff --stat`$/);
  }
});

test("the orchestrator's allowed Bash keeps today's answers: nothing, or the foreground rewrite", (t) => {
  const { env, worktree } = jobFixture(t);
  assert.equal(runAgentForeground({ input: mainCall("Bash", { command: "nightshift run check 04" }, worktree), env }), "");
  assert.equal(runAgentForeground({ input: mainCall("Bash", { command: "git diff --stat" }, worktree), env }), "");
  const answer = runAgentForeground({ input: mainCall("Bash", { command: "git status --short", run_in_background: true }, worktree), env });
  assert.deepEqual(JSON.parse(answer), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: REASON,
      updatedInput: { command: "git status --short", run_in_background: false },
    },
  });
});

test("a subagent's Bash keeps today's path: any command, and the root-scan denial byte for byte", (t) => {
  const { env, worktree } = jobFixture(t);
  const subagent = (command) => ({ ...mainCall("Bash", { command }, worktree), agent_id: "a1", agent_type: "verifier" });
  assert.equal(runAgentForeground({ input: subagent("git log --oneline"), env }), "");
  assert.deepEqual(JSON.parse(runAgentForeground({ input: subagent("find /"), env })), {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `the unattended run refuses a scan from the filesystem root or the home (find /); ${DENY_REASON_SUFFIX}`,
    },
  });
});

test("the orchestrator's Agent launch is never scoped, only normalised as before", (t) => {
  const { env, worktree } = jobFixture(t);
  const answer = runAgentForeground({ input: mainCall("Agent", { prompt: "p", subagent_type: "coder", run_in_background: false }, worktree), env });
  assert.equal(answer, "");
});

test("a failure inside the scope check fails open and never blocks the job", (t) => {
  const { env, worktree } = jobFixture(t);
  const hostile = {};
  Object.defineProperty(hostile, "file_path", {
    enumerable: true,
    get() {
      throw new Error("boom");
    },
  });
  assert.equal(runAgentForeground({ input: mainCall("Read", hostile, worktree), env }), "");
});
