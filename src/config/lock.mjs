import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UserError } from "./errors.mjs";
import { homeDir } from "./paths.mjs";

const ACQUIRE_TIMEOUT_MS = 5000;
const RETRY_INTERVAL_MS = 50;
const STALE_AFTER_MS = 300000;
const OWNER_FILE = "owner";

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

// Records this process as the owner of a lock just taken; a lock whose owner could not be written falls back to the age rule alone.
function writeOwner(path) {
  try {
    writeFileSync(join(path, OWNER_FILE), String(process.pid));
  } catch {
    return;
  }
}

// The pid recorded as the owner of a lock, or null for a lock that names none.
export function lockOwnerPid(path) {
  try {
    const pid = Number(readFileSync(join(path, OWNER_FILE), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

// Tells whether a process is still alive; one this user may not signal is alive too.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// Tries to create the lock directory, returning false when it already belongs to another process.
function tryCreate(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw err;
  }
  writeOwner(path);
  return true;
}

// Drops a lock old enough that it can only have been abandoned by a dead process; a lock whose recorded owner is alive is never stale, however long it is held.
function dropStale(path, staleAfterMs) {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats || Date.now() - stats.mtimeMs < staleAfterMs) return false;
  const owner = lockOwnerPid(path);
  if (owner !== null && isAlive(owner)) return false;
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

const heldByThisProcess = new Set();

// Releases a lock this process took.
function release(path) {
  heldByThisProcess.delete(path);
  rmSync(path, { recursive: true, force: true });
}

// Runs the action with exclusion between processes over the same NIGHTQUEUE_HOME.
export async function withLock(env, action, { timeoutMs = ACQUIRE_TIMEOUT_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  const path = lockPath(env);
  await acquire(path, { timeoutMs, staleAfterMs });
  heldByThisProcess.add(path);
  try {
    return await action();
  } finally {
    release(path);
  }
}

// Runs a SYNCHRONOUS action with exclusion between processes over one lock path, for a read-modify-write that cannot be awaited.
export function withLockSync(path, action, { timeoutMs = ACQUIRE_TIMEOUT_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!acquireSync(path, { timeoutMs, staleAfterMs })) {
    throw new UserError(`another nightqueue process is holding \`${path}\`; try again in a moment, or remove it if no other nightqueue is running`);
  }
  heldByThisProcess.add(path);
  try {
    return action();
  } finally {
    release(path);
  }
}

// Runs a SYNCHRONOUS action under a lock only when it is free or already held by this process, telling whether it ran; a busy lock skips it.
export function runIfLockFree(path, action, { timeoutMs = 250, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (heldByThisProcess.has(path)) {
    action();
    return true;
  }
  if (!acquireSync(path, { timeoutMs, staleAfterMs })) return false;
  heldByThisProcess.add(path);
  try {
    action();
    return true;
  } finally {
    release(path);
  }
}
