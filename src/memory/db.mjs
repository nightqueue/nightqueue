import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { dbPath } from "../config/paths.mjs";
import { ensureHome } from "../config/store.mjs";
import { DB_USER_VERSION } from "./schema.mjs";

export { DB_USER_VERSION, isoToSqlite, sqliteToIso } from "./schema.mjs";
export { projectFromCwd, resolveProjectName } from "./project-name.mjs";

// Imports node:sqlite without leaking its experimental warning into the stderr of every hook.
async function importSqlite() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    const message = typeof warning === "string" ? warning : (warning?.message ?? "");
    if (message.includes("SQLite")) return;
    return original(warning, ...rest);
  };
  try {
    return await import("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

const { DatabaseSync } = await importSqlite();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  title TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  solution TEXT NOT NULL,
  prevention TEXT NOT NULL,
  attempts INTEGER,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  mtime_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project, path)
);
CREATE TABLE IF NOT EXISTS project_libs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  lib TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project, lib)
);
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  slug TEXT NOT NULL,
  tier TEXT NOT NULL,
  task_type TEXT,
  outcome TEXT NOT NULL,
  gate_stop TEXT,
  duration_s INTEGER,
  model TEXT,
  session_id TEXT,
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  prompt TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  timeout_s INTEGER NOT NULL DEFAULT 14400,
  lease_until TEXT,
  worker TEXT,
  session_id TEXT,
  slug TEXT,
  branch TEXT,
  pr_url TEXT,
  notice_md TEXT,
  result TEXT,
  operator_note TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_creation INTEGER,
  cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  merged_at TEXT,
  merge_sha TEXT
);
CREATE TABLE IF NOT EXISTS pipeline_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  phase TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  retry INTEGER NOT NULL DEFAULT 0,
  duration_s INTEGER,
  note TEXT,
  FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  number INTEGER,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  consequences TEXT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('proposed','accepted','superseded','rejected')),
  superseded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  embedding_model TEXT
);
CREATE TABLE IF NOT EXISTS roadmap_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  horizon TEXT NOT NULL CHECK(horizon IN ('now','next','later')),
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','queued','done','dropped')),
  position INTEGER NOT NULL,
  decision_id INTEGER,
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const EVOLVING_COLUMNS = [
  ["lessons", "target", "TEXT"],
  ["lessons", "archived", "INTEGER NOT NULL DEFAULT 0"],
  ["lessons", "archive_reason", "TEXT"],
  ["lessons", "injected", "INTEGER NOT NULL DEFAULT 0"],
  ["lessons", "last_injected_at", "TEXT"],
  ["lessons", "violated", "INTEGER NOT NULL DEFAULT 0"],
  ["lessons", "last_violated_at", "TEXT"],
  ["lessons", "last_recurred_at", "TEXT"],
  ["lessons", "embedding", "BLOB"],
  ["lessons", "embedding_model", "TEXT"],
  ["memory", "embedding", "BLOB"],
  ["memory", "embedding_model", "TEXT"],
  ["jobs", "merged_at", "TEXT"],
  ["jobs", "merge_sha", "TEXT"],
  ["jobs", "tier", "TEXT"],
  ["jobs", "not_before", "TEXT"],
  ["jobs", "blocked_code", "TEXT"],
  ["pipeline_runs", "tier_operator", "TEXT"],
  ["pipeline_runs", "tier_raise_reason", "TEXT"],
  ["decisions", "scope", "TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))"],
  ["decisions", "org", "TEXT"],
  ["roadmap_items", "scope", "TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))"],
  ["roadmap_items", "org", "TEXT"],
];

const INDEXES = `
CREATE INDEX IF NOT EXISTS lessons_recall_idx ON lessons(archived, project, created_at);
CREATE INDEX IF NOT EXISTS lessons_embedding_idx ON lessons(embedding_model);
CREATE INDEX IF NOT EXISTS memory_project_idx ON memory(project, created_at);
CREATE INDEX IF NOT EXISTS project_index_project_idx ON project_index(project, updated_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_project_idx ON pipeline_runs(project, created_at);
CREATE INDEX IF NOT EXISTS pipeline_phases_run_idx ON pipeline_phases(run_id, seq);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_project_slug_idx ON jobs(project, slug);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_number_idx ON decisions(project, number);
CREATE INDEX IF NOT EXISTS roadmap_items_order_idx ON roadmap_items(project, horizon, position);
CREATE INDEX IF NOT EXISTS roadmap_items_job_idx ON roadmap_items(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_number_idx ON decisions(org, number) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS roadmap_items_org_order_idx ON roadmap_items(org, horizon, position) WHERE scope = 'org';
`;

