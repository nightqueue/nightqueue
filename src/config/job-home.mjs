import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { homeDir } from "./paths.mjs";

// The home the runner itself uses, pinned on every unattended child so a job can tell it from a temporary one.
export const JOB_HOME_ENV = "NIGHTQUEUE_JOB_HOME";

// Job this process is running inside, when the queue spawned it; null in a session of the operator.
export function callerJobId(env) {
  const raw = typeof env?.NIGHTQUEUE_JOB_ID === "string" ? env.NIGHTQUEUE_JOB_ID.trim() : "";
  return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
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
