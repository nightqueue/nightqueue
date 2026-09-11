import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { blobToVector, closeDb, openDb, resolveProjectName, vectorToBlob } from "../../src/memory/db.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const LESSON_COLUMNS = [
  "id",
  "project",
  "title",
  "root_cause",
  "solution",
  "prevention",
  "attempts",
  "model",
  "created_at",
  "target",
  "archived",
  "archive_reason",
  "injected",
  "last_injected_at",
  "violated",
  "last_violated_at",
  "last_recurred_at",
  "embedding",
  "embedding_model",
];

const DECISION_COLUMNS = [
  "id",
  "project",
  "number",
  "title",
  "context",
  "decision",
  "consequences",
  "status",
  "superseded_by",
  "created_at",
  "updated_at",
  "embedding",
  "embedding_model",
];

const ROADMAP_COLUMNS = [
  "id",
  "project",
  "horizon",
  "title",
  "detail",
  "status",
  "position",
  "decision_id",
  "job_id",
  "created_at",
  "updated_at",
];

// Everything a database written by the previous schema version does NOT have yet.
const DOWNGRADE_TO_V2 = `
DROP TRIGGER decisions_fts_ai;
DROP TRIGGER decisions_fts_ad;
DROP TRIGGER decisions_fts_au;
DROP TABLE decisions_fts;
DROP TABLE decisions;
DROP TABLE roadmap_items;
PRAGMA user_version = 2;
`;

const JOB_COLUMNS = [
  "id",
  "project",
  "prompt",
  "priority",
  "status",
  "attempts",
  "max_attempts",
  "timeout_s",
  "lease_until",
  "worker",
  "session_id",
  "slug",
  "branch",
  "pr_url",
  "notice_md",
  "result",
  "operator_note",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "cache_creation",
  "cost_usd",
  "created_at",
  "started_at",
  "finished_at",
  "merged_at",
  "merge_sha",
  "pr_checked_at",
];

// Everything a database written by the schema version before the merge sweep does NOT have yet.
const DOWNGRADE_TO_V3 = `
ALTER TABLE jobs DROP COLUMN merged_at;
ALTER TABLE jobs DROP COLUMN merge_sha;
ALTER TABLE jobs DROP COLUMN pr_checked_at;
PRAGMA user_version = 3;
`;

// Inserts a lesson through raw SQL, so the test exercises the triggers and nothing else.
function insertLesson(db, { title, root_cause = "root", solution = "solution", prevention = "prevention" }) {
  const result = db
    .prepare("INSERT INTO lessons (title, root_cause, solution, prevention) VALUES (?, ?, ?, ?)")
    .run(title, root_cause, solution, prevention);
  return Number(result.lastInsertRowid);
}

// Rowids of a full text search over one of the FTS mirrors.
function matchIds(db, table, expression) {
  return db.prepare(`SELECT rowid FROM ${table} WHERE ${table} MATCH ?`).all(expression).map((row) => row.rowid);
}

// Column names of a table, in declaration order.
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

test("the migration is idempotent and keeps the data across a reopen", (t) => {
  const env = makeHome(t, "db-migrate");
  const first = openDb(env);
  const id = insertLesson(first, { title: "the migration keeps the rows" });
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 4);
  assert.deepEqual(columnsOf(first, "lessons"), LESSON_COLUMNS);
  closeDb(env);

  const second = openDb(env);
  assert.notEqual(second, first);
  assert.equal(second.prepare("PRAGMA user_version").get().user_version, 4);
  assert.deepEqual(columnsOf(second, "lessons"), LESSON_COLUMNS);
  assert.equal(second.prepare("SELECT title FROM lessons WHERE id = ?").get(id).title, "the migration keeps the rows");
  assert.deepEqual(matchIds(second, "lessons_fts", '"migration"'), [id]);
});

