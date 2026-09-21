import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dbPath } from "../../src/config/paths.mjs";
import {
  DB_USER_VERSION,
  blobToVector,
  closeDb,
  migrateIfOutdated,
  openDb,
  resolveProjectName,
  vectorToBlob,
} from "../../src/memory/db.mjs";
import { listDecisions, saveDecision } from "../../src/memory/decisions.mjs";
import { DOWNGRADE_TO_V5, makeHome, makeProject } from "../../test-support/memory.mjs";

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
  "scope",
  "org",
  "job_id",
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
  "scope",
  "org",
];

// Everything a database written by the previous schema version does NOT have yet.
const DOWNGRADE_TO_V2 = `
DROP TRIGGER decisions_fts_ai;
DROP TRIGGER decisions_fts_ad;
DROP TRIGGER decisions_fts_au;
DROP TABLE decisions_fts;
DROP TABLE decisions;
DROP TABLE roadmap_items;
ALTER TABLE jobs DROP COLUMN tier;
ALTER TABLE pipeline_runs DROP COLUMN tier_operator;
ALTER TABLE pipeline_runs DROP COLUMN tier_raise_reason;
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
  "tier",
  "not_before",
  "blocked_code",
  "last_session_id",
  "last_session_attempt",
  "bash_timeouts",
  "tasks_backgrounded",
  "tasks_killed",
  "baseline_ctx",
  "orch_turns",
  "orch_reads",
  "orch_bash",
  "orch_bash_explore",
  "orch_ctx_last",
];

// Everything a database written by the schema version before the merge sweep does NOT have yet.
const DOWNGRADE_TO_V3 = `
ALTER TABLE jobs DROP COLUMN tier;
ALTER TABLE jobs DROP COLUMN not_before;
ALTER TABLE jobs DROP COLUMN blocked_code;
ALTER TABLE jobs DROP COLUMN last_session_id;
ALTER TABLE jobs DROP COLUMN last_session_attempt;
ALTER TABLE jobs DROP COLUMN bash_timeouts;
ALTER TABLE jobs DROP COLUMN tasks_backgrounded;
ALTER TABLE jobs DROP COLUMN tasks_killed;
ALTER TABLE jobs DROP COLUMN baseline_ctx;
ALTER TABLE jobs DROP COLUMN orch_turns;
ALTER TABLE jobs DROP COLUMN orch_reads;
ALTER TABLE jobs DROP COLUMN orch_bash;
ALTER TABLE jobs DROP COLUMN orch_bash_explore;
ALTER TABLE jobs DROP COLUMN orch_ctx_last;
ALTER TABLE pipeline_runs DROP COLUMN tier_operator;
ALTER TABLE pipeline_runs DROP COLUMN tier_raise_reason;
PRAGMA user_version = 3;
`;

// Everything a database written by the schema version before the operator tier does NOT have yet.
const DOWNGRADE_TO_V4 = `
ALTER TABLE jobs DROP COLUMN tier;
ALTER TABLE jobs DROP COLUMN not_before;
ALTER TABLE jobs DROP COLUMN blocked_code;
ALTER TABLE jobs DROP COLUMN last_session_id;
ALTER TABLE jobs DROP COLUMN last_session_attempt;
ALTER TABLE jobs DROP COLUMN bash_timeouts;
ALTER TABLE jobs DROP COLUMN tasks_backgrounded;
ALTER TABLE jobs DROP COLUMN tasks_killed;
ALTER TABLE jobs DROP COLUMN baseline_ctx;
ALTER TABLE jobs DROP COLUMN orch_turns;
ALTER TABLE jobs DROP COLUMN orch_reads;
ALTER TABLE jobs DROP COLUMN orch_bash;
ALTER TABLE jobs DROP COLUMN orch_bash_explore;
ALTER TABLE jobs DROP COLUMN orch_ctx_last;
ALTER TABLE pipeline_runs DROP COLUMN tier_operator;
ALTER TABLE pipeline_runs DROP COLUMN tier_raise_reason;
PRAGMA user_version = 4;
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
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 14);
  assert.deepEqual(columnsOf(first, "lessons"), LESSON_COLUMNS);
  closeDb(env);

  const second = openDb(env);
  assert.notEqual(second, first);
  assert.equal(second.prepare("PRAGMA user_version").get().user_version, 14);
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
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "decisions"), DECISION_COLUMNS);
    assert.deepEqual(columnsOf(db, "roadmap_items"), ROADMAP_COLUMNS);
    assert.ok(columnsOf(db, "jobs").includes("tier"), `jobs.tier missing on pass ${pass}`);
    assert.ok(columnsOf(db, "pipeline_runs").includes("tier_operator"), `pipeline_runs.tier_operator missing on pass ${pass}`);
    assert.ok(
      columnsOf(db, "pipeline_runs").includes("tier_raise_reason"),
      `pipeline_runs.tier_raise_reason missing on pass ${pass}`,
    );
    assert.equal(db.prepare("SELECT title FROM lessons WHERE id = ?").get(lesson).title, "the migration keeps the rows");
    assert.deepEqual(matchIds(db, "lessons_fts", '"migration"'), [lesson]);
    assert.equal(db.prepare("SELECT prompt FROM jobs").get().prompt, "fix the worker");
    assert.equal(db.prepare("SELECT tier FROM jobs").get().tier, null, `pass ${pass}`);
    assert.equal(db.prepare("SELECT COUNT(*) AS total FROM decisions").get().total, 0);
    closeDb(env);
  }

  const db = openDb(env);
  const result = db
    .prepare("INSERT INTO decisions (project, number, title, context, decision) VALUES (?, 1, ?, ?, ?)")
    .run("alpha", "zebracrossing after the migration", "the mirror was created empty", "mirror it");
  assert.deepEqual(matchIds(db, "decisions_fts", '"zebracrossing"'), [Number(result.lastInsertRowid)]);
});

