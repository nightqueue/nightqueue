import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dbPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { JOBS_FTS, JOBS_INDEXES } from "../../src/memory/ddl.mjs";
import { searchJobs } from "../../src/memory/job-search.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { MigrationRefused } from "../../src/memory/migration/one-shot.mjs";
import { isPendingV27 } from "../../src/memory/migration/v27.mjs";
import { ensureProject, makeHome, seedClosedJob, seedDoneJob } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";
import { buildV18Home } from "../../test-support/v18-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

const NOTICE_WORD = "zebracrossing";

// Runs a use of a raw connection to a database file, closed right after.
function withRaw(file, use, { readOnly = false } = {}) {
  const raw = new DatabaseSync(file, { readOnly });
  try {
    return use(raw);
  } finally {
    raw.close();
  }
}

// Every job row of a database file, every column, in id order.
function jobRows(file) {
  return withRaw(file, (raw) => raw.prepare("SELECT * FROM jobs ORDER BY id").all().map((row) => ({ ...row })), { readOnly: true });
}

// A job row as it reads once the column is gone.
function withoutBudget({ max_attempts: _dropped, ...row }) {
  return row;
}

// The schema version of a database file.
function fileVersion(file) {
  return withRaw(file, (raw) => raw.prepare("PRAGMA user_version").get().user_version, { readOnly: true });
}

// The ids of the jobs of the test project whose indexed text matches a word.
function hitIds(env, query) {
  return searchJobs({ query, projectId: ensureProject(env, "alpha") }, env).map((hit) => hit.id);
}

// Puts the budget column back on `jobs` where a v26 table held it, between `attempts` and `timeout_s`, every row and index kept.
function plantBudgetColumn(raw) {
  const sql = raw.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get().sql;
  const columns = raw.prepare("PRAGMA table_info(jobs)").all().map((column) => `"${column.name}"`).join(", ");
  raw.exec("PRAGMA foreign_keys = OFF");
  for (const { name } of raw.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs'").all()) raw.exec(`DROP TRIGGER "${name}"`);
  raw.exec(sql.replace(/^CREATE TABLE "?jobs"?/, "CREATE TABLE jobs_v26").replace("attempts INTEGER NOT NULL DEFAULT 0,", "attempts INTEGER NOT NULL DEFAULT 0,\n  max_attempts INTEGER NOT NULL DEFAULT 1,"));
  raw.exec(`INSERT INTO jobs_v26 (${columns}) SELECT ${columns} FROM jobs ORDER BY rowid`);
  raw.exec("DROP TABLE jobs");
  raw.exec("ALTER TABLE jobs_v26 RENAME TO jobs");
  raw.exec(JOBS_INDEXES);
  raw.exec(JOBS_FTS);
}

// A home stamped at an older version whose `jobs` carries the budget column filled per row, jobs of several statuses in it, and per-open columns set; `live` leases a job.
function buildBudgetHome(t, name, { version = 26, live = false } = {}) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  const pending = addJob({ projectId, prompt: "wait in the queue" }, env).id;
  const done = seedDoneJob(env, { prompt: "fix the worker", noticeMd: `the worker ${NOTICE_WORD} is fixed` });
  seedClosedJob(env, { prompt: "fix the parser" });
  openDb(env).prepare("UPDATE jobs SET title = 'operator title', origin = ?, pr_title = 'fix: worker' WHERE id = ?").run('[{"kind":"linear","ref":"ENG-1"}]', done);
  if (live) claimJobById(pending, { worker: "host:1", cap: null }, env);
  closeDb(env);
  withRaw(dbPath(env), (raw) => {
    plantBudgetColumn(raw);
    const position = raw.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
    assert.equal(position[position.indexOf("attempts") + 1], "max_attempts", "the fixture lost the v26 column position");
    raw.prepare("UPDATE jobs SET max_attempts = 7 WHERE id = ?").run(done);
    raw.exec(`PRAGMA user_version = ${version}`);
  });
  return { env, done };
}

for (const version of [24, 25, 26]) {
  test(`a v${version} home reaches v27 with the column gone, every job kept and indexed, and a pre-v27 copy holding the column`, (t) => {
    const { env, done } = buildBudgetHome(t, `v27-from-v${version}`, { version });
    const before = jobRows(dbPath(env));

    const db = migrateTestHome(env);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 27);
    assert.equal(db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "max_attempts"), false);
    assert.deepEqual(jobRows(dbPath(env)), before.map(withoutBudget), "a job changed");
    assert.deepEqual(hitIds(env, NOTICE_WORD), [done], "the job index lost its row");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

    const copy = preVersionBackupPath(env, 27);
    assert.ok(existsSync(copy), "no pre-v27 copy");
    assert.equal(fileVersion(copy), 26, "the pre-v27 copy is not the v26 database");
    assert.equal(jobRows(copy).find((row) => row.id === done).max_attempts, 7, "the copy lost the column");
  });
}

