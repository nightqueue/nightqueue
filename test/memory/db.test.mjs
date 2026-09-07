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
];

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
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 2);
  assert.deepEqual(columnsOf(first, "lessons"), LESSON_COLUMNS);
  closeDb(env);

  const second = openDb(env);
  assert.notEqual(second, first);
  assert.equal(second.prepare("PRAGMA user_version").get().user_version, 2);
  assert.deepEqual(columnsOf(second, "lessons"), LESSON_COLUMNS);
  assert.equal(second.prepare("SELECT title FROM lessons WHERE id = ?").get(id).title, "the migration keeps the rows");
  assert.deepEqual(matchIds(second, "lessons_fts", '"migration"'), [id]);
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
