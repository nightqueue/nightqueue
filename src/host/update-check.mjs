import { PACKAGE_NAME, updateCheckPath } from "../config/paths.mjs";
import { ensureHome, writeFileAtomic } from "../config/store.mjs";
import { readJsonOrNull } from "./json.mjs";

export const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const REGISTRY_TIMEOUT_MS = 3000;

const DIST_TAGS_URL = `https://registry.npmjs.org/-/package/${encodeURIComponent(PACKAGE_NAME)}/dist-tags`;

// Version a previous check stored, or null when the cache holds nothing usable.
function cachedVersion(cache) {
  return typeof cache?.latest === "string" && cache.latest ? cache.latest : null;
}

// Tells whether a cache entry is young enough to answer alone; a stamp in the future is stale, so a wrong clock costs one request instead of freezing the cache forever.
function isFresh(cache, now) {
  const checkedAt = Date.parse(cache?.checkedAt ?? "");
  if (!Number.isFinite(checkedAt)) return false;
  const age = now - checkedAt;
  return age >= 0 && age < UPDATE_CHECK_TTL_MS;
}

// Asks the registry for the `latest` dist-tag of this package, answering null on anything that is not a version.
async function askRegistry(fetchImpl) {
  try {
    const res = await fetchImpl(DIST_TAGS_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
    if (!res?.ok) return null;
    const body = await res.json();
    return typeof body?.latest === "string" && body.latest ? body.latest : null;
  } catch {
    return null;
  }
}

// Stamps the attempt, keeping the value the last successful check found: an offline machine must pay the timeout once a day, not once a command.
function writeCache(env, latest, checkedAt) {
  try {
    ensureHome(env);
    writeFileAtomic(updateCheckPath(env), `${JSON.stringify({ checkedAt, latest }, null, 2)}\n`);
  } catch {}
}

// Newest published version of this package, refreshed from the registry at most once a day; it never prints, never throws, and without a `fetchImpl` it never opens a socket.
export async function latestVersion({ env = process.env, fetchImpl = null, now = Date.now } = {}) {
  if (env?.NIGHTSHIFT_NO_UPDATE_CHECK === "1") return null;
  try {
    const cache = readJsonOrNull(updateCheckPath(env));
    const previous = cachedVersion(cache);
    if (isFresh(cache, now())) return previous;
    if (typeof fetchImpl !== "function") return previous;
    const latest = (await askRegistry(fetchImpl)) ?? previous;
    writeCache(env, latest, new Date(now()).toISOString());
    return latest;
  } catch {
    return null;
  }
}
