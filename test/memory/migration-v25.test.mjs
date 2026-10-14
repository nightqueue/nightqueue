import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dbPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb } from "../../src/memory/db.mjs";
import { JOBS_FTS, JOBS_INDEXES } from "../../src/memory/ddl.mjs";
import { searchJobs } from "../../src/memory/job-search.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { MigrationRefused } from "../../src/memory/migration/one-shot.mjs";
import { CLOSED_REQUIRES_MERGE_V24, isPendingV25 } from "../../src/memory/migration/v25.mjs";
import { jobRef } from "../../src/memory/refs.mjs";
import { CLOSED_INVARIANT } from "../../src/memory/schema.mjs";
import { ensureProject, makeHome, seedClosedJob, seedDoneJob } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";

const { DatabaseSync } = await import("node:sqlite");

const NOTICE_WORD = "zebracrossing";
const RESOLVED = JSON.stringify({ attempts: 1, steps: {}, data: { resolvedWithoutChange: true } });
const NOT_RESOLVED = JSON.stringify({ attempts: 1, steps: {}, data: {} });

// Runs a statement batch on a raw connection to the home's database file, closed right after.
function withRaw(env, use) {
  const raw = new DatabaseSync(dbPath(env));
  try {
    return use(raw);
  } finally {
    raw.close();
  }
}

// The stored CREATE of `jobs` as v24 left it: the closed invariant requires a merge, on the table and on `close_worker` as a legacy home added it.
function v24JobsSql(sql) {
  return sql
    .replace(/^CREATE TABLE "?jobs"?/, "CREATE TABLE jobs_v24")
    .replace(CLOSED_INVARIANT, CLOSED_REQUIRES_MERGE_V24)
    .replace("close_worker TEXT", `close_worker TEXT ${CLOSED_REQUIRES_MERGE_V24}`);
}

// Turns a current home back into the v24 shape: `jobs` rebuilt under the v24 invariant, every column and row kept, stamped 24.
function downgradeToV24(env) {
  closeDb(env);
  withRaw(env, (raw) => {
    const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get().sql;
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("BEGIN");
    for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs'").all()) raw.exec(`DROP TRIGGER "${name}"`);
    raw.exec(v24JobsSql(sql));
    raw.exec("INSERT INTO jobs_v24 SELECT * FROM jobs ORDER BY rowid");
    raw.exec("DROP TABLE jobs");
    raw.exec("ALTER TABLE jobs_v24 RENAME TO jobs");
    raw.exec(JOBS_INDEXES);
    raw.exec(JOBS_FTS);
    raw.exec("PRAGMA user_version = 24");
    raw.exec("COMMIT");
  });
}

// A v24 home with a job in every status, a closed merged one, the per-open columns filled and, on demand, a live lease.
function buildV24Home(t, name, { live = false } = {}) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  const ids = {
    pending: addJob({ projectId, prompt: "wait in the queue" }, env).id,
    done: seedDoneJob(env, { prompt: "fix the worker", noticeMd: `the worker ${NOTICE_WORD} is fixed` }),
    closed: seedClosedJob(env, { prompt: "fix the parser" }),
    failed: addJob({ projectId, prompt: "fix the queue" }, env).id,
    noPr: seedDoneJob(env, { prompt: "look at the cdn", prUrl: null, noticeMd: "the cdn is the cause" }),
  };
  const db = openDb(env);
  db.prepare("UPDATE jobs SET status = 'failed', notice_md = 'it broke' WHERE id = ?").run(ids.failed);
  db.prepare("UPDATE jobs SET title = 'operator title', origin = ?, pr_title = 'fix: worker' WHERE id = ?").run('[{"kind":"linear","ref":"ENG-1"}]', ids.done);
  if (live) claimJobById(ids.pending, { worker: "host:1", cap: null }, env);
  downgradeToV24(env);
  return { env, ids, projectId };
}

// Every row of `jobs`, every column, in id order.
function jobRows(env) {
  return withRaw(env, (raw) => raw.prepare("SELECT * FROM jobs ORDER BY id").all().map((row) => ({ ...row })));
}

