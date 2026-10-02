import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dbPath, dbShmPath, dbWalPath } from "../config/paths.mjs";
import { openBareDb, openDbReadOnly } from "./db.mjs";

// Closes a connection without letting the close mask the answer or the failure of what it ran.
function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    return;
  }
}

// Size in bytes of a file, or null when it is not there.
function fileSize(path) {
  return statSync(path, { throwIfNoEntry: false })?.size ?? null;
}

// Sizes of the database file and of its two sidecars, read with stat only.
export function dbFiles(env = process.env) {
  return { main: fileSize(dbPath(env)), wal: fileSize(dbWalPath(env)), shm: fileSize(dbShmPath(env)) };
}

// The answer of a check pragma: ok only when SQLite answered the single line `ok`.
function checkVerdict(db, pragma) {
  const lines = db.prepare(`PRAGMA ${pragma}`).all().map((row) => String(Object.values(row)[0]));
  return { ok: lines.length === 1 && lines[0] === "ok", lines };
}

// Runs a check pragma on a read-only connection to the live database.
function checkLive(env, pragma) {
  const db = openDbReadOnly(env, { anySchema: true });
  try {
    return checkVerdict(db, pragma);
  } finally {
    closeQuietly(db);
  }
}

// Runs `PRAGMA quick_check` on the live database, read-only.
export function quickCheck(env = process.env) {
  return checkLive(env, "quick_check");
}

// Runs `PRAGMA integrity_check` on the live database, read-only.
export function integrityCheck(env = process.env) {
  return checkLive(env, "integrity_check");
}

// Runs `PRAGMA quick_check` on a copy of the main file alone, so the live file never gets a second sqlite and its sidecars are left out.
export function quickCheckMainAlone(env = process.env) {
  const dir = mkdtempSync(join(tmpdir(), "nightqueue-main-"));
  try {
    const copy = join(dir, "main.db");
    copyFileSync(dbPath(env), copy);
    const db = openBareDb({ path: copy, env });
    try {
      return checkVerdict(db, "quick_check");
    } finally {
      closeQuietly(db);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Folds the whole write-ahead log into the database and truncates it (a passive pass first counts the frames, which a truncate reports as zero), behind a read-only pin so the close of the writable handle never deletes the sidecars.
export function checkpointTruncate(env = process.env) {
  const pin = openDbReadOnly(env, { anySchema: true });
  try {
    const db = openBareDb({ path: dbPath(env), env });
    try {
      const counted = db.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      const truncated = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      return { busy: truncated.busy, log: counted.log, checkpointed: counted.checkpointed };
    } finally {
      closeQuietly(db);
    }
  } finally {
    closeQuietly(pin);
  }
}
