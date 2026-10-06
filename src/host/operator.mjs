import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { registeredCheckouts } from "../memory/registry-access.mjs";
import { PLUGIN_DIR_ENV } from "../queue/orchestrator-scope.mjs";
import { sweepQaWorktrees } from "../queue/qa-worktree.mjs";
import { killProcess } from "../queue/registry.mjs";
import { CLAUDE_MISSING_MESSAGE, mcpConfigArg, pluginDir, resolveClaudeBin } from "../queue/spawn.mjs";
import { isSessionIdSafe } from "../queue/stream.mjs";
import { childExitCode } from "./child-exit.mjs";
import { withoutOperatorSession } from "./operator-env.mjs";
import { operatorSettings } from "./settings.mjs";

export const OPERATOR_AGENT = "nightqueue:nightqueue-operator";
export const OPERATOR_MODE_AGENT = "agent";
export const OPERATOR_MODE_FALLBACK = "append-system-prompt";

const HELP_TIMEOUT_MS = 5000;
const AGENT_FLAG_LINE = /^\s*--agent <agent>/m;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

// Path of the operator agent inside the plugin this package carries.
export function operatorAgentPath() {
  return join(pluginDir(), "agents", "operator.md");
}

// The operator agent's body without its frontmatter, the text the fallback appends to the system prompt.
export function operatorAgentBody() {
  const path = operatorAgentPath();
  try {
    return readFileSync(path, "utf8").replace(FRONTMATTER, "");
  } catch (err) {
    throw new UserError(`cannot read the operator agent at ${path}: ${err.message}`);
  }
}

// Asks `claude --help` whether the main thread accepts `--agent`; never throws, and a probe that fails counts as the fallback.
export function probeOperatorLaunch({ bin, ctx }) {
  try {
    const result = ctx.spawnSyncImpl(bin, ["--help"], { encoding: "utf8", timeout: HELP_TIMEOUT_MS, env: ctx.env });
    const answered = !result?.error && result?.status === 0;
    const stdout = typeof result?.stdout === "string" ? result.stdout : "";
    return { answered, mode: answered && AGENT_FLAG_LINE.test(stdout) ? OPERATOR_MODE_AGENT : OPERATOR_MODE_FALLBACK };
  } catch {
    return { answered: false, mode: OPERATOR_MODE_FALLBACK };
  }
}

// The commands (and aliases) claude dispatches when its first operand names one, `--` included; a prompt equal to one would run it.
export const CLAUDE_COMMAND_NAMES = new Set([
  "agents", "attach", "auth", "auto-mode", "config", "doctor", "gateway", "help", "import", "install", "kill", "logs", "mcp",
  "migrate-installer", "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "ultrareview", "update", "upgrade",
]);

// The prompt that opens a fresh operator session: the agent answers with its opening message (its contract says what it holds).
export const OPERATOR_OPENING_PROMPT = "The session just opened. Give your opening message.";

// The argv that makes the operator the main thread: the agent (or its body as a fallback), the plugin, the nightqueue MCP server, the jobs' own hooks, and the first prompt (the request given, else the opening prompt on a fresh session).
export function operatorArgs({ env, mode, resumeSession = null, prompt = null }) {
  const agent = mode === OPERATOR_MODE_AGENT ? ["--agent", OPERATOR_AGENT] : ["--append-system-prompt", operatorAgentBody()];
  return [
    ...agent,
    "--plugin-dir",
    pluginDir(),
    "--mcp-config",
    mcpConfigArg(env, null),
    "--setting-sources",
    "project,local",
    "--settings",
    JSON.stringify(operatorSettings(env)),
    ...(resumeSession === null
      ? [promptOperand(prompt ?? OPERATOR_OPENING_PROMPT)]
      : ["--resume", resumeSession, ...(prompt === null ? [] : [promptOperand(prompt)])]),
  ];
}

// A first prompt claude can never dispatch as one of its commands: a claude command name gets one trailing space, which no command name holds.
export function promptOperand(prompt) {
  return CLAUDE_COMMAND_NAMES.has(prompt) ? `${prompt} ` : prompt;
}

// The `--prompt` value of `open` / `queue session`, verbatim, or null when absent; empty or option-like values are refused.
export function operatorPrompt(value, usage) {
  if (value === undefined) return null;
  if (value.trim() === "") throw new UserError(`\`--prompt\` is empty; usage: ${usage}`);
  if (value.startsWith("-")) {
    throw new UserError(`\`--prompt\` cannot start with \`-\`: claude would read it as an option; usage: ${usage}`);
  }
  return value;
}