test("the migration from user_version 3 adds the tier columns once and keeps every job row", (t) => {
  const env = makeHome(t, "db-migrate-v3");
  const first = openDb(env);
  first.prepare("INSERT INTO jobs (project, prompt, status, pr_url) VALUES (?, ?, 'done', ?)").run(
    "alpha",
    "fix the worker",
    "https://github.com/acme/api/pull/42",
  );
  first.exec(DOWNGRADE_TO_V3);
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 3);
  assert.equal(columnsOf(first, "jobs").includes("tier"), false, "the downgrade kept the tier column");
  closeDb(env);

  for (const pass of [1, 2, 3]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    const row = db.prepare("SELECT * FROM jobs").get();
    assert.equal(row.prompt, "fix the worker");
    assert.equal(row.pr_url, "https://github.com/acme/api/pull/42");
    assert.equal(columnsOf(db, "jobs").includes("merged_at"), false, `pass ${pass}: merged_at is back`);
    assert.equal(columnsOf(db, "jobs").includes("merge_sha"), false, `pass ${pass}: merge_sha is back`);
    assert.equal(columnsOf(db, "jobs").includes("pr_checked_at"), false, `pass ${pass}: pr_checked_at is back`);
    closeDb(env);
  }
});

test("a home seeded at v9 with merged_at and merge_sha populated opens at the current schema without them, and a second open is a no-op", (t) => {
  const env = makeHome(t, "db-migrate-v9-drop-merge");
  const first = openDb(env);
  first.exec("ALTER TABLE jobs ADD COLUMN merged_at TEXT");
  first.exec("ALTER TABLE jobs ADD COLUMN merge_sha TEXT");
  const inserted = first
    .prepare("INSERT INTO jobs (project, prompt, status, merged_at, merge_sha) VALUES (?, ?, 'closed', ?, ?)")
    .run("alpha", "ship it", "2026-01-01 00:00:00", "abc123");
  first.exec("PRAGMA user_version = 9");
  closeDb(env);

  const opened = openDb(env);
  assert.equal(opened.prepare("PRAGMA user_version").get().user_version, 14);
  assert.equal(columnsOf(opened, "jobs").includes("merged_at"), false);
  assert.equal(columnsOf(opened, "jobs").includes("merge_sha"), false);
  const row = opened.prepare("SELECT project, prompt, status FROM jobs WHERE id = ?").get(Number(inserted.lastInsertRowid));
  assert.deepEqual({ ...row }, { project: "alpha", prompt: "ship it", status: "closed" });
  closeDb(env);

  const reopened = openDb(env);
  assert.equal(reopened.prepare("PRAGMA user_version").get().user_version, 14);
  assert.equal(columnsOf(reopened, "jobs").includes("merged_at"), false);
  assert.equal(columnsOf(reopened, "jobs").includes("merge_sha"), false);
});

