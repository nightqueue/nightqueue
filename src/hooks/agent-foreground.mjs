const FOREGROUND_REASON =
  "the unattended run keeps subagents in the foreground so the CLI never kills one at its wait ceiling";

// Tells whether this process runs inside a queued job, where the CLI wait ceiling can kill a background subagent.
function insideJob(env) {
  return typeof env?.NIGHTSHIFT_JOB_ID === "string" && env.NIGHTSHIFT_JOB_ID.trim() !== "";
}

// Tells whether a value is a plain object, never an array nor null.
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// PreToolUse answer that forces the tool call's `run_in_background` to `false`, keeping every other key.
function foregroundAnswer(toolInput, reason) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    ...(reason ? { permissionDecisionReason: reason } : {}),
    updatedInput: { ...toolInput, run_in_background: false },
  };
  return JSON.stringify({ hookSpecificOutput });
}

// Normalises a subagent launch to the foreground inside an unattended run, so `claude -p` never kills it at its wait ceiling.
export function runAgentForeground({ input, env = process.env }) {
  if (!insideJob(env)) return "";
  if (input?.hook_event_name !== "PreToolUse") return "";
  if (input?.tool_name !== "Agent" && input?.tool_name !== "Task") return "";
  const toolInput = input?.tool_input;
  if (!isPlainObject(toolInput)) return "";
  if (!("run_in_background" in toolInput)) return foregroundAnswer(toolInput, null);
  if (toolInput.run_in_background === true) return foregroundAnswer(toolInput, FOREGROUND_REASON);
  return "";
}
