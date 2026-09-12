import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { dbPath } from "../config/paths.mjs";
import { firstActiveJobId } from "../memory/jobs.mjs";
import { liveRunnersReport } from "../queue/registry.mjs";

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

// How the live runners are named, with whichever facts are known: every registered pid, the job one of them holds, or both.
function activeLabel({ runners, jobId }) {
  const parts = runners.map((runner) => `pid ${runner.pid}`);
  if (jobId !== null) parts.push(`job #${jobId}`);
  return parts.join(" / ");
}

// The trees the live runners registered they loaded from, named next to them so `--force` says exactly which ones it is about to replace.
function withRuntimeDirs(label, runners) {
  const dirs = [...new Set(runners.map((runner) => runner.runtimeDir).filter((dir) => typeof dir === "string" && dir))];
  return dirs.length ? `${label}, ${dirs.map((dir) => `runtime ${dir}`).join(", ")}` : label;
}

// The live runners, or a refusal when the registry could not even be listed: an install never treats a registry it cannot read as an idle host, and `--force` stays the only way through.
function liveRunnersOrRefuse(ctx, force) {
  const { runners, error } = liveRunnersReport(ctx.env, ctx.killImpl);
  if (error === null) return runners;
  const detail = `the runner registry cannot be listed (${error}), so a live runner may be invisible`;
  if (force !== true) throw new UserError(`${detail} - ${REFUSAL_TAIL}`);
  ctx.err(`warning: --force is replacing the runtime although ${detail}; the job it is running may fail`);
  return runners;
}

// Refuses to replace the runtime under a live runner: any registered runner or a job holding a live lease means a process is executing the tree this install would swap.
export function guardIdleRuntime(ctx, { force } = {}) {
  const runners = liveRunnersOrRefuse(ctx, force);
  const jobId = activeJobId(ctx.env);
  if (!runners.length && jobId === null) return;
  const label = activeLabel({ runners, jobId });
  if (force === true) {
    ctx.err(`warning: --force is replacing the runtime while a runner is active (${withRuntimeDirs(label, runners)}); the job it is running may fail`);
    return;
  }
  throw new UserError(`a runner is active (${label}) - ${REFUSAL_TAIL}`);
}