const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
  title, root_cause, solution, prevention,
  content='lessons', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS lessons_fts_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, title, root_cause, solution, prevention)
  VALUES (new.id, new.title, new.root_cause, new.solution, new.prevention);
END;
CREATE TRIGGER IF NOT EXISTS lessons_fts_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, title, root_cause, solution, prevention)
  VALUES ('delete', old.id, old.title, old.root_cause, old.solution, old.prevention);
END;
CREATE TRIGGER IF NOT EXISTS lessons_fts_au AFTER UPDATE OF title, root_cause, solution, prevention ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, title, root_cause, solution, prevention)
  VALUES ('delete', old.id, old.title, old.root_cause, old.solution, old.prevention);
  INSERT INTO lessons_fts(rowid, title, root_cause, solution, prevention)
  VALUES (new.id, new.title, new.root_cause, new.solution, new.prevention);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  key, value,
  content='memory', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF key, value ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
  INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, context, decision, consequences,
  content='decisions', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, title, context, decision, consequences)
  VALUES (new.id, new.title, new.context, new.decision, new.consequences);
END;
CREATE TRIGGER IF NOT EXISTS decisions_fts_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, context, decision, consequences)
  VALUES ('delete', old.id, old.title, old.context, old.decision, old.consequences);
END;
CREATE TRIGGER IF NOT EXISTS decisions_fts_au AFTER UPDATE OF title, context, decision, consequences ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, context, decision, consequences)
  VALUES ('delete', old.id, old.title, old.context, old.decision, old.consequences);
  INSERT INTO decisions_fts(rowid, title, context, decision, consequences)
  VALUES (new.id, new.title, new.context, new.decision, new.consequences);
