import { UserError } from "../../config/errors.mjs";
import { preVersionBackupPath } from "../../config/paths.mjs";
import { JOBS_FTS, JOBS_FTS_BACKFILL, JOBS_FTS_DRIFT, JOBS_FTS_PRUNE, JOBS_INDEXES, jobsDdl } from "../ddl.mjs";
import { foreignKeyViolations, rebuildTable, runOneShot, userVersion } from "./one-shot.mjs";

// The one-shot, version-gated migration of a v24 database to v25: `jobs` is rebuilt under the closed invariant that also admits
// a job resolved without change (no pull request, its checklist recording `resolvedWithoutChange`); every column and row is kept,
// nothing is written unless the whole of it commits, and a byte copy stays beside it as `nightqueue.db.pre-v25`.

export const V25 = 25;

// The closed invariant of v24 and older, frozen for the fixtures of the migration tests.
export const CLOSED_REQUIRES_MERGE_V24 = `CHECK (status <> 'closed' OR (pr_url IS NOT NULL AND trim(pr_url) <> '' AND close_status IS NULL
  AND (CASE WHEN json_valid(close) THEN json_extract(close, '$.data.merged') END) IS 1))`;

const INVARIANT_MARKER = "resolvedWithoutChange";

// Tells whether the database is exactly at v24, the only version this step migrates.
export function isPendingV25(db) {
  return userVersion(db) === 24;
}

// The number of rows of a table.
function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

// The columns of a table as `PRAGMA table_info` lists them, in order.
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

// Drops every trigger over `jobs`, which the rebuild would break and the finish recreates.
function dropJobsTriggers(db) {
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs'").all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

// The projection that copies every source column of `jobs`, first giving the new table the per-open columns its DDL lacks.
function everyJobsColumn(db, target) {
  const source = columnsOf(db, "jobs");
  const present = new Set(columnsOf(db, target).map((column) => column.name));
  for (const column of source) {
    if (!present.has(column.name)) db.exec(`ALTER TABLE ${target} ADD COLUMN "${column.name}" ${column.type}`);
  }
  const columns = source.map((column) => `"${column.name}"`);
  return { columns, select: `SELECT ${columns.join(", ")} FROM jobs ORDER BY rowid` };
}

// Checks the result against the counts taken before: every job kept and indexed, the new invariant in place, no new foreign key break.
function verifySchema(db, { jobsBefore, violationsBefore }) {
  const jobs = countOf(db, "jobs");
  if (jobs !== jobsBefore) throw new UserError(`jobs: ${jobs} rows after the migration, ${jobsBefore} before`);
  if (db.prepare(JOBS_FTS_DRIFT).get()) throw new UserError("jobs_fts: the index of the job history drifted from the jobs");
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get()?.sql ?? "";
  if (!sql.includes(INVARIANT_MARKER)) throw new UserError("jobs: the rebuilt table does not carry the v25 closed invariant");
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the rebuild of jobs`);
}

// Every step that runs once the copy is published, inside the transaction: the triggers, the table, its indexes, the checks and the stamp.
function migrateInside(db, env, { progress }) {
  const violationsBefore = foreignKeyViolations(db);
  const jobsBefore = countOf(db, "jobs");
  progress.step = "triggers";
  dropJobsTriggers(db);
  progress.step = "jobs";
  rebuildTable(db, { table: "jobs", ddl: jobsDdl, suffix: "v25", projection: everyJobsColumn });
  progress.step = "indexes";
  db.exec(JOBS_INDEXES);
  db.exec(JOBS_FTS);
  db.exec(JOBS_FTS_PRUNE);
  db.exec(JOBS_FTS_BACKFILL);
  progress.step = "verify";
  verifySchema(db, { jobsBefore, violationsBefore });
  db.exec(`PRAGMA user_version = ${V25}`);
}

const V25_STEP = Object.freeze({
  version: V25,
  backupPath: (env) => preVersionBackupPath(env, V25),
  isPending: isPendingV25,
  migrateInside,
});

// Migrates a v24 database to v25 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV25(db, env, { afterCommit } = {}) {
  return runOneShot(db, env, V25_STEP, { afterCommit });
}
