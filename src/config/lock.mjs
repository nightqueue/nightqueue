import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "./errors.mjs";
import { homeDir } from "./paths.mjs";

const ACQUIRE_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const STALE_AFTER_MS = 300000;

// A synchronous holder keeps the lock for a single read and write, so it is asked for again almost immediately.
const SYNC_RETRY_INTERVAL_MS = 1;

// Path of the directory that acts as the write lock of NIGHTQUEUE_HOME.
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

// One attempt at the lock: taken, or held by somebody else - a lock old enough to have been abandoned by a dead process is dropped once, then tried again.
function takeOnce(path, staleAfterMs, state) {
  if (tryCreate(path)) return true;
  if (state.staleDropped || !dropStale(path, staleAfterMs)) return false;
  state.staleDropped = true;
  return tryCreate(path);
}

// Acquires the lock, failing with a usage error when another nightqueue holds it past the timeout.
async function acquire(path, { timeoutMs, staleAfterMs }) {
  const deadline = Date.now() + timeoutMs;
  const state = { staleDropped: false };
  for (;;) {
    if (takeOnce(path, staleAfterMs, state)) return;
    if (Date.now() >= deadline) {
      throw new UserError(
        `another nightqueue command is writing to the configuration home; try again in a moment, or remove \`${path}\` if no other nightqueue is running`,
      );
    }
    await delay(RETRY_INTERVAL_MS);
  }
}

// Waits without yielding the thread, the only pause a synchronous holder can take between two attempts.
function delaySync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Acquires the lock without yielding, telling whether it was taken before the timeout instead of throwing.
function acquireSync(path, { timeoutMs, staleAfterMs }) {
  const deadline = Date.now() + timeoutMs;
  const state = { staleDropped: false };
  for (;;) {
    if (takeOnce(path, staleAfterMs, state)) return true;
    if (Date.now() >= deadline) return false;
    delaySync(SYNC_RETRY_INTERVAL_MS);
  }
}

// Runs the action with exclusion between processes over the same NIGHTQUEUE_HOME.
export async function withLock(env, action, { timeoutMs = ACQUIRE_TIMEOUT_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  const path = lockPath(env);
  await acquire(path, { timeoutMs, staleAfterMs });
  try {
    return await action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

// Runs a SYNCHRONOUS action with exclusion between processes over one lock path, for a read-modify-write that cannot be awaited.
export function withLockSync(path, action, { timeoutMs = ACQUIRE_TIMEOUT_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!acquireSync(path, { timeoutMs, staleAfterMs })) {
    throw new UserError(`another nightqueue process is holding \`${path}\`; try again in a moment, or remove it if no other nightqueue is running`);
  }
  try {
    return action();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}
