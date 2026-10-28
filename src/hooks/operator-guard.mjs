import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { consentBash, neverBashReason, neverWriteReason } from "../queue/operator-bands.mjs";
import { consentCovers, operatorSession } from "../queue/operator-consent.mjs";
import { globStaticPrefix, insideRoots, isOrchestratorCall, readTarget } from "../queue/orchestrator-scope.mjs";
import {
  OPERATOR_GUARD,
  checkoutRoots,
  describeAgentDenial,
  describeMainBashList,
  describeReadDenial,
  describeSubagentBashList,
  mainBashAllowed,
  pipelineAgent,
  readRefusal,
  readonlySubagentBashAllowed,
  registryNote,
  sweepsSecrets,
} from "../queue/operator-scope.mjs";

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const AGENT_TOOLS = new Set(["Agent", "Task"]);
const INPUT_REQUIRED_TOOLS = new Set([...WRITE_TOOLS, "Bash", ...AGENT_TOOLS]);
const HOME_MAINTENANCE = "home-maintenance";
const CONSENT_TAIL = "ask the person (what, where, how to undo it), record the answer with operator_consent, then retry";
const MCP_PREFIX = "mcp__";
const NIGHTQUEUE_MCP_PREFIX = "mcp__nightqueue__";

// A tool of an MCP server the person configured: never judged by the guard, the host prompt decides.
export function personMcpTool(toolName) {
  return typeof toolName === "string" && toolName.startsWith(MCP_PREFIX) && !toolName.startsWith(NIGHTQUEUE_MCP_PREFIX);
}

// The absolute path an edit tool call writes, a relative one resolved against the session cwd, or null when it names none.
function writeTarget(toolInput, cwd) {
  const path = toolInput?.file_path ?? toolInput?.notebook_path ?? null;
  if (typeof path !== "string" || path.trim() === "") return null;
  if (isAbsolute(path)) return resolve(path);
  return typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd, path) : null;
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
  return `${OPERATOR_GUARD}: this ${toolName} call carries no tool_input object, so it cannot be checked and is refused`;
}

// The refusal of a call no consent covers yet.
function needsConsent(kind, shown) {
  return `${OPERATOR_GUARD}: needs consent (${kind} ${shown}): ${CONSENT_TAIL}`;
}

// Deny reason of an edit tool call: never in the never band, consented edits in a registered checkout, a create anywhere a consent names.
function writeReason(input, env) {
  const target = writeTarget(input.tool_input, input.cwd);
  if (target === null) return `${OPERATOR_GUARD}: this ${input.tool_name} call names no path that can be resolved; pass an absolute \`file_path\``;
  const never = neverWriteReason(target, env);
  if (never) return `${OPERATOR_GUARD}: never (${never}): ${target} is in the never band, and no consent covers it`;
  const kind = input.tool_name === "Write" && !existsSync(target) ? "create" : "edit";
  if (kind === "edit") {
    const { roots, error } = checkoutRoots(env);
    if (!insideRoots(target, roots)) return `${OPERATOR_GUARD}: edits stay in a registered checkout, and ${target} is outside every one${registryNote(error)}`;
  }
  return consentCovers(operatorSession(env), { kind, target }, env) ? null : needsConsent(kind, target);
}

// Tells whether a Bash command is on the free list of the thread that runs it.
function freeBash(command, { mainThread, env }) {
  const { roots } = checkoutRoots(env);
  return mainThread ? mainBashAllowed(command, roots) : readonlySubagentBashAllowed(command, roots);
}

// Deny reason of a Bash call: never in the never band, free on the thread's list, else only the consented command in a registered checkout.
function bashReason(input, { mainThread, env }) {
  const command = input.tool_input.command;
  if (typeof command !== "string" || command.trim() === "") return `${OPERATOR_GUARD}: this Bash call carries no command`;
  const never = neverBashReason(command, { cwd: input.cwd, env });
  if (never) return `${OPERATOR_GUARD}: never (${never}): no consent covers it`;
  if (freeBash(command, { mainThread, env })) return null;
  const request = consentBash(command, { cwd: input.cwd, env });
  if (request.free) return null;
  if (request.shape) {
    const free = mainThread ? describeMainBashList() : describeSubagentBashList();
    return `${OPERATOR_GUARD}: ${request.shape}; run one bare command as \`cd <registered checkout> && <command>\` after the person's consent, or one of the free commands: ${free}`;
  }
  if (!mainThread && (request.kind === HOME_MAINTENANCE || request.home === true)) return `${OPERATOR_GUARD}: never (home maintenance runs on the operator's own thread): no consent covers it`;
  return consentCovers(operatorSession(env), request, env) ? null : needsConsent(request.kind, request.shown);
}

// Deny reason of an Agent/Task launch: only the pipeline agents of the plugin, under a plugin-scoped spelling.
function agentReason(toolInput) {
  return pipelineAgent(toolInput.subagent_type) ? null : describeAgentDenial(toolInput.subagent_type);
}

// Deny reason of a call of the operator or one of its subagents under the three bands, or null when the guard allows it.
function bandReason(input, env) {
  const toolName = input.tool_name;
  if (personMcpTool(toolName)) return null;
  const mainThread = isOrchestratorCall(input);
  if (READ_TOOLS.has(toolName)) return readReason(input, env);
  if (AGENT_TOOLS.has(toolName)) return mainThread ? agentReason(input.tool_input) : null;
  if (WRITE_TOOLS.has(toolName)) return writeReason(input, env);
  if (toolName === "Bash") return bashReason(input, { mainThread, env });
  return null;
}

// Reason of a call the guard could not decide: anything but a read is refused rather than let through.
function failClosedReason(toolName, err) {
  return `${OPERATOR_GUARD}: the operator guard could not check this ${toolName ?? "tool"} call (${err?.message ?? String(err)}), so it is refused`;
}

// The deny reason of an operator session's tool call under the operator guard, or null when the call is allowed; a failure refuses all but reads.
export function operatorDecision({ input, env = process.env }) {
  try {
    const malformed = malformedReason(input?.tool_name, input?.tool_input);
    if (malformed) return malformed;
    return bandReason(input, env);
  } catch (err) {
    return READ_TOOLS.has(input?.tool_name) ? null : failClosedReason(input?.tool_name, err);
  }
}
