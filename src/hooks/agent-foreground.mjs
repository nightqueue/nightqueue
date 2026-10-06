import {
  describeOrchestratorBashRules,
  insideRoots,
  isOrchestratorCall,
  orchestratorBashAllowed,
  orchestratorRoots,
  readTarget,
} from "../queue/orchestrator-scope.mjs";
import { operatorDecision } from "./operator-guard.mjs";

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const FOREGROUND_REASON =
  "the unattended run keeps subagents in the foreground so the CLI never kills one at its wait ceiling";

// A root or home path argument, possibly quoted, ending at whitespace, `;`, `|`, `&`, `)` or the end of the command.
const ROOT_OR_HOME = "(?:/|~/?|\\$\\{?HOME\\}?/?)";
const ROOT_OR_HOME_ARG = `(?:'${ROOT_OR_HOME}'|"${ROOT_OR_HOME}"|${ROOT_OR_HOME})(?=[\\s;|&)]|$)`;
// Zero or more tokens (flags, a search pattern) a deny rule skips before it reaches the path argument.
const LEADING_TOKENS = "(?:[^\\s;|&]+\\s+)*?";
// One `<cmd> <root-or-home-path>` deny rule: a name for the reason, and the pattern it matches anywhere in the command.
const DENY_RULES = [
  { name: "find /", pattern: new RegExp(`\\bfind\\s+${ROOT_OR_HOME_ARG}`) },
  { name: "grep -r", pattern: new RegExp(`\\bgrep\\s+-\\w*[rR]\\w*\\s+${LEADING_TOKENS}${ROOT_OR_HOME_ARG}`) },
  { name: "rg", pattern: new RegExp(`\\brg\\s+${LEADING_TOKENS}${ROOT_OR_HOME_ARG}`) },
  { name: "ls -R", pattern: new RegExp(`\\bls\\s+-\\w*R\\w*\\s+${LEADING_TOKENS}${ROOT_OR_HOME_ARG}`) },
];
const DENY_REASON_PREFIX =
  "the unattended run refuses a scan from the filesystem root or the home";
const DENY_REASON_SUFFIX =
  "restrict the search to the worktree (`$WORKTREE`) or the project checkout";

// Tells whether this process runs inside a queued job, where the CLI wait ceiling can kill a background subagent.
function insideJob(env) {
  return typeof env?.NIGHTQUEUE_JOB_ID === "string" && env.NIGHTQUEUE_JOB_ID.trim() !== "";
}

// The guard this process runs under: a queued job first, then the operator of `nightqueue open`, else none.
function guardMode(env) {
  if (insideJob(env)) return "job";
  const mode = typeof env?.NIGHTQUEUE_MODE === "string" ? env.NIGHTQUEUE_MODE.trim() : "";
  return mode === "operator" ? "operator" : null;
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

// PreToolUse answer that denies a tool call with the reason the agent reads.
function denyAnswer(reason) {
  const hookSpecificOutput = {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: reason,
  };
  return JSON.stringify({ hookSpecificOutput });
}

// Reason of a root/home scan denial, naming the rule it tripped and the fix.
function rootScanReason(ruleName) {
  return `${DENY_REASON_PREFIX} (${ruleName}); ${DENY_REASON_SUFFIX}`;
}

// Reason of an orchestrator read outside its run, the plugin and its own session's spilled tool results.
function orchestratorReadReason(path, roots) {
  const shown = path ?? "a path that cannot be resolved";
  return (
    `the orchestrator does not read the repository - hand the path to the coder / ask the verifier: ` +
    `the orchestrator of a queued job reads only its run's handoff files and the plugin (${roots.join(", ")}), ` +
    `and ${shown} is outside them; the subagent of this phase writes what you need into a handoff file under RUN_DIR`
  );
}

// Reason of an orchestrator Bash command outside its closed list.
function orchestratorBashReason() {
  return (
    `the orchestrator does not read the repository - hand the path to the coder / ask the verifier: ` +
    `the orchestrator of a queued job runs only its closed command list (${describeOrchestratorBashRules()}), ` +
    "each as the bare program name followed by its subcommand (no binary path, no `git -C`/`-c`/`--git-dir`/`--work-tree`); " +
    "hand this to the subagent of the phase and read its handoff file, or use `git diff --stat`"
  );
}

// The deny rule a Bash command trips, matched anywhere in the command; null when none applies.
function deniedBashRule(command) {
  if (typeof command !== "string") return null;
  const rule = DENY_RULES.find(({ pattern }) => pattern.test(command));
  return rule?.name ?? null;
}

// Normalises an Agent/Task launch to the foreground.
function foregroundAgentOrTask(toolInput) {
  if (!("run_in_background" in toolInput)) return foregroundAnswer(toolInput, null);
  if (toolInput.run_in_background === true) return foregroundAnswer(toolInput, FOREGROUND_REASON);
  return "";
}

// Denies a root/home scan, or normalises a background Bash call to the foreground.
function guardBash(toolInput) {
  const denied = deniedBashRule(toolInput.command);
  if (denied) return denyAnswer(rootScanReason(denied));
  if (toolInput.run_in_background === true) return foregroundAnswer(toolInput, FOREGROUND_REASON);
  return "";
}

// Deny reason for a main-thread call of a queued job outside the orchestrator's scope, or null when the call is in scope or is a subagent's.
function orchestratorScopeReason({ input, toolName, toolInput, env }) {
  if (!isOrchestratorCall(input)) return null;
  if (READ_TOOLS.has(toolName)) {
    const roots = orchestratorRoots(env, [{ transcriptPath: input.transcript_path, sessionId: input.session_id }]);
    const target = readTarget(toolName, toolInput, input.cwd);
    return insideRoots(target, roots) ? null : orchestratorReadReason(target, roots);
  }
  if (toolName === "Bash") return orchestratorBashAllowed(toolInput.command) ? null : orchestratorBashReason();
  return null;
}

// Same as the scope check, failing open: a hook that breaks never blocks a job.
function safeOrchestratorScopeReason(call) {
  try {
    return orchestratorScopeReason(call);
  } catch {
    return null;
  }
}

// The operator's answer under D-58: its guard's denial, else a root/home scan denial for Bash, and nothing is ever moved to the foreground.
function guardOperator({ input, toolName, toolInput, env }) {
  const reason = operatorDecision({ input, env });
  if (reason) return denyAnswer(reason);
  const denied = toolName === "Bash" && isPlainObject(toolInput) ? deniedBashRule(toolInput.command) : null;
  return denied ? denyAnswer(rootScanReason(denied)) : "";
}

// Normalises a subagent launch to the foreground, and a Bash call likewise, denying one that scans from the root or the home, and keeps the orchestrator's own reads and Bash inside its run; inside an unattended run, so `claude -p` never kills a background one at its wait ceiling, and for the operator of `nightqueue open`, the D-58 guard and scan denial only.
export function runAgentForeground({ input, env = process.env }) {
  const mode = guardMode(env);
  if (mode === null) return "";
  if (input?.hook_event_name !== "PreToolUse") return "";
  const toolName = input?.tool_name;
  const toolInput = input?.tool_input;
  if (mode === "operator") return guardOperator({ input, toolName, toolInput, env });
  if (!isPlainObject(toolInput)) return "";
  const scopeReason = safeOrchestratorScopeReason({ input, toolName, toolInput, env });
  if (scopeReason) return denyAnswer(scopeReason);
  if (toolName === "Agent" || toolName === "Task") return foregroundAgentOrTask(toolInput);
  if (toolName === "Bash") return guardBash(toolInput);
  return "";
}
