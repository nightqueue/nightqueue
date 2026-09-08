import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./errors.mjs";
import { homeDir } from "./paths.mjs";

const ACQUIRE_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const STALE_AFTER_MS = 300000;

// Path of the directory that acts as the write lock of NIGHTSHIFT_HOME.
export function lockPath(env = process.env) {
  return `${homeDir(env)}.lock`;
}

// Waits a short interval before the next acquisition attempt.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tries to create the lock directory, returning false when it already belongs to another process.
function tryCreate(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
}

// Drops a lock old enough that it can only have been abandoned by a dead process.
function dropStale(path, staleAfterMs) {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats || Date.now() - stats.mtimeMs < staleAfterMs) return false;
  rmSync(path, { recursive: true, force: true });
  return true;
}

// Acquires the lock, failing with a usage error when another nightshift holds it past the timeout.
async function acquire(path, { timeoutMs, staleAfterMs }) {
  const deadline = Date.now() + timeoutMs;
  let staleDropped = false;
  for (;;) {
    if (tryCreate(path)) return;
    if (!staleDropped && dropStale(path, staleAfterMs)) {
      staleDropped = true;
      continue;
    }
    if (Date.now() >= deadline) {
      throw new UserError(
        `another nightshift command is writing to the configuration home; try again in a moment, or remove \`${path}\` if no other nightshift is running`,
      );
    }
    await delay(RETRY_INTERVAL_MS);
  }
}

// Runs the action with exclusion between processes over the same NIGHTSHIFT_HOME.
export async function withLock(env, action, { timeoutMs = ACQUIRE_TIMEOUT_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  const path = lockPath(env);
  await acquire(path, { timeoutMs, staleAfterMs });
  try {
    return await action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
