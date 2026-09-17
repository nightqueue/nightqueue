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

test("a tool other than Agent or Task answers nothing", () => {
  const answer = runAgentForeground({ input: preToolUse("Bash", { command: "ls" }), env: ENV });
  assert.equal(answer, "");
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