END;
`;

const connections = new Map();
const walPins = new Map();
let walWarned = false;
let exitHookInstalled = false;

const BUSY_TIMEOUT_MS = 5000;
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
function sleepSync(ms) {
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
    `the nightshift database is still locked by another process after ${BUSY_ATTEMPTS} attempts; run the command again in a moment`,
  );
}

// Turns WAL on and warns once on stderr when the filesystem refused it.
function enableWal(db, path) {
  db.exec("PRAGMA journal_mode = WAL");
  const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  if (mode === "wal" || walWarned) return;
  walWarned = true;
  console.warn(`nightshift: warning: could not enable WAL on ${path} (journal_mode=${mode})`);
}

// Adds a column when it is missing, tolerating a concurrent process that added it first.
function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (columns.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (err) {
    if (!String(err?.message ?? "").includes("duplicate column name")) throw err;
  }
}

// Drops a column when it is present, tolerating a concurrent process that dropped it first.
function dropColumnIfPresent(db, table, column) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some((c) => c.name === column)) return;
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  } catch (err) {
    if (!/no such column/i.test(String(err?.message ?? ""))) throw err;
  }
}

// Turns every row still carrying the retired `merged` status into `closed`, writing only when such a row exists.
function retireMergedStatus(db) {
  if (!db.prepare("SELECT 1 FROM jobs WHERE status = 'merged' LIMIT 1").get()) return;
  db.exec("UPDATE jobs SET status = 'closed' WHERE status = 'merged'");
}

// Creates the base tables of the memory runtime.
function createSchema(db) {
  db.exec(SCHEMA);
}

// Brings an existing database to the current schema: evolving columns, indexes and the FTS mirrors.
function migrate(db) {
  for (const [table, column, definition] of EVOLVING_COLUMNS) addColumnIfMissing(db, table, column, definition);
  dropColumnIfPresent(db, "jobs", "pr_checked_at");
  retireMergedStatus(db);
  db.exec(INDEXES);
  db.exec(FTS);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version < 1) {
    db.exec("INSERT INTO lessons_fts(lessons_fts) VALUES('rebuild')");
    db.exec("INSERT INTO memory_fts(memory_fts) VALUES('rebuild')");
    db.exec("PRAGMA user_version = 1");
  }
  if (version < DB_USER_VERSION) db.exec(`PRAGMA user_version = ${DB_USER_VERSION}`);
}

// Migrates the database, turning a Node build without FTS5 into an actionable message.
function migrateOrExplain(db) {
  try {
    migrate(db);
  } catch (err) {
    if (!String(err?.message ?? "").toLowerCase().includes("fts5")) throw err;
    throw new UserError("this Node build has no FTS5 support; nightshift memory needs SQLite with FTS5");
  }
}

// Applies the pragmas and brings the schema of a freshly opened connection up to date.
function initConnection(db, path) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  enableWal(db, path);
  createSchema(db);
  migrateOrExplain(db);
}

// Closes the WRITABLE connections of this process while the read-only pins are still open, so the last connection
// SQLite sees close is a read-only one. It runs on `exit` because the order the driver tears its own handles down in is
// not ours to choose, and a writable connection that closes last is the one that folds the log and deletes the sidecars.
function closeWritableConnections() {
  for (const [path, db] of [...connections]) {
    connections.delete(path);
    try {
      db.close();
    } catch {
      continue;
    }
  }
}

// Installs the exit hook once per process.
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", closeWritableConnections);
}

// Keeps one read-only connection open for the life of the process, beside the writable one.
//
// SQLite folds the write-ahead log back into the database and DELETES `-wal`/`-shm` when the last connection to close
// is one that could write. That delete is correct only where the operating system really enforces the POSIX advisory
// lock of the other connections; where it does not — a FUSE or network mount of the home — it lands under a runner
// still attached to the shared-memory file, which then keeps writing through an inode nobody else can see while the
// next process creates a fresh one. Two wal-indexes over one log is how a healthy database starts answering
// `file is not a database` (`nightshift doctor`, checks `db shm` and `home mount`).
//
// A read-only connection can never take that delete, so holding one until the process really exits turns the fold on
// close into a checkpoint every other process survives. The pin READS once on purpose: a connection that has not run a
// statement has not mapped the wal-index at all, and one that has not mapped it is not a connection SQLite counts on
// close. It is taken AFTER the writable connection is initialized, because switching a fresh database into WAL needs no
// other connection attached, and a pin that cannot be opened costs the guarantee and never the command.
function pinWal(env, path) {
  if (walPins.has(path)) return;
  try {
    const pin = openDbReadOnly(env);
    pin.prepare("PRAGMA user_version").get();
    walPins.set(path, pin);
  } catch {
    return;
  }
}

// Opens the database of this NIGHTSHIFT_HOME, creating and migrating it on first use.
export function openDb(env = process.env) {
  const path = dbPath(env);
  const cached = connections.get(path);
  if (cached) return cached;
  ensureHome(env);
  const db = new DatabaseSync(path);
  withWriteRetry(() => initConnection(db, path));
  connections.set(path, db);
  installExitHook();
  pinWal(env, path);
  return db;
}

// Opens the database read-only and outside the connection cache, for a caller that must never create or migrate it.
export function openDbReadOnly(env = process.env) {
  return new DatabaseSync(dbPath(env), { readOnly: true });
}

// Schema version an already open connection reports, so a read-only caller reads it without creating nor migrating anything.
export function schemaVersionOn(db) {
  return db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
}

// Schema version of the database already on disk, read without creating nor migrating it.
function schemaVersion(env) {
  const db = openDbReadOnly(env);
  try {
    return schemaVersionOn(db);
  } finally {
    db.close();
  }
}

// Brings a database written by an older build up to this build's schema, so a read-only caller never selects a column the pending migration has not added yet.
export function migrateIfOutdated(env = process.env) {
  const path = dbPath(env);
  if (!existsSync(path)) return;
  const version = schemaVersion(env);
  if (version >= DB_USER_VERSION) return;
  try {
    openDb(env);
  } catch (err) {
    const detail = err instanceof UserError ? err.message : (err?.message ?? String(err));
    throw new UserError(
      `the memory database at ${path} is at schema v${version} and this build needs v${DB_USER_VERSION}, but it could not be migrated: ${detail}; make the database writable and run \`nightshift doctor\``,
    );
  }
}

