import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { PLUGIN_DIR_ENV } from "../queue/orchestrator-scope.mjs";
import { CLAUDE_MISSING_MESSAGE, mcpConfigArg, pluginDir, resolveClaudeBin } from "../queue/spawn.mjs";
import { isSessionIdSafe } from "../queue/stream.mjs";
import { childExitCode } from "./child-exit.mjs";
import { jobSettings } from "./settings.mjs";

export const OPERATOR_AGENT = "nightshift:nightshift-operator";
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

// The argv that makes the operator the main thread: the agent (or its body as a fallback), the plugin, the nightshift MCP server and the jobs' own hooks.
export function operatorArgs({ env, mode, resumeSession = null }) {
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
    JSON.stringify(jobSettings(env)),
    ...(resumeSession === null ? [] : ["--resume", resumeSession]),
  ];
}

// Environment of the operator session: the mode the guard reads, and the plugin copy its reads are scoped to.
export function operatorEnv(env) {
  return { ...env, NIGHTSHIFT_MODE: "operator", [PLUGIN_DIR_ENV]: pluginDir() };
}

// Drops the admin entries of worktrees whose directory is gone (a QA hunt a closed terminal left behind); a failure only warns.
function pruneWorktrees({ cwd, ctx }) {
  try {
    const result = ctx.spawnSyncImpl("git", ["worktree", "prune"], { cwd, encoding: "utf8", env: ctx.env });
    if (!result?.error && result?.status === 0) return;
    const detail = result?.error?.message ?? String(result?.stderr ?? "").trim().split("\n")[0];
    ctx.err(`nightshift open: warning: \`git worktree prune\` failed in ${cwd}${detail ? `: ${detail}` : ""}`);
  } catch (err) {
    ctx.err(`nightshift open: warning: \`git worktree prune\` failed in ${cwd}: ${err.message}`);
  }
}

// One line naming where the operator runs and how the agent is loaded.
function launchLine(cwd, mode) {
  const how = mode === OPERATOR_MODE_AGENT ? `agent ${OPERATOR_AGENT}` : "fallback --append-system-prompt";
  return `operator · ${cwd} · ${how}`;
}

// Starts the interactive operator session in a directory, optionally resuming one, and returns the exit code of `claude`.
export function launchOperator({ cwd, resumeSession = null, ctx }) {
  if (resumeSession !== null && !isSessionIdSafe(resumeSession)) {
    throw new UserError(`\`${resumeSession}\` is not a session id: letters, digits, \`-\` and \`_\`, 8 to 64 characters`);
  }
  const bin = (ctx.resolveBinImpl ?? resolveClaudeBin)(ctx.env);
  if (!bin?.bin) throw new UserError(CLAUDE_MISSING_MESSAGE);
  pruneWorktrees({ cwd, ctx });
  const { mode } = probeOperatorLaunch({ bin: bin.bin, ctx });
  ctx.out(launchLine(cwd, mode));
  const args = operatorArgs({ env: ctx.env, mode, resumeSession });
  const result = ctx.spawnSyncImpl(bin.bin, args, { stdio: "inherit", cwd, env: operatorEnv(ctx.env) });
  if (result?.error) throw new UserError(`could not run \`${bin.bin}\` in ${cwd}: ${result.error.message}`);
  return childExitCode(result);
}
