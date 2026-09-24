import { callerJobId } from "../queue/retry.mjs";
import { runtimeVersion } from "./runtime.mjs";
import { isNewerVersion } from "./semver.mjs";
import { latestVersion } from "./update-check.mjs";

// The single line that tells the operator a newer version is published, or null when there is nothing to say; an unattended job never reads it.
export async function updateNoticeLine({ env = process.env, fetchImpl = null, now = Date.now } = {}) {
  try {
    if (callerJobId(env) !== null) return null;
    const latest = await latestVersion({ env, fetchImpl, now });
    const current = runtimeVersion(env);
    if (!latest || !current || !isNewerVersion(latest, current)) return null;
    return `nightqueue ${latest} is available (installed ${current}) - run \`nightqueue update\``;
  } catch {
    return null;
  }
}
