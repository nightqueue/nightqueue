import { isAbsolute } from "node:path";
import { globStaticPrefix, isOrchestratorCall, readTarget } from "../queue/orchestrator-scope.mjs";
import {
  OPERATOR_DECISION,
  agentRole,
  checkoutRoots,
  describeAgentDenial,
  describeMainBashDenial,
  describeMainWriteDenial,
  describeQaBashDenial,
  describeQaWriteDenial,
  describeReadDenial,
  describeReadonlySubagentBashDenial,
  describeSubagentWriteDenial,
  mainBashAllowed,
  qaBashAllowed,
  qaPathAllowed,
  readRefusal,
  readonlySubagentBashAllowed,
  sweepsSecrets,
} from "../queue/operator-scope.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const INPUT_REQUIRED_TOOLS = new Set([...WRITE_TOOLS, "Bash", ...AGENT_TOOLS]);

// The path an edit tool call writes, or null when it names none.
function writeTarget(toolInput) {
  return toolInput?.file_path ?? toolInput?.notebook_path ?? null;
}

// The static prefix of an absolute glob a read call carries (Glob `pattern`, Grep `glob`), or null when it carries none.
function absoluteGlobTarget(toolName, toolInput) {
  const glob = toolName === "Glob" ? toolInput?.pattern : toolName === "Grep" ? toolInput?.glob : null;
  return typeof glob === "string" && isAbsolute(glob) ? globStaticPrefix(glob) : null;
}

// Deny reason of a read the operator may not make (the secrets file, a `.env*` file, an unresolvable path, or a Grep that would sweep
// the secrets file), its own target and any absolute glob it carries both judged; null when the read is allowed.
function readReason(input, env) {
  const target = readTarget(input.tool_name, input.tool_input, input.cwd);
  const globTarget = absoluteGlobTarget(input.tool_name, input.tool_input);
  const targets = globTarget === null ? [target] : [target, globTarget];
  for (const path of targets) {
    const refusal = readRefusal(path, env);
    if (refusal) return describeReadDenial({ target: path, refusal, env });
  }
  if (input.tool_name === "Grep" && sweepsSecrets(target, env)) return describeReadDenial({ target, refusal: "sweep", env });
  return null;
}

// Deny reason of a call whose tool_input is not an object, for a tool that must carry one to be judged, or null.
function malformedReason(toolName, toolInput) {
  const plain = toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput);
  if (plain || !INPUT_REQUIRED_TOOLS.has(toolName)) return null;
  return `${OPERATOR_DECISION}: this ${toolName} call carries no tool_input object, so it cannot be checked and is refused`;
}

// Deny reason of a main-thread Bash command outside the operator's list, or null.
function mainBashReason(command, env) {
  const { roots, error } = checkoutRoots(env);
  return mainBashAllowed(command, roots) ? null : describeMainBashDenial(error);
}

// Deny reason of a call from the operator's own main thread, or null when D-58 allows it.
function mainThreadReason(input, env) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  if (WRITE_TOOLS.has(toolName)) return describeMainWriteDenial(toolName);
  if (READ_TOOLS.has(toolName)) return readReason(input, env);
  if (toolName === "Bash") return mainBashReason(toolInput.command, env);
  if (AGENT_TOOLS.has(toolName)) return agentRole(toolInput.subagent_type) ? null : describeAgentDenial(toolInput.subagent_type);
  return null;
}

// Deny reason of a qa subagent's call: edits and Bash stay in its qa worktree.
function qaReason(toolName, toolInput, env) {
  if (WRITE_TOOLS.has(toolName)) {
    const path = writeTarget(toolInput);
    return qaPathAllowed(path, env) ? null : describeQaWriteDenial(path, env);
  }
  if (toolName === "Bash") return qaBashAllowed(toolInput.command, env) ? null : describeQaBashDenial(env);
  return null;
}

// Deny reason of a read-only subagent's call: no edit, and only the read-only Bash list.
function readonlySubagentReason(toolName, toolInput, { agentType, env }) {
  if (WRITE_TOOLS.has(toolName)) return describeSubagentWriteDenial(agentType);
  if (toolName !== "Bash") return null;
  const { roots, error } = checkoutRoots(env);
  return readonlySubagentBashAllowed(toolInput.command, roots) ? null : describeReadonlySubagentBashDenial(agentType, error);
}

// Deny reason of a subagent's call under D-58: its reads in the operator's roots, the rest by the role its agent type names.
function subagentReason(input, env) {
  const toolInput = input.tool_input ?? {};
  if (READ_TOOLS.has(input.tool_name)) return readReason(input, env);
  if (agentRole(input.agent_type) === "qa") return qaReason(input.tool_name, toolInput, env);
  return readonlySubagentReason(input.tool_name, toolInput, { agentType: input.agent_type, env });
}

// Reason of a call the guard could not decide: anything but a read is refused rather than let through.
function failClosedReason(toolName, err) {
  return `${OPERATOR_DECISION}: the operator guard could not check this ${toolName ?? "tool"} call (${err?.message ?? String(err)}), so it is refused`;
}

// The deny reason of an operator session's tool call under D-58, or null when the call is allowed; a failure refuses all but reads.
export function operatorDecision({ input, env = process.env }) {
  try {
    const malformed = malformedReason(input?.tool_name, input?.tool_input);
    if (malformed) return malformed;
    return isOrchestratorCall(input) ? mainThreadReason(input, env) : subagentReason(input, env);
  } catch (err) {
    return READ_TOOLS.has(input?.tool_name) ? null : failClosedReason(input?.tool_name, err);
  }
}
