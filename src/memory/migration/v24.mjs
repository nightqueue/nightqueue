import { UserError } from "../../config/errors.mjs";
import { preVersionBackupPath } from "../../config/paths.mjs";
import { JOBS_FTS } from "../ddl.mjs";
import { foreignKeyViolations, hasTable, runOneShot, userVersion } from "./one-shot.mjs";

// The one-shot, version-gated migration of a v22 or v23 database to v24: the lexical index of the job history is created and
// rebuilt from every job, and the tracker tables go with their mirrors, guards and indexes; nothing is written unless the whole
// of it commits, and a byte copy stays beside it as `nightqueue.db.pre-v24`.

export const V24 = 24;

const TRACKER_TABLES = Object.freeze(["issue_comments", "issue_projects", "issues"]);

const TRACKER_MIRRORS = Object.freeze(["issue_comments_fts", "issues_fts"]);

const TRACKER_PATTERN = "issue%";

// Tells whether the database is at v22 or v23, the versions that still carry the tracker and no index of the job history.
export function isPendingV24(db) {
  const version = userVersion(db);
  return version === 22 || version === 23;
}

// The number of rows of a table.
function countOf(db, table) {
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

// Creates the index of the job history and rebuilds it from every job, so a stale index left by an older home is corrected.
function rebuildJobsIndex(db) {
  db.exec(JOBS_FTS);
  db.exec("DELETE FROM jobs_fts");
  db.exec("INSERT INTO jobs_fts(rowid, slug, brief, notice) SELECT id, slug, substr(prompt, 1, 1500), notice_md FROM jobs");
}

// Drops every trigger over the tracker tables.
function dropTrackerTriggers(db) {
  const tables = TRACKER_TABLES.map((table) => `'${table}'`).join(", ");
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${tables})`).all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

// Drops the tracker tables, children first, with their indexes and any AUTOINCREMENT counter left behind.
function dropTrackerTables(db) {
  for (const table of TRACKER_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  if (!hasTable(db, "sqlite_sequence")) return;
  const names = TRACKER_TABLES.map((table) => `'${table}'`).join(", ");
  db.exec(`DELETE FROM sqlite_sequence WHERE name IN (${names})`);
}

// The first foreign key break, as `table row N breaks its foreign key on column`.
function describeViolation(db) {
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (!violation) return "";
  const key = db.prepare(`PRAGMA foreign_key_list(${violation.table})`).all().find((fk) => fk.id === violation.fkid);
  return `\`${violation.table}\` row ${violation.rowid} breaks its foreign key on ${key?.from ?? "an unknown column"}`;
}

// Refuses a schema object that still belongs to the tracker, or a decision that still points at it.
function refuseTrackerLeft(db) {
  const object = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE ? OR tbl_name LIKE ? LIMIT 1").get(TRACKER_PATTERN, TRACKER_PATTERN);
  if (object) throw new UserError(`the schema object \`${object.name}\` of the tracker is still there`);
  const key = db.prepare("PRAGMA foreign_key_list(decisions)").all().find((fk) => String(fk.table).startsWith("issue"));
  if (key) throw new UserError(`decisions.${key.from} still points at the dropped table \`${key.table}\``);
}

// Checks the result against the counts taken before: every job kept and indexed, nothing of the tracker left, no new foreign key break.
function verifySchema(db, { jobsBefore, violationsBefore }) {
  const jobs = countOf(db, "jobs");
  if (jobs !== jobsBefore) throw new UserError(`jobs: ${jobs} rows after the migration, ${jobsBefore} before`);
  const indexed = countOf(db, "jobs_fts");
  if (indexed !== jobsBefore) throw new UserError(`jobs_fts: indexed ${indexed} of ${jobsBefore} jobs`);
  refuseTrackerLeft(db);
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) {
    throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the tracker was dropped: ${describeViolation(db)}`);
  }
}

// Every step that runs once the copy is published, inside the transaction: the job index, the tracker, the checks and the stamp.
function migrateInside(db, env, { progress }) {
  const violationsBefore = foreignKeyViolations(db);
  const jobsBefore = countOf(db, "jobs");
  progress.step = "jobs_fts";
  rebuildJobsIndex(db);
  progress.step = "triggers";
  dropTrackerTriggers(db);
  progress.step = "mirrors";
  for (const mirror of TRACKER_MIRRORS) db.exec(`DROP TABLE IF EXISTS ${mirror}`);
  progress.step = "tables";
  dropTrackerTables(db);
  progress.step = "verify";
  verifySchema(db, { jobsBefore, violationsBefore });
  db.exec(`PRAGMA user_version = ${V24}`);
}

const V24_STEP = Object.freeze({
  version: V24,
  backupPath: (env) => preVersionBackupPath(env, V24),
  isPending: isPendingV24,
  migrateInside,
});

// Migrates a v22 or v23 database to v24 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV24(db, env, { afterCommit } = {}) {
  return runOneShot(db, env, V24_STEP, { afterCommit });
}
