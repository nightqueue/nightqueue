import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { dbPath, preV18BackupPath, preV19BackupPath, preV20BackupPath, preV22BackupPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, claimJobById } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { saveMemory } from "../../src/memory/memory.mjs";
import { DECISION_OBJECTS } from "../../src/memory/migration/decisions-shape.mjs";
import { MigrationRefused } from "../../src/memory/migration/one-shot.mjs";
import { isPendingV26 } from "../../src/memory/migration/v26.mjs";
import { plantDecisionsV25 } from "../../test-support/legacy-home.mjs";
import { ensureProject, makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";
import { buildV18Home } from "../../test-support/v18-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

const KEPT_TABLES = ["lessons", "memory", "jobs"];
const DECISION_INDEXES = ["decisions_number_idx", "decisions_org_number_idx", "decisions_job_idx", "decisions_superseded_idx"];
const DECISION_OBJECTS_SQL = "SELECT name FROM sqlite_master WHERE name LIKE 'decisions%' OR tbl_name = 'decisions' ORDER BY name";

// Runs a read or a write on a raw connection to a database file, closed right after.
function withRaw(file, use, { readOnly = false } = {}) {
  const raw = new DatabaseSync(file, { readOnly });
  try {
    return use(raw);
  } finally {
    raw.close();
  }
}

// Every row of every kept table, every column, in id order.
function keptRows(file) {
  return withRaw(
    file,
    (raw) => Object.fromEntries(KEPT_TABLES.map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }))])),
    { readOnly: true },
  );
}

// The schema version of a database file.
function fileVersion(file) {
  return withRaw(file, (raw) => raw.prepare("PRAGMA user_version").get().user_version, { readOnly: true });
}

// The names of the decisions objects of a database file.
function decisionObjects(file) {
  return withRaw(file, (raw) => raw.prepare(DECISION_OBJECTS_SQL).all().map((row) => row.name), { readOnly: true });
}

// Inserts decisions of a project, of its org and of the global owner, one superseded by another and one proposed by a job.
function seedDecisions(raw, { projectId, orgId, jobId }) {
  const insert = raw.prepare("INSERT INTO decisions (scope, project_id, org_id, number, title, context, decision, status, job_id) VALUES (?, ?, ?, ?, ?, 'c', 'd', ?, ?)");
  const first = Number(insert.run("project", projectId, null, 1, "the runner owns its lease", "superseded", null).lastInsertRowid);
  const second = Number(insert.run("project", projectId, null, 2, "the runner renews its lease", "accepted", null).lastInsertRowid);
  insert.run("org", null, orgId, 1, "one queue per product", "accepted", null);
  insert.run("project", null, null, 1, "everything is UTC", "proposed", jobId);
  raw.prepare("UPDATE decisions SET superseded_by = ? WHERE id = ?").run(second, first);
}

// A v25 home with lessons, a memory, two jobs and, unless `decisions` is false, the v25 decisions with a row of every owner; `live` leases a job.
function buildV25Home(t, name, { live = false, decisions = true } = {}) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  saveLesson({ projectId, title: "the zebralesson leaks a descriptor", root_cause: "r", solution: "s", prevention: "p" }, env);
  saveLesson({ projectId: null, title: "a global lesson", root_cause: "r", solution: "s", prevention: "p" }, env);
  saveMemory({ projectId, key: "deploy", value: "the zebramemory pipeline deploys" }, env);
  const jobId = addJob({ projectId, prompt: "propose a decision" }, env).id;
  const pending = addJob({ projectId, prompt: "wait in the queue" }, env).id;
  if (live) claimJobById(pending, { worker: "host:1", cap: null }, env);
  const orgId = openDb(env).prepare("SELECT org_id FROM projects WHERE id = ?").get(projectId).org_id;
  closeDb(env);
  withRaw(dbPath(env), (raw) => {
    if (decisions) {
      plantDecisionsV25(raw);
      seedDecisions(raw, { projectId, orgId, jobId });
    }
    raw.exec("PRAGMA user_version = 25");
  });
  return { env, projectId };
}

// Matches a word in a lexical mirror of the database.
function matches(db, mirror, word) {
  return db.prepare(`SELECT rowid FROM ${mirror} WHERE ${mirror} MATCH ?`).all(word).length;
}

test("the v25 fixture really carries every decisions object, rows of every owner, and is pending v26", (t) => {
  const { env } = buildV25Home(t, "v26-fixture");
  assert.equal(fileVersion(dbPath(env)), 25);
  const objects = decisionObjects(dbPath(env));
  for (const name of [...DECISION_OBJECTS, ...DECISION_INDEXES]) assert.ok(objects.includes(name), `the fixture lacks ${name}`);
  withRaw(dbPath(env), (raw) => {
    assert.equal(isPendingV26(raw), true);
    assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 4);
  }, { readOnly: true });
});

