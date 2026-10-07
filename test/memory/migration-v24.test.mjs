import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dbPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, migrateHomeDatabase, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { searchJobs } from "../../src/memory/job-search.mjs";
import { getJob, listJobs } from "../../src/memory/jobs.mjs";
import { MigrationRefused } from "../../src/memory/migration/one-shot.mjs";
import { isPendingV24 } from "../../src/memory/migration/v24.mjs";
import { jobRef } from "../../src/memory/refs.mjs";
import { jobTitle } from "../../src/queue/job-title.mjs";
import { openStoreReadOnly } from "../../src/store/open.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";
import { buildV23Home, V23_DONE_PROMPT, V23_NOTICE_WORD } from "../../test-support/v23-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

const JOB_INDEX_TRIGGERS = ["jobs_fts_ad", "jobs_fts_ai", "jobs_fts_au"];

// Runs a read on a raw read-only connection to a database file.
function readRaw(file, read) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

// The schema objects of the tracker left in a database.
function trackerObjects(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'issue%' OR tbl_name LIKE 'issue%'").all().map((row) => row.name);
}

// The tables and triggers of a database by type and name, the comparison of a fresh home and a migrated one.
function tablesAndTriggers(db) {
  return db
    .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map((row) => `${row.type} ${row.name}`);
}

// The triggers that keep the job index in step with `jobs`.
function jobIndexTriggers(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs' AND name LIKE 'jobs_fts_%' ORDER BY name").all().map((row) => row.name);
}

// The row count of a table.
function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

// The id, ref and title of every job as the read paths answer them.
function jobIdentities(env) {
  return listJobs({}, env)
    .map((row) => ({ id: row.id, ref: jobRef(row.id), title: jobTitle(row) }))
    .sort((a, b) => a.id - b.id);
}

// The schema version of the database on disk, read without migrating it.
function diskVersion(env) {
  const db = openDbReadOnly(env, { anySchema: true });
  try {
    return schemaVersionOn(db);
  } finally {
    db.close();
  }
}

test("the schema is v24", () => {
  assert.equal(DB_USER_VERSION, 24);
});

test("a v23 home with issues, comments and an org item migrates to v24: the tracker gone, every job kept and indexed, a pre-v24 copy", (t) => {
  const env = makeHome(t, "v24-migrate");
  const { jobs, projectId } = buildV23Home(env);
  const before = readRaw(dbPath(env), (raw) => ({
    jobs: raw.prepare("SELECT id, prompt FROM jobs ORDER BY id").all().map((row) => ({ id: row.id, ref: jobRef(row.id), title: jobTitle(row) })),
    issues: countOf(raw, "issues"),
  }));
  assert.equal(before.issues, 2);

  const result = migrateHomeDatabase(env, { backupPath: preVersionBackupPath(env, 24) });
  assert.deepEqual(result, { migrated: true, from: 23, to: 24, backup: preVersionBackupPath(env, 24) });
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 24);
  assert.deepEqual(trackerObjects(db), []);
  assert.equal(countOf(db, "jobs_fts"), 3);
  assert.deepEqual(jobIndexTriggers(db), JOB_INDEX_TRIGGERS);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

  assert.deepEqual(jobIdentities(env), before.jobs);
  assert.equal(jobTitle(getJob(jobs.done, env)), V23_DONE_PROMPT);
  assert.deepEqual(searchJobs({ query: V23_NOTICE_WORD, projectId }, env).map((hit) => hit.ref), [jobRef(jobs.done)]);

  const copy = readRaw(preVersionBackupPath(env, 24), (raw) => ({
    version: schemaVersionOn(raw),
    issues: countOf(raw, "issues"),
    comments: countOf(raw, "issue_comments"),
    projects: countOf(raw, "issue_projects"),
  }));
  assert.deepEqual(copy, { version: 23, issues: 2, comments: 2, projects: 1 });
});

test("a runner holding a live lease refuses the v24 migration: still v23 with its issues, and the step publishes no copy", (t) => {
  const env = makeHome(t, "v24-live-lease");
  buildV23Home(env, { live: true });
  const fixture = readFileSync(dbPath(env));
  assert.throws(
    () => migrateTestHome(env),
    (err) => err instanceof MigrationRefused && /^the database must migrate to v24, but a runner holds a live lease on J-\d+: /.test(err.message),
  );
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.equal(diskVersion(env), 23);
  assert.equal(readRaw(dbPath(env), (raw) => countOf(raw, "issues")), 2);
  assert.equal(existsSync(preVersionBackupPath(env, 24)), false, "a refused step published a pre-v24 copy");
  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED");
});

test("a read-only open of a v23 home is refused as outdated before any query reaches the job index or the tracker", async (t) => {
  const env = makeHome(t, "v24-read-only");
  buildV23Home(env);
  assert.throws(() => openDbReadOnly(env), (err) => err.code === "SCHEMA_OUTDATED");
  const store = openStoreReadOnly(env);
  try {
    await assert.rejects(store.jobs.listJobs({}), (err) => err.code === "SCHEMA_OUTDATED");
  } finally {
    await store.close();
  }
  assert.equal(diskVersion(env), 23);
});

test("a v22 home takes the v24 step as well, and a v24 home is never pending again", (t) => {
  const env = makeHome(t, "v24-from-v22");
  buildV23Home(env);
  const raw = new DatabaseSync(dbPath(env));
  raw.exec("PRAGMA user_version = 22");
  assert.equal(isPendingV24(raw), true);
  raw.close();
  const db = migrateTestHome(env);
  assert.equal(isPendingV24(db), false);
  assert.deepEqual(trackerObjects(db), []);
  assert.equal(countOf(db, "jobs_fts"), 3);
});

test("re-opening a migrated v24 home is a no-op: nothing pending, the job index unchanged, nothing written", (t) => {
  const env = makeHome(t, "v24-reopen");
  buildV23Home(env);
  const db = migrateTestHome(env);
  const indexed = countOf(db, "jobs_fts");
  closeDb(env);
  const again = openDb(env);
  assert.equal(isPendingV24(again), false);
  assert.equal(countOf(again, "jobs_fts"), indexed);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
});

test("a fresh home is v24 with the job index and no tracker, the same tables and triggers as a migrated home", (t) => {
  const fresh = openDb(makeHome(t, "v24-fresh"));
  assert.equal(fresh.prepare("PRAGMA user_version").get().user_version, 24);
  assert.deepEqual(trackerObjects(fresh), []);
  assert.deepEqual(jobIndexTriggers(fresh), JOB_INDEX_TRIGGERS);
  const env = makeHome(t, "v24-converge");
  buildV23Home(env);
  const migrated = migrateTestHome(env);
  assert.deepEqual(tablesAndTriggers(migrated), tablesAndTriggers(fresh));
});
