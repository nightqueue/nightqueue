import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { UserError } from "../../config/errors.mjs";
import { dbPath } from "../../config/paths.mjs";
import { jobRef } from "../refs.mjs";
import { ACTIVE_JOB_PREDICATE } from "../schema.mjs";
import { isBusyError, rollbackQuietly, sleepSync, withWriteRetry } from "../tx.mjs";
import { keepSequence, sequenceOf } from "./legacy.mjs";

// The machinery of a one-shot, version-gated schema step: nothing is written unless the whole step commits, and a byte copy of
// the database taken right before stays beside it. A step is `{ version, backupPath(env), isPending(db), migrateInside(db, env, ctx) }`.

const COPY_ATTEMPTS = 10;
const RETRY_PAUSE_MS = 50;

// The refusal a live lease causes: exactly one line, never wrapped, because only stopping the runners fixes it.
export class MigrationRefused extends UserError {}

// The schema version the connection reports.
export function userVersion(db) {
  return db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
}

// Tells whether a table exists in the schema.
export function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// Runs a file tool in a child process. The database file is only ever opened by another process: a POSIX lock belongs to the
// process, and closing any descriptor of the file in this one would silently drop the locks its SQLite connections hold.
function fileTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

// Tells whether the copy is the whole database as it stands under the write lock: no log beside the file, and the same bytes.
function copyIsCurrent(env, tmp) {
  const wal = statSync(`${dbPath(env)}-wal`, { throwIfNoEntry: false });
  if (wal && wal.size > 0) return false;
  return fileTool("cmp", ["-s", dbPath(env), tmp]).status === 0;
}

// Refuses the migration while a runner holds a live lease, naming the job; a crashed runner's expired lease does not block it.
export function refuseLiveLease(db, version) {
  if (!hasTable(db, "jobs")) return;
  const live = db.prepare(`SELECT slot.id FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE} LIMIT 1`).get();
  if (!live) return;
  throw new MigrationRefused(
    `the database must migrate to v${version}, but a runner holds a live lease on ${jobRef(live.id)}: stop the runners (\`nightqueue queue run --stop\`) and run the command again`,
  );
}

// Folds the write-ahead log into the database file so the file alone is the whole database; false when a reader kept it busy.
function walFolded(db) {
  if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") return true;
  try {
    return db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy === 0;
  } catch (err) {
    if (isBusyError(err)) return false;
    throw err;
  }
}

// Copies the database file to a private temporary name and flushes it to disk; published only once the lock proves it current.
function copyDatabase(env, step) {
  const tmp = `${step.backupPath(env)}.${process.pid}.tmp`;
  try {
    const copied = fileTool("cp", [dbPath(env), tmp]);
    if (copied.status !== 0) throw new Error(copied.stderr.trim() || `cp exited ${copied.status}`);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tmp;
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new UserError(`could not copy the database to ${tmp} before migrating it to v${step.version}: ${err?.message ?? err}; nothing was written`);
  }
}

// The verdict of the checks made once the write lock is held: another process migrated it, wrote after the copy, or it may go.
function verdictUnderLock(db, env, { tmp, step }) {
  if (!step.isPending(db)) return "skipped";
  if (!copyIsCurrent(env, tmp)) return "retry";
  refuseLiveLease(db, step.version);
  return "go";
}

// Rebuilds one table under a new shape: same rows in rowid order, the row count checked, the AUTOINCREMENT counter kept.
export function rebuildTable(db, { table, ddl, suffix, projection }) {
  const target = `${table}_${suffix}`;
  const sequence = sequenceOf(db, table);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  db.exec(`DROP TABLE IF EXISTS ${target}`);
  db.exec(ddl(target));
  const { columns, select } = projection(db, target);
  db.exec(`INSERT INTO ${target} (${columns.join(", ")}) ${select}`);
  const copied = db.prepare(`SELECT COUNT(*) AS n FROM ${target}`).get().n;
  if (copied !== before) throw new UserError(`${table}: copied ${copied} of ${before} rows`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${target} RENAME TO ${table}`);
  keepSequence(db, table, sequence);
}

// How many rows break a foreign key right now.
export function foreignKeyViolations(db) {
  return db.prepare("PRAGMA foreign_key_check").all().length;
}

// The failure of a migration that rolled back, saying where and that nothing changed.
function failureOf(err, { progress, step, env }) {
  if (err instanceof MigrationRefused) return err;
  const detail = err?.message ?? String(err);
  return new UserError(
    `migration to v${step.version} failed at ${progress.step}: ${detail}; nothing was written, the database is still at v${progress.version} (a copy is at ${step.backupPath(env)})`,
  );
}

// One attempt at the transaction over a copy already taken: `done`, `skipped` (a racer migrated it) or `retry` (a racer wrote).
function migrateFromCopy(db, env, { step, tmp, hooks }) {
  db.exec("PRAGMA foreign_keys = OFF");
  const progress = { step: "gate", version: userVersion(db) };
  try {
    withWriteRetry(() => db.exec("BEGIN IMMEDIATE"));
    try {
      const verdict = verdictUnderLock(db, env, { tmp, step });
      if (verdict !== "go") {
        rollbackQuietly(db);
        return verdict;
      }
      progress.version = userVersion(db);
      renameSync(tmp, step.backupPath(env));
      step.migrateInside(db, env, { hooks, progress });
      db.exec("COMMIT");
    } catch (err) {
      rollbackQuietly(db);
      throw failureOf(err, { progress, step, env });
    }
  } finally {
    rmSync(tmp, { force: true });
    db.exec("PRAGMA foreign_keys = ON");
  }
  hooks.afterCommit?.();
  return "done";
}

// Waits until no other connection holds the write lock, so a racer already migrating is let finish before the gate is read again.
function waitForWriters(db) {
  withWriteRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  });
}

// Runs a one-shot step once and tells whether this call did it; the hooks are for tests only.
export function runOneShot(db, env, step, hooks = {}) {
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
    waitForWriters(db);
    if (!step.isPending(db)) return false;
    refuseLiveLease(db, step.version);
    if (!walFolded(db)) {
      sleepSync(RETRY_PAUSE_MS);
      continue;
    }
    const outcome = migrateFromCopy(db, env, { step, tmp: copyDatabase(env, step), hooks });
    if (outcome === "done") return true;
    if (outcome === "skipped") return false;
  }
  if (!step.isPending(db)) return false;
  throw new UserError(`could not migrate the database to v${step.version}: another process kept writing to it; nothing was written, run the command again`);
}
