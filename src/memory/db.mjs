import { existsSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { dbPath } from "../config/paths.mjs";
import { ensureHome, loadRawConfig } from "../config/store.mjs";
import { addColumnIfMissing, dropColumnIfPresent } from "./columns.mjs";
import { EVOLVING_COLUMNS, FTS, INDEXES, REGISTRY, ROADMAP_FTS, SCHEMA } from "./ddl.mjs";
import { closeMigrationPending, migrateCloseColumns } from "./migration/close-columns.mjs";
import { MigrationRefused, finishV18, importLegacyRegistry, migrateToV18, schemaState } from "./migration/v18.mjs";
import { ensureDefaultOrg } from "./registry.mjs";
import { DB_USER_VERSION } from "./schema.mjs";
import { migrateSharedSlugs, sharedSlugPending } from "./shared-slug-migration.mjs";
import { inTransaction, withWriteRetry } from "./tx.mjs";

export { DB_USER_VERSION, isoToSqlite, sqliteToIso } from "./schema.mjs";
export { inTransaction, isBusyError, withWriteRetry } from "./tx.mjs";

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

const connections = new Map();
const walPins = new Map();
let walWarned = false;
let exitHookInstalled = false;

const BUSY_TIMEOUT_MS = 5000;

// Turns WAL on and warns once on stderr when the filesystem refused it.
function enableWal(db, path) {
  db.exec("PRAGMA journal_mode = WAL");
  const mode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
  if (mode === "wal" || walWarned) return;
  walWarned = true;
  console.warn(`nightqueue: warning: could not enable WAL on ${path} (journal_mode=${mode})`);
}

// Creates the base tables of the memory runtime and the registry of orgs and projects.
function createSchema(db) {
  db.exec(REGISTRY);
  db.exec(SCHEMA);
}

// Fills the registry of a database created just now: the v17 registry a config.json may still carry, then the default org.
function createRegistry(db, env) {
  const raw = loadRawConfig(env);
  inTransaction(db, () => {
    importLegacyRegistry(db, raw);
    ensureDefaultOrg(db);
  });
}

// Brings an existing database to the current schema: evolving columns, indexes and the FTS mirrors.
function migrate(db) {
  for (const [table, column, definition] of EVOLVING_COLUMNS) addColumnIfMissing(db, table, column, definition);
  dropColumnIfPresent(db, "jobs", "pr_checked_at");
  dropColumnIfPresent(db, "jobs", "merged_at");
  dropColumnIfPresent(db, "jobs", "merge_sha");
  if (closeMigrationPending(db)) inTransaction(db, () => migrateCloseColumns(db));
  if (sharedSlugPending(db)) inTransaction(db, () => migrateSharedSlugs(db));
  db.exec(INDEXES);
  db.exec(FTS);
  db.exec(ROADMAP_FTS);
  ensureDefaultOrg(db);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version < DB_USER_VERSION) db.exec(`PRAGMA user_version = ${DB_USER_VERSION}`);
}

// Migrates the database, turning a Node build without FTS5 into an actionable message.
function migrateOrExplain(db) {
  try {
    migrate(db);
  } catch (err) {
    if (!String(err?.message ?? "").toLowerCase().includes("fts5")) throw err;
    throw new UserError("this Node build has no FTS5 support; nightqueue memory needs SQLite with FTS5");
  }
}

// Applies the pragmas and brings the schema of a freshly opened connection up to date: the one-shot v18 migration first,
// before WAL is switched on, then the per-open steps.
function initConnection(db, path, env) {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  const state = schemaState(db);
  if (state === "legacy") migrateToV18(db, env);
  enableWal(db, path);
  createSchema(db);
  if (state === "fresh") createRegistry(db, env);
  migrateOrExplain(db);
  db.exec("PRAGMA foreign_keys = ON");
  finishV18(db, env);
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
// `file is not a database` (`nightqueue doctor`, checks `db shm` and `home mount`).
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

// Opens the database of this NIGHTQUEUE_HOME, creating and migrating it on first use.
export function openDb(env = process.env) {
  const path = dbPath(env);
  const cached = connections.get(path);
  if (cached) return cached;
  ensureHome(env);
  const db = new DatabaseSync(path);
  try {
    withWriteRetry(() => initConnection(db, path, env));
  } catch (err) {
    db.close();
    throw err;
  }
  connections.set(path, db);
  installExitHook();
  pinWal(env, path);
  return db;
}

// Opens the database read-only and outside the connection cache, for a caller that must never create or migrate it.
export function openDbReadOnly(env = process.env) {
  const db = new DatabaseSync(dbPath(env), { readOnly: true });
  db.exec("PRAGMA foreign_keys = ON");
  return db;
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
    if (err instanceof MigrationRefused) throw err;
    const detail = err instanceof UserError ? err.message : (err?.message ?? String(err));
    throw new UserError(
      `the memory database at ${path} is at schema v${version} and this build needs v${DB_USER_VERSION}, but it could not be migrated: ${detail}; make the database writable and run \`nightqueue queue status\` again`,
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