test("the decisions and roadmap tables are created with their columns, defaults and indexes", (t) => {
  const env = makeHome(t, "db-decisions");
  const db = openDb(env);
  assert.deepEqual(columnsOf(db, "decisions"), DECISION_COLUMNS);
  assert.deepEqual(columnsOf(db, "roadmap_items"), ROADMAP_COLUMNS);
  const decisionIndexes = db.prepare("PRAGMA index_list(decisions)").all();
  const unique = decisionIndexes.find((index) => index.name === "decisions_number_idx");
  assert.ok(unique, `number index missing: ${decisionIndexes.map((index) => index.name).join(", ")}`);
  assert.equal(unique.unique, 1);
  const roadmapIndexes = db.prepare("PRAGMA index_list(roadmap_items)").all().map((index) => index.name);
  assert.ok(roadmapIndexes.includes("roadmap_items_order_idx"), `order index missing: ${roadmapIndexes.join(", ")}`);
  assert.ok(roadmapIndexes.includes("roadmap_items_job_idx"), `job index missing: ${roadmapIndexes.join(", ")}`);

  db.prepare("INSERT INTO decisions (project, number, title, context, decision) VALUES (?, 1, ?, ?, ?)").run(
    "alpha",
    "the queue owns the worktree",
    "two runners raced on one worktree",
    "one worktree per job",
  );
  assert.equal(db.prepare("SELECT status FROM decisions").get().status, "accepted");
  assert.throws(
    () => db.prepare("INSERT INTO decisions (project, number, title, context, decision, status) VALUES (?, 2, ?, ?, ?, ?)").run("alpha", "t", "c", "d", "maybe"),
    /CHECK constraint failed/,
  );

  db.prepare("INSERT INTO roadmap_items (project, horizon, title, position) VALUES (?, ?, ?, 1)").run(
    "alpha",
    "now",
    "ship the roadmap",
  );
  assert.equal(db.prepare("SELECT status FROM roadmap_items").get().status, "open");
  assert.throws(
    () => db.prepare("INSERT INTO roadmap_items (project, horizon, title, position) VALUES (?, ?, ?, 1)").run("alpha", "someday", "t"),
    /CHECK constraint failed/,
  );
});

test("the migration from user_version 2 keeps every row and adds the decisions schema", (t) => {
  const env = makeHome(t, "db-migrate-v2");
  const first = openDb(env);
  const lesson = insertLesson(first, { title: "the migration keeps the rows" });
  first.prepare("INSERT INTO jobs (project, prompt) VALUES (?, ?)").run("alpha", "fix the worker");
  first.exec(DOWNGRADE_TO_V2);
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 2);
  closeDb(env);

  for (const pass of [1, 2, 3]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "decisions"), DECISION_COLUMNS);
    assert.deepEqual(columnsOf(db, "roadmap_items"), ROADMAP_COLUMNS);
    assert.equal(db.prepare("SELECT title FROM lessons WHERE id = ?").get(lesson).title, "the migration keeps the rows");
    assert.deepEqual(matchIds(db, "lessons_fts", '"migration"'), [lesson]);
    assert.equal(db.prepare("SELECT prompt FROM jobs").get().prompt, "fix the worker");
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM decisions").get().total, 0);
    closeDb(env);
  }

  const db = openDb(env);
  const result = db
    .prepare("INSERT INTO decisions (project, number, title, context, decision) VALUES (?, 1, ?, ?, ?)")
    .run("alpha", "zebracrossing after the migration", "the mirror was created empty", "mirror it");
  assert.deepEqual(matchIds(db, "decisions_fts", '"zebracrossing"'), [Number(result.lastInsertRowid)]);
});

test("the migration from user_version 3 adds the merge columns once and keeps every job row", (t) => {
  const env = makeHome(t, "db-migrate-v3");
  const first = openDb(env);
  first.prepare("INSERT INTO jobs (project, prompt, status, pr_url) VALUES (?, ?, 'done', ?)").run(
    "alpha",
    "fix the worker",
    "https://github.com/acme/api/pull/42",
  );
  first.exec(DOWNGRADE_TO_V3);
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(columnsOf(first, "jobs").includes("merged_at"), false, "the downgrade kept the merge columns");
  closeDb(env);

  for (const pass of [1, 2, 3]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 4, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    const row = db.prepare("SELECT * FROM jobs").get();
    assert.equal(row.prompt, "fix the worker");
    assert.equal(row.pr_url, "https://github.com/acme/api/pull/42");
    assert.deepEqual({ merged_at: row.merged_at, merge_sha: row.merge_sha, pr_checked_at: row.pr_checked_at }, { merged_at: null, merge_sha: null, pr_checked_at: null });
    closeDb(env);
  }
});

test("the jobs table of the queue is created with its columns, defaults and claim indexes", (t) => {
  const env = makeHome(t, "db-jobs");
  const db = openDb(env);
  assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS);
  const indexes = db.prepare("PRAGMA index_list(jobs)").all().map((index) => index.name);
  assert.ok(indexes.includes("jobs_claim_idx"), `claim index missing: ${indexes.join(", ")}`);
  assert.ok(indexes.includes("jobs_project_slug_idx"), `project index missing: ${indexes.join(", ")}`);
  db.prepare("INSERT INTO jobs (project, prompt) VALUES (?, ?)").run("alpha", "fix the worker");
  const row = db.prepare("SELECT * FROM jobs").get();
  assert.deepEqual(
    { status: row.status, priority: row.priority, attempts: row.attempts, max_attempts: row.max_attempts, timeout_s: row.timeout_s },
    { status: "pending", priority: 5, attempts: 0, max_attempts: 1, timeout_s: 14400 },
  );
  assert.equal(row.worker, null);
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});

test("the connection is opened in WAL with a busy timeout that survives a concurrent writer", (t) => {
  const env = makeHome(t, "db-pragmas");
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
});

