import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { StoreUnavailableError, UserError } from "../../src/config/errors.mjs";
import { dbPath, homeDir } from "../../src/config/paths.mjs";
import { closeDb, hasCachedWriteConnection, openDb, requireCurrentSchema, retireConnection } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { projectFromCwd, registeredProject } from "../../src/memory/registry-access.mjs";
import { classifyStoreError } from "../../src/memory/store-error.mjs";
import { withWriteRetry } from "../../src/memory/tx.mjs";
import { openStore, openStoreReadOnly } from "../../src/store/open.mjs";
import { ensureProject, makeDir, makeHome } from "../../test-support/memory.mjs";
import { makeSickHome, makeUnreadableHome, unreadableSkip } from "../../test-support/sick-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

const WHERE = { home: "/tmp/nq-home", path: "/tmp/nq-home/nightqueue.db" };

// A healthy home with one project and the given number of jobs.
function seededHome(t, name, jobs = 2) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  for (let i = 0; i < jobs; i += 1) addJob({ projectId, prompt: `job ${i}` }, env);
  return env;
}

// The error the given action throws, or a failure when it throws nothing.
function thrownBy(action) {
  try {
    action();
  } catch (err) {
    return err;
  }
  assert.fail("the action did not throw");
}

// Asserts the fields every StoreUnavailableError of a fixture-(iii) home carries.
function assertNotADatabase(err, env) {
  assert.ok(err instanceof StoreUnavailableError, `not a StoreUnavailableError: ${err?.stack ?? err}`);
  assert.ok(err instanceof UserError);
  assert.equal(err.code, "SQLITE_NOTADB");
  assert.equal(err.errcode, 26);
  assert.equal(err.home, homeDir(env));
  assert.equal(err.path, dbPath(env));
  assert.equal(err.hint, "nightqueue doctor --fix");
  assert.equal(err.message.includes("\n"), false, "the message is not one line");
  assert.match(err.message, /^the nightqueue database at .+ is unavailable \(SQLITE_NOTADB: file is not a database\); run `nightqueue doctor --fix`$/);
  return true;
}

test("the classifier turns a real NOTADB (main file replaced by text) into SQLITE_NOTADB, reading the integer errcode", (t) => {
  const env = seededHome(t, "classify-notadb", 0);
  makeSickHome(env);
  const raw = thrownBy(() => new DatabaseSync(dbPath(env)).prepare("PRAGMA user_version").get());
  assert.equal(Number.isInteger(raw.errcode), true, "node:sqlite no longer sets an integer errcode");
  assert.equal(raw.errcode, 26);
  const err = classifyStoreError(raw, { home: homeDir(env), path: dbPath(env) });
  assertNotADatabase(err, env);
});

test("the classifier turns a real READONLY (an INSERT on a readOnly connection) into SQLITE_READONLY", (t) => {
  const path = join(makeDir(t, "classify-readonly"), "ro.db");
  const writable = new DatabaseSync(path);
  writable.exec("CREATE TABLE t (x INTEGER)");
  writable.close();
  const reader = new DatabaseSync(path, { readOnly: true });
  t.after(() => reader.close());
  const raw = thrownBy(() => reader.exec("INSERT INTO t VALUES (1)"));
  assert.equal(raw.errcode & 0xff, 8);
  const err = classifyStoreError(raw, WHERE);
  assert.equal(err.code, "SQLITE_READONLY");
  assert.equal(err.home, WHERE.home);
});

test("the classifier maps synthetic errors of the measured node:sqlite shape: 11, 10 and extended codes through the mask", () => {
  const shaped = (errcode, errstr) => Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });
  assert.equal(classifyStoreError(shaped(11, "database disk image is malformed"), WHERE).code, "SQLITE_CORRUPT");
  assert.equal(classifyStoreError(shaped(10, "disk I/O error"), WHERE).code, "SQLITE_IOERR");
  assert.equal(classifyStoreError(shaped(522, "disk I/O error"), WHERE).code, "SQLITE_IOERR");
  assert.equal(classifyStoreError(shaped(1032, "attempt to write a readonly database"), WHERE).code, "SQLITE_READONLY");
  assert.equal(classifyStoreError(shaped(11, "database disk image is malformed"), WHERE).detail, "database disk image is malformed");
});

test("the classifier falls back to the message only for a node:sqlite error without an errcode", () => {
  const sqliteOnly = (message) => Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR" });
  const err = classifyStoreError(sqliteOnly("database disk image is malformed\n    at somewhere"), WHERE);
  assert.equal(err.code, "SQLITE_CORRUPT");
  assert.equal(err.errcode, null);
  assert.equal(err.detail, "database disk image is malformed");
  assert.equal(classifyStoreError(sqliteOnly("disk I/O error"), WHERE).code, "SQLITE_IOERR");
  const trigger = Object.assign(new Error("attempt to write a readonly database"), { errcode: 19 });
  assert.equal(classifyStoreError(trigger, WHERE), null, "a message matched although the errcode says constraint");
});

