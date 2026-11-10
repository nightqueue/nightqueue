import { UserError } from "../config/errors.mjs";
import { childExitCode } from "../host/child-exit.mjs";
import { CLAUDE_MISSING_MESSAGE, mcpConfigArg, pluginDir, resolveClaudeBin } from "../host/claude-launch.mjs";
import { withoutOperatorSession } from "../host/operator-env.mjs";
import { profileArgs, withoutJobScope } from "../host/session-profile.mjs";
import { chatSettings } from "../host/settings.mjs";
import { CHAT_WORKTREE_ENV } from "../host/worktree-entry.mjs";
import { markLaunched, markStopped } from "./registry.mjs";

// The claude binary a chat runs, refused with the install hint when none is found.
export function chatBin(ctx) {
  const bin = (ctx.resolveBinImpl ?? resolveClaudeBin)(ctx.env);
  if (!bin?.bin) throw new UserError(CLAUDE_MISSING_MESSAGE);
  return bin.bin;
}

// Environment of a chat session: no job or operator scope, and the session's own worktree only when its record has one.
export function chatEnv(env, record) {
  const base = withoutJobScope(withoutOperatorSession(env));
  delete base[CHAT_WORKTREE_ENV];
  return record.worktree ? { ...base, [CHAT_WORKTREE_ENV]: record.worktree } : base;
}

// The argv of a chat session: its agent (a user one through `--agents`), the plugin, the nightqueue MCP server, the chat guard, and its Claude session fixed up front or resumed.
export function chatArgs({ record, agent, resume, operand, env }) {
  return profileArgs({
    kind: "chat",
    agents: agent?.agentsJson ?? null,
    agent: agent?.agent ?? null,
    pluginDir: pluginDir(),
    mcpConfig: mcpConfigArg(env),
    settings: chatSettings(),
    sessionId: resume ? null : record.claudeSessionId,
    resume: resume ? record.claudeSessionId : null,
    operand,
  });
}

// One line naming the session, where it runs, its agent and whether it works in its own worktree.
function launchLine(record) {
  const worktree = record.worktree ? " · worktree" : "";
  return `chat · ${record.id} · ${record.cwd} · agent ${record.agent ?? "none"}${worktree}`;
}

// Releases the launch claim; a failure only warns, because the session itself already ended.
function releaseClaim(claim, ctx) {
  try {
    markStopped(claim, ctx.env);
  } catch (err) {
    ctx.err(`nightqueue chat: warning: the launch claim of session ${claim.id} could not be released: ${err.message}`);
  }
}

// Runs one chat session in its recorded directory, fresh or resumed, under an exclusive launch claim, and returns the exit code of `claude`.
export function launchChat({ record, agent = null, resume = false, operand = null, bin, ctx }) {
  const args = chatArgs({ record, agent, resume, operand, env: ctx.env });
  const env = chatEnv(ctx.env, record);
  const claim = markLaunched(record, ctx.env, { killImpl: ctx.killImpl });
  ctx.out(launchLine(record));
  try {
    const result = ctx.spawnSyncImpl(bin, args, { stdio: "inherit", cwd: record.cwd, env });
    if (result?.error) throw new UserError(`could not run \`${bin}\` in ${record.cwd}: ${result.error.message}`);
    return childExitCode(result);
  } finally {
    releaseClaim(claim, ctx);
  }
}