test("the lessons FTS trigger mirrors an insert", (t) => {
  const env = makeHome(t, "db-fts-insert");
  const db = openDb(env);
  const id = insertLesson(db, { title: "zebracrossing deadlock in the worker" });
  assert.deepEqual(matchIds(db, "lessons_fts", '"zebracrossing"'), [id]);
  assert.deepEqual(matchIds(db, "lessons_fts", '"deadlock"'), [id]);
});

test("the lessons FTS trigger mirrors an update, dropping the token that only lived in the changed field", (t) => {
  const env = makeHome(t, "db-fts-update");
  const db = openDb(env);
  const id = insertLesson(db, {
    title: "zebracrossing deadlock in the worker",
    root_cause: "two locks taken in opposite order",
    solution: "take the locks in one order",
    prevention: "always take the locks in the same order",
  });
  db.prepare("UPDATE lessons SET title = ? WHERE id = ?").run("monorepo deadlock in the worker", id);
  assert.deepEqual(matchIds(db, "lessons_fts", '"zebracrossing"'), []);
  assert.deepEqual(matchIds(db, "lessons_fts", '"monorepo"'), [id]);
});

test("the lessons FTS trigger mirrors a delete and leaves the index consistent", (t) => {
  const env = makeHome(t, "db-fts-delete");
  const db = openDb(env);
  const id = insertLesson(db, { title: "zebracrossing deadlock in the worker" });
  db.prepare("DELETE FROM lessons WHERE id = ?").run(id);
  assert.deepEqual(matchIds(db, "lessons_fts", '"zebracrossing"'), []);
  assert.deepEqual(matchIds(db, "lessons_fts", '"deadlock"'), []);
  db.exec("INSERT INTO lessons_fts(lessons_fts) VALUES('integrity-check')");
});

test("the memory FTS trigger mirrors insert, update and delete", (t) => {
  const env = makeHome(t, "db-fts-memory");
  const db = openDb(env);
  const result = db
    .prepare("INSERT INTO memory (project, key, value) VALUES (NULL, ?, ?)")
    .run("zebracrossing", "the deployment runs from the pipeline");
  const id = Number(result.lastInsertRowid);
  assert.deepEqual(matchIds(db, "memory_fts", '"zebracrossing"'), [id]);

  db.prepare("UPDATE memory SET key = ? WHERE id = ?").run("monorepo", id);
  assert.deepEqual(matchIds(db, "memory_fts", '"zebracrossing"'), []);
  assert.deepEqual(matchIds(db, "memory_fts", '"monorepo"'), [id]);

  db.prepare("DELETE FROM memory WHERE id = ?").run(id);
  assert.deepEqual(matchIds(db, "memory_fts", '"monorepo"'), []);
  db.exec("INSERT INTO memory_fts(memory_fts) VALUES('integrity-check')");
});

test("a vector survives the round trip through the blob, and a corrupt one is refused", () => {
  const vector = [0.5, -0.25, 0.125, 1];
  assert.deepEqual([...blobToVector(vectorToBlob(vector))], vector);
  assert.deepEqual([...blobToVector(vectorToBlob(Float32Array.from(vector)))], vector);
  assert.throws(() => vectorToBlob([]), /empty vector/);
  assert.throws(() => vectorToBlob([1, NaN]), /non-finite/);
  assert.throws(() => vectorToBlob([1, Infinity]), /non-finite/);
  assert.throws(() => blobToVector(new Uint8Array(3)), /multiple of 4/);
  assert.throws(() => blobToVector("x"), /expected a Uint8Array/);
});

test("a vector stored in the database comes back with the same values", (t) => {
  const env = makeHome(t, "db-vector-row");
  const db = openDb(env);
  const id = insertLesson(db, { title: "the embedding survives sqlite" });
  db.prepare("UPDATE lessons SET embedding = ?, embedding_model = ? WHERE id = ?").run(
    vectorToBlob([1, 0, 0, 0]),
    "fake-embedder@v1",
    id,
  );
  const stored = db.prepare("SELECT embedding FROM lessons WHERE id = ?").get(id).embedding;
  assert.deepEqual([...blobToVector(stored)], [1, 0, 0, 0]);
});

test("a project reference resolves by name, by path inside it, and never guesses", (t) => {
  const env = makeHome(t, "db-project");
  const repo = makeProject(t, env, "alpha");
  const deep = join(repo, "src", "deep");
  mkdirSync(deep, { recursive: true });
  assert.equal(resolveProjectName("alpha", env), "alpha");
  assert.equal(resolveProjectName(repo, env), "alpha");
  assert.equal(resolveProjectName(deep, env), "alpha");
  assert.equal(resolveProjectName("nightshift-unknown-project", env), null);
  assert.equal(resolveProjectName("", env), null);
  assert.equal(resolveProjectName(undefined, env), null);
});