// Status of every job row, oldest first.
function jobStatuses(db) {
  return db.prepare("SELECT status FROM jobs ORDER BY id").all().map((row) => row.status);
}

// Re-creates what a v8 build leaves behind: the pr_checked_at, merged_at and merge_sha columns and a row with the retired `merged` status.
function writeLegacyMergedRow(db) {
  if (!columnsOf(db, "jobs").includes("pr_checked_at")) db.exec("ALTER TABLE jobs ADD COLUMN pr_checked_at TEXT");
  if (!columnsOf(db, "jobs").includes("merged_at")) db.exec("ALTER TABLE jobs ADD COLUMN merged_at TEXT");
  if (!columnsOf(db, "jobs").includes("merge_sha")) db.exec("ALTER TABLE jobs ADD COLUMN merge_sha TEXT");
  const insert = db.prepare(
    "INSERT INTO jobs (project, prompt, status, pr_url, merged_at, merge_sha, pr_checked_at) VALUES ('alpha', 'ship it', 'merged', ?, ?, ?, ?)",
  );
  return Number(insert.run("https://github.com/acme/api/pull/7", "2026-01-01 00:00:00", "abc123", "2026-01-01 00:05:00").lastInsertRowid);
}

test("the migration to v10 turns a merged row into closed, drops pr_checked_at/merged_at/merge_sha, and is idempotent", (t) => {
  const env = makeHome(t, "db-migrate-v9");
  const first = openDb(env);
  const merged = writeLegacyMergedRow(first);
  first.prepare("INSERT INTO jobs (project, prompt, status) VALUES ('alpha', 'delivered', 'done')").run();
  first.exec("PRAGMA user_version = 8");
  closeDb(env);

  for (const pass of [1, 2]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    assert.deepEqual(jobStatuses(db), ["closed", "done"], `pass ${pass}`);
    const row = db.prepare("SELECT pr_url FROM jobs WHERE id = ?").get(merged);
    assert.equal(row.pr_url, "https://github.com/acme/api/pull/7", `pass ${pass}`);
    closeDb(env);
  }

  writeLegacyMergedRow(openDb(env));
  closeDb(env);
  const healed = openDb(env);
  assert.deepEqual(jobStatuses(healed), ["closed", "done", "closed"], "a merged row written back by an old build survived the open");
  assert.equal(columnsOf(healed, "jobs").includes("pr_checked_at"), false, "a pr_checked_at re-added by an old build survived the open");
  assert.equal(columnsOf(healed, "jobs").includes("merged_at"), false, "a merged_at re-added by an old build survived the open");
  assert.equal(columnsOf(healed, "jobs").includes("merge_sha"), false, "a merge_sha re-added by an old build survived the open");
});

test("the migration from user_version 10 adds last_session_id and last_session_attempt once and keeps every job row", (t) => {
  const env = makeHome(t, "db-migrate-v10");
  const first = openDb(env);
  first.prepare("INSERT INTO jobs (project, prompt, session_id) VALUES (?, ?, ?)").run("alpha", "fix the worker", "sess-1");
  first.exec("ALTER TABLE jobs DROP COLUMN last_session_id");
  first.exec("ALTER TABLE jobs DROP COLUMN last_session_attempt");
  first.exec("ALTER TABLE jobs DROP COLUMN bash_timeouts");
  first.exec("ALTER TABLE jobs DROP COLUMN tasks_backgrounded");
  first.exec("ALTER TABLE jobs DROP COLUMN tasks_killed");
  first.exec("ALTER TABLE jobs DROP COLUMN baseline_ctx");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_turns");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_reads");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_bash");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_bash_explore");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_ctx_last");
  first.exec("PRAGMA user_version = 10");
  assert.equal(columnsOf(first, "jobs").includes("last_session_id"), false, "the downgrade kept last_session_id");
  closeDb(env);

  for (const pass of [1, 2]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    const row = db.prepare("SELECT session_id, last_session_id, last_session_attempt FROM jobs").get();
    assert.deepEqual({ ...row }, { session_id: "sess-1", last_session_id: null, last_session_attempt: null }, `pass ${pass}`);
    closeDb(env);
  }
});

