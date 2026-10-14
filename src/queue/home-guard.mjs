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

// Refuses deleting a lesson or a memory from inside a queue run: what the corpus keeps is the operator's call.
export function refuseMemoryDeleteInsideJob(env, action) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(
    `refused: ${action} inside ${jobRef(own)}: deleting lessons and memories is the operator's call, made only outside a queue run; a run records them (\`lesson_save\`, \`memory_save\`) and never deletes one`,
  );
}

// Refuses a write to the issue tracker from inside a queue run, whatever the home: writing to it is the operator's call.
export function refuseTrackerWriteInsideJob(env, action) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(
    `refused: ${action} inside ${jobRef(own)}: writing to the issue tracker is the operator's call, made only outside a queue run after the person's explicit ok; a run reads it (\`tracker_read\`, \`tracker_issues\`) and never writes. Nothing was sent`,
  );
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
