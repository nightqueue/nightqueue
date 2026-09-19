import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgentForeground } from "../../src/hooks/agent-foreground.mjs";

const ENV = { NIGHTSHIFT_JOB_ID: "7" };
const REASON = "the unattended run keeps subagents in the foreground so the CLI never kills one at its wait ceiling";

// Event JSON the host sends for a PreToolUse call, with the given tool and its input.
function preToolUse(toolName, toolInput) {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput };
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

test("a tool other than Agent, Task or Bash answers nothing", () => {
  const answer = runAgentForeground({ input: preToolUse("Read", { file_path: "a.mjs" }), env: ENV });
  assert.equal(answer, "");
});

const DENY_REASON_SUFFIX = "restrict the search to the worktree (`$WORKTREE`) or the project checkout";

test("a background Bash call is rewritten to the foreground, with the same reason, every other key kept", () => {
  const answer = runAgentForeground({
    input: preToolUse("Bash", { command: "npm test", timeout: 60000, run_in_background: true }),
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
  assert.equal(runAgentForeground({ input: preToolUse("Bash", { command: "ls" }), env: ENV }), "");
  assert.equal(
    runAgentForeground({ input: preToolUse("Bash", { command: "ls", run_in_background: false }), env: ENV }),
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
    const answer = runAgentForeground({ input: preToolUse("Bash", { command }), env: ENV });
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
    assert.equal(runAgentForeground({ input: preToolUse("Bash", { command }), env: ENV }), "");
  });
}

test("a denied Bash command wins over a background flag", () => {
  const answer = runAgentForeground({
    input: preToolUse("Bash", { command: "find /", run_in_background: true }),
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
