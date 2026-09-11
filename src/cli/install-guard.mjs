import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { dbPath } from "../config/paths.mjs";
import { firstActiveJobId } from "../memory/jobs.mjs";
import { runnerPidfileState } from "../queue/pidfile.mjs";

const REFUSAL_TAIL =
  "the runtime cannot be replaced while it runs; stop it with nightshift queue run --stop or wait for the queue to drain";

// Job holding a live lease, or null when there is no queue database or it could not be read: an install is the repair path, so a database it cannot open never blocks it, and a home without one is never created by a check.
function activeJobId(env) {
  if (!existsSync(dbPath(env))) return null;
  try {
    return firstActiveJobId(env);
  } catch {
    return null;
  }
}

// How the live runner is named, with whichever of the two facts is known: its pid, the job it holds, or both.
function activeLabel({ pid, jobId }) {
  const parts = [];
  if (pid !== null) parts.push(`pid ${pid}`);
  if (jobId !== null) parts.push(`job #${jobId}`);
  return parts.join(" / ");
}

// The tree the live runner registered it loaded from, named next to it so `--force` says exactly which one it is about to replace.
function withRuntimeDir(label, state) {
  const dir = state.status === "alive" ? state.info.runtimeDir : null;
  return typeof dir === "string" && dir ? `${label}, runtime ${dir}` : label;
}

// Refuses to replace the runtime under a live runner: a registered runner or a job holding a live lease both mean a process is executing the tree this install would swap.
export function guardIdleRuntime(ctx, { force } = {}) {
  const state = runnerPidfileState(ctx.env, ctx.killImpl);
  const pid = state.status === "alive" ? state.info.pid : null;
  const jobId = activeJobId(ctx.env);
  if (pid === null && jobId === null) return;
  const label = activeLabel({ pid, jobId });
  if (force === true) {
    ctx.err(`warning: --force is replacing the runtime while a runner is active (${withRuntimeDir(label, state)}); the job it is running may fail`);
    return;
  }
  throw new UserError(`a runner is active (${label}) - ${REFUSAL_TAIL}`);
}