// Tells whether this process holds a cached WRITABLE connection to a home. It exists for the TESTS that assert a
// read-only caller never opened one: the side effect they used to probe with — `-shm` vanishing on close — is gone now
// that a read-only pin keeps the sidecars in place, and a direct answer was always the better probe anyway.
export function hasCachedWriteConnection(env = process.env) {
  return connections.has(dbPath(env));
}

// Closes the cached connection of a home so a TEST can reopen it from scratch; production must never call it, because a close SQLite believes is the last one deletes `-shm`/`-wal`, and a filesystem that does not enforce the POSIX advisory lock of a live connection lets that happen under a runner still attached to them (`test/memory/close-guard.test.mjs` keeps it confined here). It releases the read-only pin of the home too, and in that order, so a home reopened in the same process pins the file it actually has.
export function closeDb(env = process.env) {
  const path = dbPath(env);
  const db = connections.get(path);
  const pin = walPins.get(path);
  connections.delete(path);
  walPins.delete(path);
  if (db) db.close();
  if (pin) pin.close();
}

export const FINISH_VERIFICATION_FAILED = "finish verification failed";

// The two lines a failed verification always writes: the literal on its own line, the detail under it.
export function finishVerificationReport(detail) {
  return `${FINISH_VERIFICATION_FAILED}\n${detail}\n`;
}

// Restores the durability level of a connection without ever masking the error of the action it wrapped.
function restoreSynchronous(db, level) {
  if (!Number.isInteger(level)) return;
  try {
    db.exec(`PRAGMA synchronous = ${level}`);
  } catch {
    return;
  }
}

// Runs an action with SQLite fsyncing every commit; it must wrap the transaction from the outside, never run inside one.
export function withFullSync(db, action) {
  const previous = db.prepare("PRAGMA synchronous").get()?.synchronous;
  db.exec("PRAGMA synchronous = FULL");
  try {
    return action();
  } finally {
    restoreSynchronous(db, previous);
  }
}

// Folds the write-ahead log back into the database file; a checkpoint nobody could take is never an error of the caller.
export function checkpointWal(env = process.env) {
  try {
    openDb(env).exec("PRAGMA wal_checkpoint(PASSIVE)");
    return true;
  } catch {
    return false;
  }
}

// Tells whether every value of a vector is finite, because a single NaN silently kills every cosine.
function isFiniteVector(values) {
  for (const value of values) {
    if (!Number.isFinite(value)) return false;
  }
  return true;
}

// Serializes an embedding vector into Float32 bytes; empty or non-finite is an error, never a corrupt row.
export function vectorToBlob(vector) {
  const values = vector instanceof Float32Array ? vector : Float32Array.from(Array.isArray(vector) ? vector : []);
  if (!values.length) throw new Error("vectorToBlob: empty vector");
  if (!isFiniteVector(values)) throw new Error("vectorToBlob: vector with a non-finite value");
  return new Uint8Array(values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength));
}

// Deserializes a database BLOB into a Float32Array, copying the buffer because byteOffset may not be 4-aligned.
export function blobToVector(blob) {
  if (!ArrayBuffer.isView(blob)) throw new Error("blobToVector: expected a Uint8Array coming from the database");
  if (!blob.byteLength || blob.byteLength % 4 !== 0) {
    throw new Error(`blobToVector: invalid size (${blob.byteLength} bytes, expected a multiple of 4)`);
  }
  return new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
}

// Normalizes a query vector; invalid input returns null and the semantic path steps aside.
export function toQueryVector(vector) {
  if (vector instanceof Float32Array) return vector.length && isFiniteVector(vector) ? vector : null;
  if (!Array.isArray(vector) || !vector.length || !isFiniteVector(vector)) return null;
  return Float32Array.from(vector);
}

// Cosine of two L2-normalized vectors of the same length.
export function dotProduct(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
