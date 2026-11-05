import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homeDir } from "./paths.mjs";

// The home the runner itself uses, pinned on every unattended child so a job can tell it from a temporary one.
export const JOB_HOME_ENV = "NIGHTQUEUE_JOB_HOME";

// The claim the runner pinned on this child, `<attempt>:<worker>#<ordinal>`, so a record says which claim wrote it.
export const JOB_CLAIM_ENV = "NIGHTQUEUE_JOB_CLAIM";

// The Claude configuration directory the runner itself uses, pinned on every unattended child so a job can tell it from a temporary one.
export const JOB_CLAUDE_DIR_ENV = "NIGHTQUEUE_JOB_CLAUDE_DIR";

// The lease token of a detached close worker, set only on the worker the close starts.
export const CLOSE_WORKER_ENV = "NIGHTQUEUE_CLOSE_WORKER";

// The pin of a claim: its attempt and worker, then the ordinal of its `job_attempts` row when known, the one part a re-claim after a park never repeats.
export function claimPin({ attempt, worker = null, ordinal = null }) {
  return `${attempt}:${worker ?? ""}${Number.isInteger(ordinal) ? `#${ordinal}` : ""}`;
}

// Job this process is running inside, when the queue spawned it; null in a session of the operator.
export function callerJobId(env) {
  const raw = typeof env?.NIGHTQUEUE_JOB_ID === "string" ? env.NIGHTQUEUE_JOB_ID.trim() : "";
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
}

// The claim this process was started under, or null when the runner pinned none or what it pinned cannot be read.
export function callerClaim(env) {
  const raw = typeof env?.[JOB_CLAIM_ENV] === "string" ? env[JOB_CLAIM_ENV].trim() : "";
  const match = /^([1-9]\d*):(.*?)(?:#([1-9]\d*))?$/.exec(raw);
  if (!match) return null;
  return { attempt: Number(match[1]), worker: match[2] || null, ...(match[3] ? { ordinal: Number(match[3]) } : {}) };
}

// One path the runner pinned on this child, resolved, or an empty string when it pinned none.
export function pinnedPath(env, key) {
  const raw = typeof env?.[key] === "string" ? env[key].trim() : "";
  return raw ? resolve(raw) : "";
}

// The real path of a directory, following symlinks, or the path as given when it cannot be resolved.
function realPathOf(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// Tells whether the home this environment resolves is the runner's own; a job spawned by an older runner pinned nothing, so the default home is read as the operator's.
export function isRunnerHome(env) {
  const pinned = pinnedPath(env, JOB_HOME_ENV);
  if (pinned) return pinned === homeDir(env) || realPathOf(pinned) === realPathOf(homeDir(env));
  const asked = typeof env?.NIGHTQUEUE_HOME === "string" ? env.NIGHTQUEUE_HOME.trim() : "";
  return asked === "";
}
