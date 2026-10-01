import { UserError } from "../config/errors.mjs";
import { callerJobId, isRunnerHome, pinnedPath } from "../config/job-home.mjs";
import { claudeConfigDir } from "../host/paths.mjs";
import { jobRef } from "../memory/refs.mjs";

export { JOB_HOME_ENV } from "../config/job-home.mjs";

// The Claude configuration directory the runner itself uses, pinned on every unattended child so a job can tell it from a temporary one.
export const JOB_CLAUDE_DIR_ENV = "NIGHTQUEUE_JOB_CLAUDE_DIR";

// Tells whether the write would land in the Claude configuration directory of the runner.
function writesRunnerHost(env) {
  const pinned = pinnedPath(env, JOB_CLAUDE_DIR_ENV);
  return pinned !== "" && pinned === claudeConfigDir(env);
}

// Refuses a command that would change the home - or, with `host`, the Claude settings - the unattended runner itself uses; a temporary home is always allowed.
export function refuseHomeWriteInsideJob(env, { host = false } = {}) {
  const own = callerJobId(env);
  if (own === null) return;
  if (isRunnerHome(env)) {
    throw new UserError(
      `refused: this command would change the operator's nightqueue home from inside ${jobRef(own)}; verify against a temporary home (NIGHTQUEUE_HOME=$(mktemp -d)) instead`,
    );
  }
  if (host === true && writesRunnerHost(env)) {
    throw new UserError(
      `refused: this command would change the operator's Claude settings from inside ${jobRef(own)}; verify against a temporary host (CLAUDE_CONFIG_DIR=$(mktemp -d)) too`,
    );
  }
}
