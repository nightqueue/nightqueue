import { commandDeletes, commandFeedsShell, neverBashReason, neverWriteReason, protectedPathReason } from "../host/never-band.mjs";
import { CHAT_WORKTREE_ENV, worktreeEntry } from "../host/worktree-entry.mjs";
import { withPrBudget } from "../queue/operator-pr-budget.mjs";
import { canonicalPath, insideRoots } from "../queue/orchestrator-scope.mjs";
import { writeTarget } from "./operator-guard.mjs";

const CHAT_GUARD = "nightqueue chat guard";
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const HOME_MARK = "nightqueue home";
const RELATIVE_PATHS_HINT = "; inside the session worktree, name its files by relative paths";
const ASK_COMMAND_MAX = 200;
const COMPUTED_TEXT = /[$`]/;
const COMPUTED_DELETE = "a delete whose paths the shell computes (`$…`, a command substitution) cannot be checked; spell its paths literally";

// One decision of the chat guard, its reason prefixed with the guard's name.
function verdict(decision, reason) {
  return { decision, reason: `${CHAT_GUARD}: ${reason}` };
}

// The PreToolUse answer the host reads for one decision.
function decisionJson(decision, reason) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } });
}

export const CHAT_GUARD_DENY = decisionJson("deny", `${CHAT_GUARD}: the guard could not run, so the call is refused`);

// The session's own worktree entry carried by the launcher's environment, or null when it is unset or names no worktree entry.
export function chatWorktree(env) {
  const value = env?.[CHAT_WORKTREE_ENV];
  const entry = worktreeEntry(value, env);
  return entry !== null && canonicalPath(value) === entry ? entry : null;
}

// Tells whether a value is a plain object a tool call can be judged from.
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// The command as quoted in an ask reason: at most its first ASK_COMMAND_MAX characters.
function quotedCommand(command) {
  return command.length > ASK_COMMAND_MAX ? `${command.slice(0, ASK_COMMAND_MAX)}…` : command;
}

// The decision on a Bash call: never denied first with deletes allowed, then a delete asks the person, else no opinion.
function bashDecision(command, { cwd, env, root }) {
  if (typeof command !== "string" || command.trim() === "") return verdict("deny", "this Bash call carries no command");
  const chat = { worktree: root };
  const strict = neverBashReason(command, { cwd, env, allowDeletes: true, chat });
  if (strict) return verdict("deny", `never (${strict})${root !== null && strict.includes(HOME_MARK) ? RELATIVE_PATHS_HINT : ""}`);
  const deletesFiles = commandDeletes(command);
  if (deletesFiles && COMPUTED_TEXT.test(command)) return verdict("deny", `never (${COMPUTED_DELETE})`);
  if (deletesFiles || neverBashReason(command, { cwd, env, chat })) {
    return verdict("ask", `deleting files needs your authorization: ${quotedCommand(command)}`);
  }
  if (commandFeedsShell(command)) return verdict("ask", `a shell reading its script from stdin cannot be checked: ${quotedCommand(command)}`);
  return null;
}

// The decision on an edit tool call: the never band, a write inside the session's own worktree judged only on its protected paths.
function writeDecision(toolInput, { cwd, env, root }) {
  const target = writeTarget(toolInput, cwd);
  if (target === null) return verdict("deny", "this edit names no path that can be resolved; pass an absolute `file_path`");
  const inWorktree = root !== null && insideRoots(target, [root]);
  const reason = inWorktree ? protectedPathReason(canonicalPath(target), env) : neverWriteReason(target, env);
  return reason ? verdict("deny", `never (${reason}): ${target}`) : null;
}

// The decision on one tool call of a chat session, or null for a tool the guard does not judge.
function toolDecision(input, env) {
  const tool = input?.tool_name;
  if (tool !== "Bash" && !WRITE_TOOLS.has(tool)) return null;
  const toolInput = input.tool_input;
  if (!isPlainObject(toolInput)) return verdict("deny", `this ${tool} call carries no tool_input object, so it cannot be checked`);
  const context = { cwd: input.cwd, env, root: chatWorktree(env) };
  return tool === "Bash" ? bashDecision(toolInput.command, context) : writeDecision(toolInput, context);
}

// The chat guard's decision on a tool call (`deny` or `ask` with its reason), or null when it has none; a failure denies.
export function chatDecision({ input, env = process.env }) {
  try {
    return withPrBudget(() => toolDecision(input, env));
  } catch (err) {
    return verdict("deny", `could not check this ${input?.tool_name ?? "tool"} call (${err?.message ?? String(err)}), so it is refused`);
  }
}

// The PreToolUse hook of a chat session: the guard's decision as the host's JSON, or nothing when it has none.
export function runChatGuard({ input, env = process.env }) {
  const decision = chatDecision({ input, env });
  return decision === null ? "" : decisionJson(decision.decision, decision.reason);
}