test("the classifier never reads the message of an error that is not node:sqlite's (user text echoed in an error)", () => {
  assert.equal(classifyStoreError(new Error("x: disk I/O error"), WHERE), null);
  assert.equal(classifyStoreError(new UserError("expected a positive integer job id, got `file is not a database`"), WHERE), null);
});

test("a UserError echoing a sick-database phrase leaves the healthy cached connection in place", async (t) => {
  const env = seededHome(t, "classify-echo", 0);
  openDb(env);
  assert.equal(hasCachedWriteConnection(env), true, "setup: the writable connection is not cached");
  const err = await openStore(env).jobs.getJob("file is not a database").then(
    () => assert.fail("getJob accepted a text id"),
    (rejected) => rejected,
  );
  assert.ok(err instanceof UserError, `not a UserError: ${err?.stack ?? err}`);
  assert.equal(err instanceof StoreUnavailableError, false, `classified as sick: ${err.message}`);
  assert.equal(hasCachedWriteConnection(env), true, "the healthy cached connection was retired");
});

test("the classifier maps synthetic 13 (FULL) and 15 (PROTOCOL) of the measured shape, and their message fallback", () => {
  const shaped = (errcode, errstr) => Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });
  assert.equal(classifyStoreError(shaped(13, "database or disk is full"), WHERE).code, "SQLITE_FULL");
  assert.equal(classifyStoreError(shaped(15, "locking protocol"), WHERE).code, "SQLITE_PROTOCOL");
  const sqliteOnly = (message) => Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR" });
  assert.equal(classifyStoreError(sqliteOnly("database or disk is full"), WHERE).code, "SQLITE_FULL");
  assert.equal(classifyStoreError(sqliteOnly("locking protocol"), WHERE).code, "SQLITE_PROTOCOL");
});

test("a real CANTOPEN (main file chmod 000) is SQLITE_CANTOPEN with errcode 14", { skip: unreadableSkip() }, async (t) => {
  const env = seededHome(t, "classify-cantopen", 1);
  makeUnreadableHome(t, env);
  const raw = thrownBy(() => new DatabaseSync(dbPath(env), { readOnly: true }).prepare("PRAGMA user_version").get());
  assert.equal(raw.errcode & 0xff, 14);
  const err = classifyStoreError(raw, { home: homeDir(env), path: dbPath(env) });
  assert.ok(err instanceof StoreUnavailableError);
  assert.equal(err.code, "SQLITE_CANTOPEN");
  assert.equal(err.errcode, raw.errcode);
  const rejected = await openStoreReadOnly(env).jobs.listJobs({}).then(
    () => assert.fail("the read-only store opened an unreadable file"),
    (e) => e,
  );
  assert.equal(rejected.code, "SQLITE_CANTOPEN");
});

test("a home with no database yet is not sick: CANTOPEN of a missing file stays unclassified", async (t) => {
  const env = makeHome(t, "classify-fresh");
  assert.equal(existsSync(dbPath(env)), false, "setup: the home already has a database");
  const cantopen = Object.assign(new Error("unable to open database file"), { code: "ERR_SQLITE_ERROR", errcode: 14 });
  assert.equal(classifyStoreError(cantopen, { home: homeDir(env), path: dbPath(env) }), null);
  const rejected = await openStoreReadOnly(env).jobs.listJobs({}).then(
    () => null,
    (e) => e,
  );
  assert.equal(rejected instanceof StoreUnavailableError, false, `a fresh home was classified sick: ${rejected?.message}`);
});

test("the classifier leaves BUSY, LOCKED, errcode 1 and ordinary errors alone", () => {
  const shaped = (errcode, errstr) => Object.assign(new Error(errstr), { code: "ERR_SQLITE_ERROR", errcode, errstr });
  assert.equal(classifyStoreError(shaped(5, "database is locked"), WHERE), null);
  assert.equal(classifyStoreError(shaped(6, "database table is locked"), WHERE), null);
  assert.equal(classifyStoreError(shaped(1, "no such table: jobs"), WHERE), null);
  assert.equal(classifyStoreError(shaped(1, "SQL logic error"), WHERE), null);
  assert.equal(classifyStoreError(new Error("something else"), WHERE), null);
  assert.equal(classifyStoreError(null, WHERE), null);
});

test("the classifier returns an error it already classified as is", () => {
  const first = classifyStoreError(Object.assign(new Error("file is not a database"), { code: "ERR_SQLITE_ERROR" }), WHERE);
  assert.equal(classifyStoreError(first, { home: "/else", path: "/else/db" }), first);
});

test("withWriteRetry still retries a busy action and runs a NOTADB action exactly once, unwrapped", () => {
  let busyCalls = 0;
  const value = withWriteRetry(() => {
    busyCalls += 1;
    if (busyCalls < 3) throw Object.assign(new Error("database is locked"), { errcode: 5 });
    return "written";
  });
  assert.deepEqual({ value, busyCalls }, { value: "written", busyCalls: 3 });

  let sickCalls = 0;
  const sick = Object.assign(new Error("file is not a database"), { errcode: 26 });
  const err = thrownBy(() =>
    withWriteRetry(() => {
      sickCalls += 1;
      throw sick;
    }),
  );
  assert.equal(err, sick);
  assert.equal(sickCalls, 1);
});