test("the migration from user_version 11 adds bash_timeouts, tasks_backgrounded and tasks_killed once and keeps every job row", (t) => {
  const env = makeHome(t, "db-migrate-v11");
  const first = openDb(env);
  first.prepare("INSERT INTO jobs (project, prompt) VALUES (?, ?)").run("alpha", "fix the worker");
  first.exec("ALTER TABLE jobs DROP COLUMN bash_timeouts");
  first.exec("ALTER TABLE jobs DROP COLUMN tasks_backgrounded");
  first.exec("ALTER TABLE jobs DROP COLUMN tasks_killed");
  first.exec("ALTER TABLE jobs DROP COLUMN baseline_ctx");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_turns");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_reads");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_bash");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_bash_explore");
  first.exec("ALTER TABLE jobs DROP COLUMN orch_ctx_last");
  first.exec("PRAGMA user_version = 11");
  assert.equal(columnsOf(first, "jobs").includes("bash_timeouts"), false, "the downgrade kept bash_timeouts");
  closeDb(env);

  for (const pass of [1, 2]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    const row = db.prepare("SELECT prompt, bash_timeouts, tasks_backgrounded, tasks_killed FROM jobs").get();
    assert.deepEqual(
      { ...row },
      { prompt: "fix the worker", bash_timeouts: null, tasks_backgrounded: null, tasks_killed: null },
      `pass ${pass}`,
    );
    closeDb(env);
  }
});

test("the migration from user_version 12 adds baseline_ctx once and keeps every job row", (t) => {
  const env = makeHome(t, "db-migrate-v12");
  const first = openDb(env);
  first.prepare("INSERT INTO jobs (project, prompt) VALUES (?, ?)").run("alpha", "fix the worker");
  first.exec("ALTER TABLE jobs DROP COLUMN baseline_ctx");
  // A real v12 database has none of the v14 orchestrator counters either.
  for (const column of ["orch_turns", "orch_reads", "orch_bash", "orch_bash_explore", "orch_ctx_last"]) {
    first.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  }
  first.exec("PRAGMA user_version = 12");
  assert.equal(columnsOf(first, "jobs").includes("baseline_ctx"), false, "the downgrade kept baseline_ctx");
  closeDb(env);

  for (const pass of [1, 2]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    const row = db.prepare("SELECT prompt, baseline_ctx FROM jobs").get();
    assert.deepEqual({ ...row }, { prompt: "fix the worker", baseline_ctx: null }, `pass ${pass}`);
    closeDb(env);
  }
});

test("the migration from user_version 13 adds the five orchestrator counters once and keeps every job row", (t) => {
  const env = makeHome(t, "db-migrate-v13");
  const first = openDb(env);
  first.prepare("INSERT INTO jobs (project, prompt, bash_timeouts) VALUES (?, ?, ?)").run("alpha", "fix the worker", 2);
  for (const column of ["orch_turns", "orch_reads", "orch_bash", "orch_bash_explore", "orch_ctx_last"]) {
    first.exec(`ALTER TABLE jobs DROP COLUMN ${column}`);
  }
  first.exec("PRAGMA user_version = 13");
  assert.equal(columnsOf(first, "jobs").includes("orch_turns"), false, "the downgrade kept orch_turns");
  closeDb(env);

  for (const pass of [1, 2]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    const row = db.prepare("SELECT prompt, bash_timeouts, orch_turns, orch_reads, orch_bash, orch_bash_explore, orch_ctx_last FROM jobs").get();
    assert.deepEqual(
      { ...row },
      { prompt: "fix the worker", bash_timeouts: 2, orch_turns: null, orch_reads: null, orch_bash: null, orch_bash_explore: null, orch_ctx_last: null },
      `pass ${pass}`,
    );
    closeDb(env);
  }
});

test("migrateIfOutdated names the fix that actually works when the migration itself cannot write", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("running as root: a chmod fence never blocks a write");
    return;
  }
  const env = makeHome(t, "db-migrate-write-refused");
  const first = openDb(env);
  first.exec(DOWNGRADE_TO_V5);
  closeDb(env);
  chmodSync(dbPath(env), 0o444);
  t.after(() => chmodSync(dbPath(env), 0o644));

  assert.throws(() => migrateIfOutdated(env), (err) => {
    assert.match(err.message, /make the database writable and run `nightshift queue status` again/);
    assert.doesNotMatch(err.message, /nightshift doctor/);
    return true;
  });
});

