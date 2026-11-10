import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { claimPin, JOB_CLAIM_ENV, JOB_CLAUDE_DIR_ENV, JOB_HOME_ENV } from "../config/job-home.mjs";
import { homeDir } from "../config/paths.mjs";
import { claudeConfigDir, packageRoot } from "./paths.mjs";

export const CLAUDE_MISSING_MESSAGE =
  "`claude` CLI not found; install Claude Code or set NIGHTQUEUE_CLAUDE_BIN to its absolute path";

const MISSING_BIN = Object.freeze({ bin: null, via: "missing" });

// Directory of the nightqueue plugin handed to the child through --plugin-dir.
export function pluginDir() {
  return join(packageRoot(), "plugin");
}

// Entrypoint of this CLI, used to start the nightqueue MCP server and the detached runner.
export function cliEntrypoint() {
  return join(packageRoot(), "bin", "nightqueue.mjs");
}

// Identity of an unattended run, pinned on the child: the job it may act on, the claim it writes for, plus the home and the Claude settings it may never change.
export function jobIdentity(env, jobId, claim) {
  return {
    NIGHTQUEUE_JOB_ID: String(jobId),
    [JOB_HOME_ENV]: homeDir(env),
    [JOB_CLAUDE_DIR_ENV]: claudeConfigDir(env),
    ...(claim ? { [JOB_CLAIM_ENV]: claimPin(claim) } : {}),
  };
}

// Identity of an operator session, pinned on its MCP server only when the launcher passes it explicitly.
function operatorIdentity(operator) {
  return {
    NIGHTQUEUE_MODE: String(operator.mode ?? "operator"),
    NIGHTQUEUE_OPERATOR_SESSION: String(operator.session),
    NIGHTQUEUE_OPERATOR_PID: String(operator.pid ?? process.pid),
  };
}

// Environment of the MCP server of the child: the home it answers for and, inside an unattended run, the job it is allowed to act on, or the operator session it serves.
function mcpServerEnv(env, jobId, { operator, claim }) {
  const home = { NIGHTQUEUE_HOME: homeDir(env) };
  if (jobId !== null && jobId !== undefined) return { ...home, ...jobIdentity(env, jobId, claim) };
  return operator?.session ? { ...home, ...operatorIdentity(operator) } : home;
}

// Inline --mcp-config value: one single argv string, no shell and no temporary file; the job or operator identity is pinned here, never inherited from the parent process.
export function mcpConfigArg(env = process.env, jobId = null, { operator = null, claim = null } = {}) {
  return JSON.stringify({
    mcpServers: {
      nightqueue: {
        command: process.execPath,
        args: [cliEntrypoint(), "mcp"],
        env: mcpServerEnv(env, jobId, { operator, claim }),
      },
    },
  });
}

// Common installation paths of the CLI, in order of preference, used when PATH does not resolve it.
function fixedCandidates(home) {
  return [join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
}

// Paths to test, in order of precedence, each one with the source that produced it.
function candidateBins(env, home) {
  const candidates = [];
  const fromEnv = String(env?.NIGHTQUEUE_CLAUDE_BIN ?? "").trim();
  if (fromEnv && isAbsolute(fromEnv)) candidates.push({ bin: fromEnv, via: "env" });
  for (const dir of String(env?.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push({ bin: join(dir, "claude"), via: "path" });
  }
  for (const bin of fixedCandidates(home)) candidates.push({ bin, via: "candidate" });
  return candidates;
}

// Tells whether the path exists and is executable by the current user.
function isRunnable(path) {
  try {
    accessSync(path, constants.X_OK);
    return existsSync(path);
  } catch {
    return false;
  }
}

// Resolves the `claude` binary (env, then PATH, then fixed candidates); absence never throws.
export function resolveClaudeBin(env = process.env) {
  try {
    const home = String(env?.HOME ?? "").trim() || homedir();
    const found = candidateBins(env, home).find(({ bin }) => isRunnable(bin));
    return found ? Object.freeze({ bin: found.bin, via: found.via }) : MISSING_BIN;
  } catch {
    return MISSING_BIN;
  }
}
