import { ghPrViewAsync } from "../host/gh.mjs";

export const PR_STATES = ["merged", "closed", "conflicted", "draft", "unknown", "open"];

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#].*)?$/i;
const TTL_MS = { merged: Infinity, closed: Infinity, open: 60_000, conflicted: 60_000, draft: 60_000, unknown: 8_000 };
const FAILED_COOLDOWN_MS = 30_000;
const CACHE_LIMIT = 500;

// Most gh reads one cache runs at once, however many pull requests and callers are waiting.
export const PR_REFRESH_CONCURRENCY = 4;

// A gate that lets at most `limit` tasks run at once, in the order they asked, starting a task synchronously when a slot is free.
function createSlotGate(limit) {
  let active = 0;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  const runHolding = async (task) => {
    try {
      return await task();
    } finally {
      release();
    }
  };
  return (task) => {
    if (active < limit) {
      active += 1;
      return runHolding(task);
    }
    return new Promise((resolve) => waiting.push(resolve)).then(() => runHolding(task));
  };
}

// Canonical `owner/repo#number` of a GitHub pull request URL, or null for anything gh would resolve against the cwd.
export function prStateKey(url) {
  if (typeof url !== "string") return null;
  const match = PR_URL_RE.exec(url.trim());
  return match ? `${match[1]}/${match[2]}#${match[3]}`.toLowerCase() : null;
}

// One state out of an answer of gh, by precedence merged > closed > conflicted > draft > unknown > open; null when gh could not tell.
export function flattenPrState(view) {
  if (view?.ok !== true) return null;
  if (view.state === "MERGED" || view.mergedAt) return "merged";
  if (view.state === "CLOSED") return "closed";
  if (view.state !== "OPEN") return null;
  if (view.mergeable === "CONFLICTING") return "conflicted";
  if (view.isDraft) return "draft";
  if (view.mergeable !== "MERGEABLE") return "unknown";
  return "open";
}

// Asks gh about one pull request and flattens the answer; a throw is a failed read, never a rejection.
async function askState(viewImpl, url, options) {
  try {
    return flattenPrState(await viewImpl(url, options));
  } catch {
    return null;
  }
}

// Process-local cache of pull request states: it never touches the database, and every refresh runs outside the caller's frame.
export function createPrStateCache({ viewImpl = ghPrViewAsync, now = Date.now } = {}) {
  const entries = new Map();
  const inFlight = new Map();
  const controller = new AbortController();
  const limited = createSlotGate(PR_REFRESH_CONCURRENCY);
  let disposed = false;

  function remember(key, state, ttlMs) {
    entries.delete(key);
    entries.set(key, { state, expiresAt: now() + ttlMs });
    if (entries.size > CACHE_LIMIT) entries.delete(entries.keys().next().value);
  }

  function record(key, state) {
    if (state) return remember(key, state, TTL_MS[state]);
    return remember(key, entries.get(key)?.state ?? null, FAILED_COOLDOWN_MS);
  }

  function isFresh(key) {
    const entry = entries.get(key);
    return entry !== undefined && now() < entry.expiresAt;
  }

  function start(key, url, env) {
    const promise = limited(() => (disposed ? null : askState(viewImpl, url, { env, signal: controller.signal })))
      .then((state) => record(key, state))
      .finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  }

  function stateOf(url) {
    const key = prStateKey(url);
    if (key === null) return null;
    return entries.get(key)?.state ?? "unknown";
  }

  // Whether the cache already holds an unexpired answer for this pull request, without asking gh: what a caller counts before it queries.
  function freshFor(url) {
    const key = prStateKey(url);
    return key !== null && isFresh(key);
  }

  async function refresh(urls, env) {
    if (env?.NIGHTQUEUE_NO_PR_CHECK === "1" || disposed) return;
    const touched = new Map();
    for (const url of Array.isArray(urls) ? urls : []) {
      const key = prStateKey(url);
      if (key === null || touched.has(key)) continue;
      if (inFlight.has(key)) touched.set(key, inFlight.get(key));
      else if (!isFresh(key)) touched.set(key, start(key, url, env));
    }
    await Promise.allSettled(touched.values());
  }

  function dispose() {
    disposed = true;
    controller.abort();
  }

  return { stateOf, isFresh: freshFor, refresh, dispose };
}