test("the migration from user_version 4 adds the tier columns once and keeps every job row", (t) => {
  const env = makeHome(t, "db-migrate-v4");
  const first = openDb(env);
  first.prepare("INSERT INTO jobs (project, prompt) VALUES (?, ?)").run("alpha", "fix the worker");
  first.exec(DOWNGRADE_TO_V4);
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 4);
  assert.equal(columnsOf(first, "jobs").includes("tier"), false, "the downgrade kept the tier column");
  closeDb(env);

  for (const pass of [1, 2, 3]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.deepEqual(columnsOf(db, "jobs"), JOB_COLUMNS, `pass ${pass}`);
    assert.ok(columnsOf(db, "pipeline_runs").includes("tier_operator"), `pipeline_runs.tier_operator missing on pass ${pass}`);
    assert.ok(
      columnsOf(db, "pipeline_runs").includes("tier_raise_reason"),
      `pipeline_runs.tier_raise_reason missing on pass ${pass}`,
    );
    const row = db.prepare("SELECT * FROM jobs").get();
    assert.equal(row.prompt, "fix the worker");
    assert.equal(row.tier, null, `pass ${pass}`);
    closeDb(env);
  }
});

test("the migration from user_version 5 gives every existing row the project scope and keeps its numbering", (t) => {
  const env = makeHome(t, "db-migrate-v5");
  makeProject(t, env, "alpha", { org: "acme" });
  const first = openDb(env);
  for (const number of [1, 2, 3]) {
    first
      .prepare("INSERT INTO decisions (project, number, title, context, decision) VALUES (?, ?, ?, ?, ?)")
      .run("alpha", number, `decision ${number}`, "context", "decision");
  }
  first.prepare("INSERT INTO roadmap_items (project, horizon, title, position) VALUES (?, 'now', ?, 1)").run("alpha", "ship it");
  first.exec(DOWNGRADE_TO_V5);
  assert.equal(first.prepare("PRAGMA user_version").get().user_version, 5);
  assert.equal(columnsOf(first, "decisions").includes("scope"), false, "the downgrade kept the scope column");
  closeDb(env);

  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14);
  assert.deepEqual(columnsOf(db, "decisions"), DECISION_COLUMNS);
  assert.deepEqual(columnsOf(db, "roadmap_items"), ROADMAP_COLUMNS);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM decisions WHERE scope = 'project' AND org IS NULL").get().total, 3);
  assert.equal(db.prepare("SELECT scope FROM roadmap_items").get().scope, "project");
  assert.deepEqual(
    db.prepare("PRAGMA index_info(decisions_number_idx)").all().map((column) => column.name),
    ["project", "number"],
    "the original unique index was rewritten",
  );

  assert.equal(saveDecision({ project: "alpha", title: "after", context: "c", decision: "d" }, env).number, 4);
  assert.equal(saveDecision({ org: "acme", title: "org after", context: "c", decision: "d" }, env).number, 1);
  assert.deepEqual(listDecisions({ project: "alpha" }, env).map((row) => row.number), [1, 1, 2, 3, 4]);
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

test("a v10 database gains decisions.job_id and its index, keeping every decision with no job", (t) => {
  const env = makeHome(t, "db-migrate-v10-job-id");
  makeProject(t, env, "alpha");
  const first = openDb(env);
  const saved = saveDecision({ project: "alpha", title: "t", context: "c", decision: "d" }, env);
  first.exec("DROP INDEX decisions_job_idx; ALTER TABLE decisions DROP COLUMN job_id; PRAGMA user_version = 10;");
  closeDb(env);

  assert.equal(DB_USER_VERSION, 14);
  for (const pass of [1, 2]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 14, `pass ${pass}`);
    assert.ok(columnsOf(db, "decisions").includes("job_id"), `decisions.job_id missing on pass ${pass}`);
    const indexes = db.prepare("PRAGMA index_list(decisions)").all().map((index) => index.name);
    assert.ok(indexes.includes("decisions_job_idx"), `job index missing on pass ${pass}: ${indexes.join(", ")}`);
    assert.equal(db.prepare("SELECT job_id FROM decisions WHERE id = ?").get(saved.id).job_id, null);
    closeDb(env);
  }
});