// Environment of the operator session: the mode the guard reads, the launcher's pid, the preselected project when one is, and the plugin copy its reads are scoped to.
export function operatorEnv(env, { projectId = null } = {}) {
  return {
    ...withoutOperatorSession(env),
    NIGHTQUEUE_MODE: "operator",
    NIGHTQUEUE_OPERATOR_PID: String(process.pid),
    ...(projectId ? { NIGHTQUEUE_PROJECT: projectId } : {}),
    [PLUGIN_DIR_ENV]: pluginDir(),
  };
}

// Drops the admin entries of worktrees whose directory is gone in one checkout; a failure only warns.
function pruneWorktrees({ cwd, ctx }) {
  try {
    const result = ctx.spawnSyncImpl("git", ["worktree", "prune"], { cwd, encoding: "utf8", env: ctx.env });
    if (!result?.error && result?.status === 0) return;
    const detail = result?.error?.message ?? String(result?.stderr ?? "").trim().split("\n")[0];
    ctx.err(`nightqueue open: warning: \`git worktree prune\` failed in ${cwd}${detail ? `: ${detail}` : ""}`);
  } catch (err) {
    ctx.err(`nightqueue open: warning: \`git worktree prune\` failed in ${cwd}: ${err.message}`);
  }
}

// The registered checkouts that exist on disk, or none with a warning when the registry cannot be read.
function existingCheckouts(ctx) {
  try {
    return registeredCheckouts(ctx.env).filter((project) => existsSync(project.path));
  } catch (err) {
    ctx.err(`nightqueue open: warning: the registered checkouts could not be read: ${err.message}`);
    return [];
  }
}

// Prunes the worktree entries of every registered checkout that exists; best-effort, one warning per failure.
export function pruneRegisteredCheckouts(ctx, checkouts = existingCheckouts(ctx)) {
  for (const project of checkouts) pruneWorktrees({ cwd: project.path, ctx });
}

// Drops the stale qa worktrees (older than the TTL or whose session is gone) of the registered checkouts; best-effort, one warning per failure.
export function sweepStaleQaWorktrees(ctx, checkouts = existingCheckouts(ctx)) {
  const swept = sweepQaWorktrees({ env: ctx.env, projects: checkouts, spawnSyncImpl: ctx.spawnSyncImpl, killImpl: ctx.killImpl ?? killProcess });
  for (const { row, reason } of swept.failed) {
    ctx.err(`nightqueue open: warning: a stale qa worktree could not be dropped${row ? ` (${row.path})` : ""}: ${reason}`);
  }
  if (swept.dropped.length > 0) ctx.out(`operator · dropped ${swept.dropped.length} stale qa worktree(s)`);
}

// One line naming where the operator runs, the preselected project and how the agent is loaded.
function launchLine({ cwd, project, mode }) {
  const how = mode === OPERATOR_MODE_AGENT ? `agent ${OPERATOR_AGENT}` : "fallback --append-system-prompt";
  return `operator · ${cwd} · project ${project?.name ?? "none"} · ${how}`;
}

// The binary, argv, environment and mode of an operator session in a directory, probing the mode only when the caller did not pass one.
export function operatorLaunch({ cwd, resumeSession = null, prompt = null, project = null, ctx, mode = null }) {
  if (resumeSession !== null && !isSessionIdSafe(resumeSession)) {
    throw new UserError(`\`${resumeSession}\` is not a session id: letters, digits, \`-\` and \`_\`, 8 to 64 characters`);
  }
  const bin = (ctx.resolveBinImpl ?? resolveClaudeBin)(ctx.env);
  if (!bin?.bin) throw new UserError(CLAUDE_MISSING_MESSAGE);
  const launchMode = mode ?? probeOperatorLaunch({ bin: bin.bin, ctx }).mode;
  return {
    bin: bin.bin,
    args: operatorArgs({ env: ctx.env, mode: launchMode, resumeSession, prompt }),
    env: operatorEnv(ctx.env, { projectId: project?.id ?? null }),
    mode: launchMode,
    line: launchLine({ cwd, project, mode: launchMode }),
  };
}

// Starts the interactive operator session in a directory, optionally resuming one, and returns the exit code of `claude`.
export async function launchOperator({ cwd, resumeSession = null, prompt = null, project = null, ctx }) {
  const launch = operatorLaunch({ cwd, resumeSession, prompt, project, ctx });
  const checkouts = existingCheckouts(ctx);
  pruneRegisteredCheckouts(ctx, checkouts);
  sweepStaleQaWorktrees(ctx, checkouts);
  ctx.out(launch.line);
  const result = ctx.spawnSyncImpl(launch.bin, launch.args, { stdio: "inherit", cwd, env: launch.env });
  if (result?.error) throw new UserError(`could not run \`${launch.bin}\` in ${cwd}: ${result.error.message}`);
  return childExitCode(result);
}
