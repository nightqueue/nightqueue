import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SchemaOutdatedError, StoreUnavailableError } from "../../src/config/errors.mjs";
import { dbPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import {
  closeDb,
  DB_USER_VERSION,
  diskSchema,
  migrateHomeDatabase,
  openDb,
  openDbReadOnly,
  requireCurrentSchema,
} from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { openRegistryReader, openStore, openStoreReadOnly } from "../../src/store/open.mjs";
import { restorePreV22Names } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const DB_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;
const MESSAGE = /^database at v20, this nightqueue expects v22: run `nightqueue update` \(.+nightqueue\.db\); when the installed nightqueue is already current, a second `nightqueue update` finishes the migration$/;

// A home stamped v20 with the project `alpha`, one job and the tracker under its pre-v22 names, closed so the file alone is the whole database.
function v20Home(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  addJob({ projectId: projectIdOf(env, "alpha"), prompt: "fix the worker" }, env);
  const db = openDb(env);
  db.exec("ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE projects DROP COLUMN integrations");
  restorePreV22Names(db);
  db.exec("PRAGMA user_version = 20");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDb(env);
  for (const sidecar of ["-wal", "-shm"]) rmSync(`${dbPath(env)}${sidecar}`, { force: true });
  return env;
}

// The main file's bytes and each sidecar's bytes (null when absent).
function snapshot(env) {
  const path = dbPath(env);
  const read = (file) => (existsSync(file) ? readFileSync(file) : null);
  return { main: read(path), wal: read(`${path}-wal`), shm: read(`${path}-shm`) };
}

// Asserts two snapshots are byte for byte the same, sidecars included.
function assertSameBytes(after, before, label) {
  for (const part of ["main", "wal", "shm"]) {
    if (before[part] === null) assert.ok(after[part] === null, `${label}: the ${part} file appeared`);
    else assert.ok(after[part]?.equals(before[part]), `${label}: the ${part} file changed`);
  }
}

// Asserts a failure is the refusal of an older database, naming both versions and `nightqueue update`.
function isOutdatedRefusal(err) {
  assert.ok(err instanceof SchemaOutdatedError, `expected a SchemaOutdatedError, got ${err?.stack ?? err}`);
  assert.ok(err instanceof StoreUnavailableError);
  assert.equal(err.code, "SCHEMA_OUTDATED");
  assert.equal(err.hint, "nightqueue update");
  assert.match(err.message, MESSAGE);
  return true;
}

test("every open of a v20 home refuses with the update message and writes zero bytes, sidecars included", async (t) => {
  const env = v20Home(t, "outdated-refusal");
  const before = snapshot(env);
  assert.ok(before.wal === null && before.shm === null, "the fixture kept its sidecars");

  assert.throws(() => openDb(env), isOutdatedRefusal);
  assert.throws(() => openDbReadOnly(env), isOutdatedRefusal);
  assert.throws(() => requireCurrentSchema(env), isOutdatedRefusal);
  await assert.rejects(openRegistryReader(env), isOutdatedRefusal);
  await assert.rejects(openStoreReadOnly(env).jobs.getJob(1), isOutdatedRefusal);
  await assert.rejects(openStore(env).jobs.getJob(1), isOutdatedRefusal);

  assertSameBytes(snapshot(env), before, "a refused open");
});

test("the header probe reads the version a write-ahead log not yet folded in carries", (t) => {
  const env = makeHome(t, "outdated-wal-probe");
  makeProject(t, env, "alpha");
  assert.ok(readFileSync(`${dbPath(env)}-wal`).length > 0, "the fixture has no pending log");
  assert.equal(diskSchema(env).version, DB_USER_VERSION);
  requireCurrentSchema(env);
});

test("a missing database is still created on open, and a fresh empty file is not refused", (t) => {
  const env = makeHome(t, "outdated-fresh");
  assert.deepEqual(diskSchema(env), { exists: false, version: null, fresh: false, unknown: false });
  requireCurrentSchema(env);
  mkdirSync(dirname(dbPath(env)), { recursive: true });
  writeFileSync(dbPath(env), "");
  assert.equal(diskSchema(env).fresh, true);
  assert.equal(openDb(env).prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
});

// Writes a version-0 database file holding one `jobs` table, with `rows` rows in it.
function writeV0File(env, rows) {
  mkdirSync(dirname(dbPath(env)), { recursive: true });
  const raw = new DatabaseSync(dbPath(env));
  raw.exec("CREATE TABLE jobs (id INTEGER PRIMARY KEY, prompt TEXT)");
  for (let i = 0; i < rows; i += 1) raw.prepare("INSERT INTO jobs (prompt) VALUES (?)").run(`legacy ${i}`);
  raw.close();
}

test("a version-0 file that already holds data is an unstamped legacy home and is refused; one with empty tables is still being created", (t) => {
  const legacy = makeHome(t, "outdated-v0-data");
  writeV0File(legacy, 1);
  const before = snapshot(legacy);
  assert.equal(diskSchema(legacy).fresh, false);
  assert.throws(() => openDb(legacy), (err) => err instanceof SchemaOutdatedError && err.fileVersion === 0);
  assert.throws(() => requireCurrentSchema(legacy), SchemaOutdatedError);
  assertSameBytes(snapshot(legacy), before, "a refused v0 open");

  const creating = makeHome(t, "outdated-v0-empty");
  writeV0File(creating, 0);
  assert.equal(diskSchema(creating).fresh, true);
  requireCurrentSchema(creating);
});

test("a newer database is still refused with the newer-schema message, by the open and by requireCurrentSchema", (t) => {
  const env = makeHome(t, "outdated-newer");
  openDb(env).exec(`PRAGMA user_version = ${DB_USER_VERSION + 1}`);
  closeDb(env);
  for (const open of [() => openDb(env), () => requireCurrentSchema(env)]) {
    assert.throws(open, (err) => !(err instanceof SchemaOutdatedError) && /newer than this nightqueue/.test(err.message));
  }
});

test("migrateHomeDatabase copies the v20 file before it migrates, and the copy is the v20 database", (t) => {
  const env = v20Home(t, "outdated-migrate");
  const backupPath = preVersionBackupPath(env, DB_USER_VERSION);

  const result = migrateHomeDatabase(env, { backupPath });

  assert.deepEqual(result, { migrated: true, from: 20, to: DB_USER_VERSION, backup: backupPath });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  t.after(() => backup.close());
  assert.equal(backup.prepare("PRAGMA user_version").get().user_version, 20);
  assert.equal(backup.prepare("SELECT prompt FROM jobs").get().prompt, "fix the worker");
  assert.equal(openDb(env).prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.deepEqual(migrateHomeDatabase(env, { backupPath: `${backupPath}.again` }), { migrated: false, version: DB_USER_VERSION });
  assert.equal(existsSync(`${backupPath}.again`), false, "a current home took another backup");
});

test("migrateHomeDatabase never overwrites a backup already there", (t) => {
  const env = v20Home(t, "outdated-backup-kept");
  const backupPath = preVersionBackupPath(env, DB_USER_VERSION);
  writeFileSync(backupPath, "an earlier backup");
  assert.throws(() => migrateHomeDatabase(env, { backupPath }), /already exists; nothing was written/);
  assert.equal(readFileSync(backupPath, "utf8"), "an earlier backup");
  assert.equal(diskSchema(env).version, 20);
});

// Source of a process that opens the home the way any command does, reads one row, and exits.
function openerSource() {
  return [
    `import { openDb } from ${JSON.stringify(DB_URL)};`,
    "const db = openDb(process.env);",
    'process.stdout.write(String(db.prepare("PRAGMA user_version").get().user_version));',
    "",
  ].join("\n");
}

test("on a freshly migrated home the per-open steps write nothing: a second open leaves the file and its sidecars byte-identical", (t) => {
  const env = v20Home(t, "outdated-steady-state");
  migrateHomeDatabase(env, { backupPath: preVersionBackupPath(env, DB_USER_VERSION) });
  closeDb(env);
  const script = join(makeDir(t, "outdated-steady-script"), "opener.mjs");
  writeFileSync(script, openerSource());
  const open = () => spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", script], { env, encoding: "utf8" });

  const first = open();
  assert.equal(first.stdout, String(DB_USER_VERSION), first.stderr);
  const before = snapshot(env);
  const second = open();
  assert.equal(second.stdout, String(DB_USER_VERSION), second.stderr);

  assertSameBytes(snapshot(env), before, "the second open");
});
