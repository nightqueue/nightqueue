import { UserError } from "../config/errors.mjs";

const BUSY_ATTEMPTS = 24;
const BUSY_BASE_MS = 20;
const BUSY_MAX_MS = 200;
const BUSY_CODES = new Set([5, 6]);
const sleepSlot = new Int32Array(new SharedArrayBuffer(4));

// Tells whether a failure is SQLite refusing the write because another process holds the lock.
export function isBusyError(err) {
  const primary = Number.isInteger(err?.errcode) ? err.errcode & 0xff : 0;
  if (BUSY_CODES.has(primary)) return true;
  return /database (is|table is) locked|sqlite_busy/i.test(String(err?.message ?? ""));
}

// Blocks this thread for a few milliseconds, because every node:sqlite call is synchronous.
export function sleepSync(ms) {
  Atomics.wait(sleepSlot, 0, 0, ms);
}

// Backoff of one retry: it doubles up to a short ceiling, so a busy writer is waited out without a stall.
function backoffDelay(attempt) {
  return Math.min(BUSY_BASE_MS * 2 ** attempt, BUSY_MAX_MS);
}

// Runs a database write, retrying while another process holds the lock; giving up is an actionable message.
export function withWriteRetry(action) {
  for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt += 1) {
    try {
      return action();
    } catch (err) {
      if (!isBusyError(err)) throw err;
      sleepSync(backoffDelay(attempt));
    }
  }
  throw new UserError(
    `the nightqueue database is still locked by another process after ${BUSY_ATTEMPTS} attempts; run the command again in a moment`,
  );
}

// Undoes a failed transaction without ever masking the error that caused it.
export function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
}

// Runs the given steps inside one immediate transaction, so no reader is ever promoted to writer.
export function inTransaction(db, steps) {
  return withWriteRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = steps();
      db.exec("COMMIT");
      return value;
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
  });
}
