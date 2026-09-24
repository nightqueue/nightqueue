import { resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { homeDir } from "../config/paths.mjs";
import { claudeConfigDir } from "../host/paths.mjs";
import { callerJobId } from "./retry.mjs";

// The home and the Claude configuration directory the runner itself uses, pinned on every unattended child so a job can tell them from a temporary one.
export const JOB_HOME_ENV = "NIGHTQUEUE_JOB_HOME";
export const JOB_CLAUDE_DIR_ENV = "NIGHTQUEUE_JOB_CLAUDE_DIR";

// One path the runner pinned on this child, resolved, or an empty string when it pinned none.
function pinnedPath(env, key) {
  const raw = typeof env?.[key] === "string" ? env[key].trim() : "";
  return raw ? resolve(raw) : "";
}

// Tells whether the write would land in the home of the runner; a job spawned by an older runner pinned nothing, so the default home is read as the operator's.
function writesRunnerHome(env) {
  const pinned = pinnedPath(env, JOB_HOME_ENV);
  if (pinned) return pinned === homeDir(env);
  const asked = typeof env?.NIGHTQUEUE_HOME === "string" ? env.NIGHTQUEUE_HOME.trim() : "";
  return asked === "";
}

// Tells whether the write would land in the Claude configuration directory of the runner.
function writesRunnerHost(env) {
  const pinned = pinnedPath(env, JOB_CLAUDE_DIR_ENV);
  return pinned !== "" && pinned === claudeConfigDir(env);
}

// Refuses a command that would change the home - or, with `host`, the Claude settings - the unattended runner itself uses; a temporary home is always allowed.
export function refuseHomeWriteInsideJob(env, { host = false } = {}) {
  const own = callerJobId(env);
  if (own === null) return;
  if (writesRunnerHome(env)) {
    throw new UserError(
      `refused: this command would change the operator's nightqueue home from inside job #${own}; verify against a temporary home (NIGHTQUEUE_HOME=$(mktemp -d)) instead`,
    );
  }
  if (host === true && writesRunnerHost(env)) {
    throw new UserError(
      `refused: this command would change the operator's Claude settings from inside job #${own}; verify against a temporary host (CLAUDE_CONFIG_DIR=$(mktemp -d)) too`,
    );
  }
}