test("openStore on fixture (iii) rejects with StoreUnavailableError, and the same store answers after restore", async (t) => {
  const env = seededHome(t, "store-notadb");
  const sick = makeSickHome(env);
  const store = openStore(env);
  await assert.rejects(store.jobs.listJobs(), (err) => assertNotADatabase(err, env));
  assert.equal(hasCachedWriteConnection(env), false, "the broken handle was cached");
  sick.restore();
  assert.equal((await store.jobs.listJobs()).length, 2);
});

test("openStoreReadOnly on fixture (iii) rejects with StoreUnavailableError, and the same store answers after restore", async (t) => {
  const env = seededHome(t, "store-ro-notadb");
  const sick = makeSickHome(env);
  const store = openStoreReadOnly(env);
  t.after(() => store.close());
  await assert.rejects(store.jobs.listJobs(), (err) => assertNotADatabase(err, env));
  sick.restore();
  assert.equal((await store.jobs.listJobs()).length, 2);
});

test("health() never throws on fixture (iii) and names the unavailable store", async (t) => {
  const env = seededHome(t, "store-health-notadb");
  makeSickHome(env);
  const health = await openStoreReadOnly(env).health();
  assert.equal(health.schemaVersion, null);
  assert.deepEqual(health.unavailable, {
    code: "SQLITE_NOTADB",
    errcode: 26,
    detail: "file is not a database",
    home: homeDir(env),
    path: dbPath(env),
    hint: "nightqueue doctor --fix",
  });
  await openStoreReadOnly(env).close();
});

test("requireCurrentSchema keeps the class on fixture (iii), in memory and through the store", async (t) => {
  const env = seededHome(t, "migrate-notadb", 0);
  makeSickHome(env);
  assertNotADatabase(thrownBy(() => requireCurrentSchema(env)), env);
  await assert.rejects(openStoreReadOnly(env).requireCurrentSchema(), (err) => assertNotADatabase(err, env));
  await openStoreReadOnly(env).close();
});

test("the registry reads that bypass the store throw the class on fixture (iii)", (t) => {
  const env = seededHome(t, "registry-notadb", 0);
  makeSickHome(env);
  assertNotADatabase(thrownBy(() => registeredProject("alpha", env)), env);
  assertNotADatabase(thrownBy(() => projectFromCwd("/somewhere", env)), env);
});

test("retireConnection takes the cached writable connection out of the cache without closing it", (t) => {
  const env = seededHome(t, "retire", 1);
  const old = openDb(env);
  retireConnection(env);
  assert.equal(hasCachedWriteConnection(env), false);
  assert.equal(old.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1, "the retired handle was closed");
  assert.notEqual(openDb(env), old);
});

test("8 concurrent listJobs on fixture (iii) all reject with the class, and 8 concurrent calls all answer after restore", async (t) => {
  const env = seededHome(t, "store-notadb-concurrent");
  const sick = makeSickHome(env);
  const store = openStore(env);
  const failed = await Promise.allSettled(Array.from({ length: 8 }, () => store.jobs.listJobs()));
  for (const outcome of failed) {
    assert.equal(outcome.status, "rejected");
    assertNotADatabase(outcome.reason, env);
  }
  sick.restore();
  const answered = await Promise.all(Array.from({ length: 8 }, () => store.jobs.listJobs()));
  for (const rows of answered) assert.equal(rows.length, 2);
});

test("a random -shm is survived: SQLite rebuilds the index and every row is still read", async (t) => {
  const env = seededHome(t, "shm-random", 3);
  closeDb(env);
  writeFileSync(`${dbPath(env)}-shm`, randomBytes(32768));
  const rows = await openStore(env).jobs.listJobs();
  assert.equal(rows.length, 3);
});

test("a -wal truncated mid-frame is survived: SQLite reads only the valid frames and throws nothing", async (t) => {
  const source = seededHome(t, "wal-truncated-source", 0);
  const projectId = ensureProject(source, "alpha");
  const held = openDb(source);
  held.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  held.exec("PRAGMA wal_autocheckpoint = 0");
  for (let i = 0; i < 20; i += 1) addJob({ projectId, prompt: `job ${i} ${"x".repeat(2000)}` }, source);
  const target = makeHome(t, "wal-truncated-target");
  mkdirSync(homeDir(target), { recursive: true });
  copyFileSync(dbPath(source), dbPath(target));
  copyFileSync(`${dbPath(source)}-wal`, `${dbPath(target)}-wal`);
  const walSize = statSync(`${dbPath(target)}-wal`).size;
  assert.ok(walSize > 32 + 4 * 4120, `the WAL is too small to cut mid-frame (${walSize} bytes)`);
  truncateSync(`${dbPath(target)}-wal`, walSize - 2000);
  const rows = await openStore(target).jobs.listJobs();
  assert.ok(rows.length < 20, "the truncated frames were not lost");
  assert.equal(existsSync(join(homeDir(target), "nightqueue.db")), true);
});
