import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const { DatabaseSync } = await import("node:sqlite");

// The columns that hold another thing's identity with no foreign key, each with the reason it has none.
const EXCEPTIONS = Object.freeze({
  "jobs.session_id": "a Claude Code session id: external, no table holds sessions",
  "jobs.last_session_id": "a Claude Code session id: external, no table holds sessions",
  "job_attempts.session_id": "a Claude Code session id: external, no table holds sessions",
  "pipeline_runs.session_id": "a Claude Code session id: external, no table holds sessions",
});

// Every foreign key of the schema, as `table.column` -> `parent(column) ON DELETE rule`: a rule never changes silently.
const EXPECTED = Object.freeze({
  "decisions.job_id": "jobs(id) ON DELETE SET NULL",
  "decisions.org_id": "orgs(id) ON DELETE RESTRICT",
  "decisions.project_id": "projects(id) ON DELETE RESTRICT",
  "decisions.superseded_by": "decisions(id) ON DELETE RESTRICT",
  "issue_comments.item_id": "issues(id) ON DELETE CASCADE",
  "issue_comments.project_id": "projects(id) ON DELETE RESTRICT",
  "issue_projects.item_id": "issues(id) ON DELETE CASCADE",
  "issue_projects.job_id": "jobs(id) ON DELETE SET NULL",
  "issue_projects.project_id": "projects(id) ON DELETE RESTRICT",
  "issues.decision_id": "decisions(id) ON DELETE SET NULL",
  "issues.job_id": "jobs(id) ON DELETE SET NULL",
  "issues.org_id": "orgs(id) ON DELETE RESTRICT",
  "issues.project_id": "projects(id) ON DELETE RESTRICT",
  "job_attempts.job_id": "jobs(id) ON DELETE CASCADE",
  "jobs.project_id": "projects(id) ON DELETE RESTRICT",
  "lessons.project_id": "projects(id) ON DELETE RESTRICT",
  "memory.project_id": "projects(id) ON DELETE RESTRICT",
  "org_key_aliases.org_id": "orgs(id) ON DELETE CASCADE",
  "pipeline_phases.run_id": "pipeline_runs(id) ON DELETE CASCADE",
  "pipeline_runs.job_id": "jobs(id) ON DELETE SET NULL",
  "pipeline_runs.project_id": "projects(id) ON DELETE RESTRICT",
  "project_index.project_id": "projects(id) ON DELETE RESTRICT",
  "project_key_aliases.project_id": "projects(id) ON DELETE CASCADE",
  "project_libs.project_id": "projects(id) ON DELETE RESTRICT",
  "projects.org_id": "orgs(id) ON DELETE RESTRICT",
});

// Tells whether a column name says it holds another row's id.
function isReferenceName(column) {
  return /_id$/.test(column) || column === "superseded_by";
}

// The plain tables of a database: no SQLite internals, no virtual tables and none of their shadow tables.
function plainTables(db) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const virtual = tables.filter((table) => String(table.sql).startsWith("CREATE VIRTUAL TABLE")).map((table) => table.name);
  return tables.map((table) => table.name).filter((name) => !virtual.some((owner) => name === owner || name.startsWith(`${owner}_`)));
}

// Walks a database: every foreign key it declares, every column it has, and the reference columns with neither a key nor an exception.
function walkReferences(db, exceptions) {
  const foreignKeys = {};
  const columns = new Set();
  const unreferenced = [];
  for (const table of plainTables(db)) {
    const keys = db.prepare(`PRAGMA foreign_key_list(${table})`).all();
    for (const key of keys) foreignKeys[`${table}.${key.from}`] = `${key.table}(${key.to}) ON DELETE ${key.on_delete}`;
    for (const { name } of db.prepare(`PRAGMA table_info(${table})`).all()) {
      columns.add(`${table}.${name}`);
      if (!isReferenceName(name) || keys.some((key) => key.from === name) || Object.hasOwn(exceptions, `${table}.${name}`)) continue;
      unreferenced.push(`${table}.${name}`);
    }
  }
  return { foreignKeys, columns, unreferenced };
}

// The walk of a fresh home's database.
function freshWalk(t) {
  return walkReferences(openDb(makeHome(t, "schema-references")), EXCEPTIONS);
}

test("every column holding another row's id has a foreign key or an exception with a reason", (t) => {
  const { unreferenced } = freshWalk(t);
  assert.deepEqual(
    unreferenced,
    [],
    `${unreferenced.join(", ")}: add a REFERENCES clause with an ON DELETE rule, or add an exception with a reason to EXCEPTIONS`,
  );
  for (const [name, reason] of Object.entries(EXCEPTIONS)) assert.ok(reason.trim().length > 0, `the exception ${name} gives no reason`);
});

test("every foreign key of the schema points where the audit says, with the audited delete rule", (t) => {
  assert.deepEqual(freshWalk(t).foreignKeys, EXPECTED);
});

test("every exception still names a column of the schema", (t) => {
  const { columns } = freshWalk(t);
  const stale = Object.keys(EXCEPTIONS).filter((name) => !columns.has(name));
  assert.deepEqual(stale, [], `stale exceptions: ${stale.join(", ")}`);
});

test("the walker reports a reference column with no foreign key, and only that one", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE p (id INTEGER PRIMARY KEY)");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x_id INTEGER, superseded_by INTEGER, p_id INTEGER REFERENCES p(id) ON DELETE CASCADE, note TEXT)");
    db.exec("CREATE VIRTUAL TABLE t_fts USING fts5(note, content='t', content_rowid='id')");
    const { unreferenced, foreignKeys } = walkReferences(db, {});
    assert.deepEqual(unreferenced, ["t.x_id", "t.superseded_by"]);
    assert.deepEqual(foreignKeys, { "t.p_id": "p(id) ON DELETE CASCADE" });
    assert.deepEqual(walkReferences(db, { "t.x_id": "a reason", "t.superseded_by": "a reason" }).unreferenced, []);
  } finally {
    db.close();
  }
});