test("a v25 home migrates to v26: every decisions object and row gone, lessons, memories and jobs identical, a pre-v26 copy holding the decisions", (t) => {
  const { env } = buildV25Home(t, "v26-migrate");
  const before = keptRows(dbPath(env));

  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
  assert.equal(DB_USER_VERSION, 26);
  assert.deepEqual(db.prepare(DECISION_OBJECTS_SQL).all(), []);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_sequence WHERE name = 'decisions'").get().n, 0, "the decisions counter survived");
  assert.deepEqual(keptRows(dbPath(env)), before, "a lesson, memory or job changed");
  assert.equal(matches(db, "lessons_fts", "zebralesson"), 1, "the lesson mirror lost its row");
  assert.equal(matches(db, "memory_fts", "zebramemory"), 1, "the memory mirror lost its row");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

  const copy = preVersionBackupPath(env, 26);
  assert.ok(existsSync(copy), "no pre-v26 copy");
  assert.equal(fileVersion(copy), 25, "the pre-v26 copy is not the v25 database");
  assert.equal(withRaw(copy, (raw) => raw.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, { readOnly: true }), 4);
});

test("a fresh home is created at v26 with no decisions object", (t) => {
  const env = makeHome(t, "v26-fresh");
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.equal(isPendingV26(db), false);
  assert.deepEqual(db.prepare(DECISION_OBJECTS_SQL).all(), []);
});

test("re-opening a migrated v26 home is a no-op: nothing pending, nothing written", (t) => {
  const { env } = buildV25Home(t, "v26-reopen");
  migrateTestHome(env);
  closeDb(env);
  const again = openDb(env);
  assert.equal(isPendingV26(again), false);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
});

test("a runner holding a live lease refuses the v26 migration and nothing is written", (t) => {
  const { env } = buildV25Home(t, "v26-live-lease", { live: true });
  const fixture = readFileSync(dbPath(env));
  assert.throws(
    () => migrateTestHome(env),
    (err) => err instanceof MigrationRefused && /^the database must migrate to v26, but a runner holds a live lease on J-\d+: /.test(err.message),
  );
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.equal(fileVersion(dbPath(env)), 25);
  assert.equal(existsSync(preVersionBackupPath(env, 26)), false, "a refused migration published a copy");
});

test("a read-only open of a v25 home refuses with the update message and writes nothing, and reads the lessons once it is migrated", (t) => {
  const { env } = buildV25Home(t, "v26-read-only");
  const fixture = readFileSync(dbPath(env));
  assert.throws(() => openDbReadOnly(env), (err) => err.code === "SCHEMA_OUTDATED" && /database at v25, this nightqueue expects v26/.test(err.message));
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a read-only open wrote to the database");

  migrateTestHome(env);
  closeDb(env);
  const reader = openDbReadOnly(env);
  t.after(() => reader.close());
  assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM lessons").get().n, 2);
});

test("a v25 home that never had the decisions table still migrates to v26", (t) => {
  const { env } = buildV25Home(t, "v26-no-decisions", { decisions: false });
  const before = keptRows(dbPath(env));
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
  assert.deepEqual(keptRows(dbPath(env)), before);
});

test("a v23 home with no decisions table migrates through v24, v25 and v26 without error", (t) => {
  const { env } = buildV25Home(t, "v26-from-v23", { decisions: false });
  withRaw(dbPath(env), (raw) => raw.exec("PRAGMA user_version = 23"));
  const before = keptRows(dbPath(env));
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
  assert.deepEqual(keptRows(dbPath(env)), before);
  for (const version of [24, 25, 26]) assert.ok(existsSync(preVersionBackupPath(env, version)), `no pre-v${version} copy`);
});

test("a v18 home carrying decisions migrates through the whole chain to v26: the decisions gone, every other row kept, a copy of every step", (t) => {
  const env = makeHome(t, "v26-from-v18");
  buildV18Home(env);
  const counts = (file) =>
    withRaw(file, (raw) => Object.fromEntries(KEPT_TABLES.map((table) => [table, raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n])), { readOnly: true });
  const before = counts(dbPath(env));
  assert.equal(withRaw(dbPath(env), (raw) => raw.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, { readOnly: true }), 4);

  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
  assert.deepEqual(db.prepare(DECISION_OBJECTS_SQL).all(), []);
  assert.deepEqual(counts(dbPath(env)), before, "a lesson, memory or job was lost on the way");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  for (const copy of [preV18BackupPath(env), preV19BackupPath(env), preV20BackupPath(env), preV22BackupPath(env), ...[24, 25, 26].map((version) => preVersionBackupPath(env, version))]) {
    assert.ok(existsSync(copy), `no copy at ${copy}`);
  }
  assert.equal(withRaw(preVersionBackupPath(env, 26), (raw) => raw.prepare("SELECT COUNT(*) AS n FROM decisions").get().n, { readOnly: true }), 4);
});
