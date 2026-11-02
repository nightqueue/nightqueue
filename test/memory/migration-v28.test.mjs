import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dbPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { MigrationRefused } from "../../src/memory/migration/one-shot.mjs";
import { isPendingV28 } from "../../src/memory/migration/v28.mjs";
import { ensureProject, makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";

const { DatabaseSync } = await import("node:sqlite");

// Runs a use of a raw connection to a database file, closed right after.
function withRaw(file, use, { readOnly = false } = {}) {
  const raw = new DatabaseSync(file, { readOnly });
  try {
    return use(raw);
  } finally {
    raw.close();
  }
}

// The schema version of a database file.
function fileVersion(file) {
  return withRaw(file, (raw) => raw.prepare("PRAGMA user_version").get().user_version, { readOnly: true });
}

// Whether a database file's jobs table has the pipeline column.
function hasPipeline(file) {
  return withRaw(file, (raw) => raw.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "pipeline"), { readOnly: true });
}

// A home holding two jobs, stamped at an older version whose `jobs` has no pipeline column yet; `live` leases one of them.
function buildOlderHome(t, name, version = 27, { live = false } = {}) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  const { id } = addJob({ projectId, prompt: "fix the worker" }, env);
  addJob({ projectId, prompt: "fix the parser" }, env);
  if (live) claimJobById(id, { worker: "host:1", cap: null }, env);
  closeDb(env);
  withRaw(dbPath(env), (raw) => {
    raw.exec("ALTER TABLE jobs DROP COLUMN pipeline");
    raw.exec(`PRAGMA user_version = ${version}`);
  });
  return env;
}

test("a v27 home takes the column with `resolve` on every row, and keeps a pre-v28 copy without it", (t) => {
  const env = buildOlderHome(t, "v28-from-v27");

  const db = migrateTestHome(env);

  assert.equal(DB_USER_VERSION, 28);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 28);
  assert.deepEqual(db.prepare("SELECT prompt, pipeline FROM jobs ORDER BY id").all().map((row) => ({ ...row })), [
    { prompt: "fix the worker", pipeline: "resolve" },
    { prompt: "fix the parser", pipeline: "resolve" },
  ]);
  const copy = preVersionBackupPath(env, 28);
  assert.ok(existsSync(copy), "no pre-v28 copy");
  assert.equal(fileVersion(copy), 27, "the pre-v28 copy is not the v27 database");
  assert.equal(hasPipeline(copy), false, "the copy already holds the column");
});

test("a v26 home comes up the chain with both copies and every row", (t) => {
  const env = buildOlderHome(t, "v28-from-v26", 26);

  const db = migrateTestHome(env);

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 28);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE pipeline = 'resolve'").get().n, 2);
  assert.ok(existsSync(preVersionBackupPath(env, 27)), "no pre-v27 copy");
  assert.ok(existsSync(preVersionBackupPath(env, 28)), "no pre-v28 copy");
});

test("a job queued on a migrated or a fresh home runs `resolve`, and a value of NULL is refused by the schema", (t) => {
  const env = makeHome(t, "v28-fresh");
  const db = openDb(env);
  assert.equal(isPendingV28(db), false);
  const { id } = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env);
  assert.equal(db.prepare("SELECT pipeline FROM jobs WHERE id = ?").get(id).pipeline, "resolve");
  assert.throws(() => db.prepare("UPDATE jobs SET pipeline = NULL WHERE id = ?").run(id), /NOT NULL/);
});

test("re-opening a migrated home is a no-op: nothing pending, no second copy needed", (t) => {
  const env = buildOlderHome(t, "v28-reopen");
  migrateTestHome(env);
  closeDb(env);
  const again = openDb(env);
  assert.equal(isPendingV28(again), false);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
});

test("a runner holding a live lease refuses the step: the home stays at v27 with its rows and no copy is published", (t) => {
  const env = buildOlderHome(t, "v28-refused", 27, { live: true });
  const fixture = readFileSync(dbPath(env));

  assert.throws(() => migrateTestHome(env), (err) => err instanceof MigrationRefused && /^the database must migrate to v28, but a runner holds a live lease on J-\d+: /.test(err.message));

  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.equal(existsSync(preVersionBackupPath(env, 28)), false, "a refused migration published a copy");
});

test("a v27 home without the columns of every open takes the column from that same step, after them", (t) => {
  const env = buildOlderHome(t, "v28-chain-order");
  withRaw(dbPath(env), (raw) => raw.exec("ALTER TABLE jobs DROP COLUMN start_worktree"));

  const db = migrateTestHome(env);

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 28);
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
  assert.deepEqual(columns.slice(-2), ["start_worktree", "pipeline"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE pipeline = 'resolve'").get().n, 2);
});