// The schema version of a database file, read on a raw read-only connection.
function fileVersion(file) {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare("PRAGMA user_version").get().user_version;
  } finally {
    raw.close();
  }
}

// The schema version of the home's database file.
function diskVersion(env) {
  return fileVersion(dbPath(env));
}

// Tries to settle a job as closed by hand with the given checklist, answering whether the closed invariant let it through.
function closesByHand(db, id, close) {
  try {
    db.prepare("UPDATE jobs SET status = 'closed', close = ?, close_status = NULL WHERE id = ?").run(close, id);
    return true;
  } catch (err) {
    if (/CHECK constraint failed/.test(err.message)) return false;
    throw err;
  }
}

test("the v24 fixture really carries the old invariant: a closed job with no pull request is refused even when resolved", (t) => {
  const { env, ids } = buildV24Home(t, "v25-fixture");
  assert.equal(diskVersion(env), 24);
  withRaw(env, (raw) => {
    assert.equal(isPendingV25(raw), true);
    assert.equal(closesByHand(raw, ids.noPr, RESOLVED), false);
  });
});

test("a v24 home migrates to v25: every row and column kept, the job index in step, a pre-v25 copy, and the new invariant", (t) => {
  const { env, ids, projectId } = buildV24Home(t, "v25-migrate");
  const before = jobRows(env);

  const db = migrateTestHome(env);
  assert.equal(DB_USER_VERSION, 25);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 25);
  assert.deepEqual(jobRows(env), before, "the rebuild changed a row or a column");
  assert.ok(existsSync(preVersionBackupPath(env, 25)), "no pre-v25 copy");
  assert.equal(fileVersion(preVersionBackupPath(env, 25)), 24, "the pre-v25 copy is not the v24 database");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(searchJobs({ query: NOTICE_WORD, projectId }, env).map((hit) => hit.ref), [jobRef(ids.done)]);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs' ORDER BY name").all().map((row) => row.name);
  assert.deepEqual(triggers, ["jobs_fts_ad", "jobs_fts_ai", "jobs_fts_au"]);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get().sql;
  assert.match(sql, /resolvedWithoutChange/);
  assert.equal(sql.includes(`close_worker TEXT ${CLOSED_REQUIRES_MERGE_V24}`), false, "the old column constraint survived");

  const next = addJob({ projectId, prompt: "a job after the migration" }, env).id;
  assert.ok(next > Math.max(...before.map((row) => row.id)), "the id sequence went back");
  assert.deepEqual(searchJobs({ query: "migration", projectId }, env).map((hit) => hit.ref), [jobRef(next)], "the index triggers do not follow a new job");
});

test("after v25 a closed job with no pull request needs its resolution, and a closed job with one still needs its merge", (t) => {
  const { env, ids } = buildV24Home(t, "v25-invariant");
  const db = migrateTestHome(env);
  assert.equal(closesByHand(db, ids.noPr, NOT_RESOLVED), false, "a closed job with no pull request and no resolution was accepted");
  assert.equal(closesByHand(db, ids.done, RESOLVED), false, "a closed job with a pull request and no merge was accepted");
  assert.equal(closesByHand(db, ids.noPr, RESOLVED), true, "a closed job resolved without change was refused");
});

test("a runner holding a live lease refuses the v25 migration and nothing is written", (t) => {
  const { env } = buildV24Home(t, "v25-live-lease", { live: true });
  const fixture = readFileSync(dbPath(env));
  assert.throws(
    () => migrateTestHome(env),
    (err) => err instanceof MigrationRefused && /^the database must migrate to v25, but a runner holds a live lease on J-\d+: /.test(err.message),
  );
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.equal(diskVersion(env), 24);
});

test("re-opening a migrated v25 home is a no-op: nothing pending, nothing written", (t) => {
  const { env } = buildV24Home(t, "v25-reopen");
  migrateTestHome(env);
  closeDb(env);
  const again = openDb(env);
  assert.equal(isPendingV25(again), false);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
});

test("a fresh home is created at v25 with the new invariant", (t) => {
  const env = makeHome(t, "v25-fresh");
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 25);
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get().sql, /resolvedWithoutChange/);
});