test("a job can be queued, claimed and updated by its index triggers after the drop", (t) => {
  const { env, done } = buildBudgetHome(t, "v27-after-drop");
  const db = migrateTestHome(env);
  const added = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the queue" }, env).id;
  claimJobById(added, { worker: "host:1", cap: null }, env);
  assert.equal(db.prepare("SELECT status FROM jobs WHERE id = ?").get(added).status, "running");
  db.prepare("UPDATE jobs SET notice_md = 'a quagganword notice' WHERE id = ?").run(done);
  assert.deepEqual(hitIds(env, "quagganword"), [done]);
});

test("a v26 home whose job index drifted is healed by the step instead of refusing for good", (t) => {
  const { env, done } = buildBudgetHome(t, "v27-drifted-index");
  withRaw(dbPath(env), (raw) => raw.prepare("DELETE FROM jobs_fts WHERE rowid = ?").run(done));

  migrateTestHome(env);

  assert.deepEqual(hitIds(env, NOTICE_WORD), [done]);
});

test("a home that lost the column at v18 still takes the step: stamped, its jobs kept, a pre-v27 copy beside it", (t) => {
  const env = makeHome(t, "v27-from-v18");
  buildV18Home(env);
  const jobsBefore = jobRows(dbPath(env)).length;
  assert.ok(jobsBefore > 0, "the fixture has no job");
  assert.equal(Object.hasOwn(jobRows(dbPath(env))[0], "max_attempts"), false, "the v18 step kept the column");

  const db = migrateTestHome(env);

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 27);
  assert.equal(jobRows(dbPath(env)).length, jobsBefore);
  assert.ok(existsSync(preVersionBackupPath(env, 27)), "no pre-v27 copy");
});

test("a fresh home is created at the current version with no budget column and nothing pending", (t) => {
  const env = makeHome(t, "v27-fresh");
  const db = openDb(env);
  assert.equal(DB_USER_VERSION, 27);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 27);
  assert.equal(isPendingV27(db), false);
  assert.equal(db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "max_attempts"), false);
});

test("re-opening a migrated home is a no-op: nothing pending, nothing written", (t) => {
  const { env } = buildBudgetHome(t, "v27-reopen");
  migrateTestHome(env);
  closeDb(env);
  const again = openDb(env);
  assert.equal(isPendingV27(again), false);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
});

test("a runner holding a live lease refuses the migration and nothing is written", (t) => {
  const { env } = buildBudgetHome(t, "v27-live-lease", { live: true });
  const fixture = readFileSync(dbPath(env));
  assert.throws(
    () => migrateTestHome(env),
    (err) => err instanceof MigrationRefused && /^the database must migrate to v27, but a runner holds a live lease on J-\d+: /.test(err.message),
  );
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.equal(existsSync(preVersionBackupPath(env, 27)), false, "a refused migration published a copy");
});

test("a read-only open of a v26 home refuses with the update message and writes nothing", (t) => {
  const { env } = buildBudgetHome(t, "v27-read-only");
  const fixture = readFileSync(dbPath(env));
  assert.throws(() => openDbReadOnly(env), (err) => err.code === "SCHEMA_OUTDATED" && /database at v26, this nightqueue expects v27/.test(err.message));
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a read-only open wrote to the database");
});

const REFUSED_DROPS = [
  { kind: "index", sql: "CREATE INDEX jobs_budget_idx ON jobs(max_attempts)" },
  { kind: "trigger", sql: "CREATE TRIGGER jobs_budget_guard AFTER UPDATE ON jobs BEGIN SELECT NEW.max_attempts; END" },
];

for (const { kind, sql } of REFUSED_DROPS) {
  test(`SQLite refuses the drop over the ${kind} reading the column: its reason is shown and the whole step rolls back: still v26, the column and every job there`, (t) => {
    const { env } = buildBudgetHome(t, `v27-refused-${kind}`);
    withRaw(dbPath(env), (raw) => raw.exec(sql));
    const before = jobRows(dbPath(env));

    assert.throws(() => migrateTestHome(env), /migration to v27 failed at column: .*max_attempts.*; nothing was written, the database is still at v26/);

    assert.equal(fileVersion(dbPath(env)), 26);
    assert.deepEqual(jobRows(dbPath(env)), before);
  });
}
