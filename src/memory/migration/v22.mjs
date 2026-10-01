import { UserError } from "../../config/errors.mjs";
import { preV21BackupPath } from "../../config/paths.mjs";
import {
  INDEXES,
  ISSUE_COMMENT_GUARDS,
  ISSUE_FTS,
  ISSUE_NUMBER_INDEXES,
  issueCommentsDdl,
  issueProjectsDdl,
  issuesDdl,
} from "../ddl.mjs";
import { keepSequence, sequenceOf } from "./legacy.mjs";
import { foreignKeyViolations, hasTable, runOneShot, userVersion } from "./one-shot.mjs";
import { refuseOrphans } from "./v20.mjs";

// The one-shot, version-gated migration of a v20 database to v21: the tracker tables, their mirrors, guards and indexes take
// the issue names. Each table is copied into its final name from the current DDL, so the result is byte-identical to a fresh
// creation; nothing is written unless the whole of it commits, and a byte copy stays beside it as `nightqueue.db.pre-v21`.

export const V21 = 21;

const OLD_WORD = "roadmap";

const RENAMED = Object.freeze([
  { from: "roadmap_items", to: "issues", ddl: issuesDdl },
  { from: "roadmap_item_projects", to: "issue_projects", ddl: issueProjectsDdl },
  { from: "roadmap_comments", to: "issue_comments", ddl: issueCommentsDdl },
]);

const OLD_MIRRORS = Object.freeze(["roadmap_items_fts", "roadmap_comments_fts"]);

const MIRRORS = Object.freeze(["issues_fts", "issue_comments_fts"]);

// Tells whether the database is exactly at v20, the only version this step migrates.
export function isPendingV21(db) {
  return userVersion(db) === 20;
}

// Refuses the migration while any row points at a row that does not exist, with the same check the v20 step and doctor run.
function refuseOrphansV21(db, env) {
  refuseOrphans(db, env, V21);
}

// Drops every trigger over the renamed tables, which go away with them and the finish recreates under the new names.
function dropOldTriggers(db) {
  const tables = RENAMED.map(({ from }) => `'${from}'`).join(", ");
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${tables})`).all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

// The column names of a table, in order.
function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

// The columns a table is copied with into its new name, refusing a column either side lacks so no data is dropped.
function sharedColumns(db, { from, to }) {
  const source = columnNames(db, from);
  const columns = columnNames(db, to);
  const missing = columns.filter((column) => !source.includes(column));
  if (missing.length) throw new UserError(`${to}: the v21 column(s) ${missing.join(", ")} have no v20 source in ${from}`);
  const unknown = source.filter((column) => !columns.includes(column));
  if (unknown.length) {
    throw new UserError(`the v21 shape has no ${unknown.map((column) => `${from}.${column}`).join(", ")}, so its data would be lost; drop or move it with sqlite3 first`);
  }
  return columns;
}

// Copies one table into its new name: same rows in rowid order, the row count checked, the AUTOINCREMENT counter kept.
function copyTable(db, { from, to, ddl }) {
  if (hasTable(db, to)) throw new UserError(`the table \`${to}\` already exists beside \`${from}\`; inspect the database with sqlite3`);
  const sequence = sequenceOf(db, from);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ${from}`).get().n;
  db.exec(ddl(to));
  const columns = sharedColumns(db, { from, to }).join(", ");
  db.exec(`INSERT INTO ${to} (${columns}) SELECT ${columns} FROM ${from} ORDER BY rowid`);
  const copied = db.prepare(`SELECT COUNT(*) AS n FROM ${to}`).get().n;
  if (copied !== before) throw new UserError(`${to}: copied ${copied} of ${before} rows from ${from}`);
  keepSequence(db, to, sequence);
}

// Drops the old tables, children first, with the indexes and counters that belong to them.
function dropOldTables(db) {
  for (const { from } of [...RENAMED].reverse()) db.exec(`DROP TABLE ${from}`);
}

// Refuses a schema object or a counter that still carries the old name.
function refuseOldNames(db) {
  const pattern = `%${OLD_WORD}%`;
  const object = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE ? OR tbl_name LIKE ? LIMIT 1").get(pattern, pattern);
  if (object) throw new UserError(`the schema object \`${object.name}\` still carries the old name`);
  const counter = db.prepare("SELECT name FROM sqlite_sequence WHERE name LIKE ? LIMIT 1").get(pattern);
  if (counter) throw new UserError(`the counter of \`${counter.name}\` still carries the old name`);
}

// The first foreign key break, as `table row N breaks its foreign key on column`.
function describeViolation(db) {
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (!violation) return "";
  const key = db.prepare(`PRAGMA foreign_key_list(${violation.table})`).all().find((fk) => fk.id === violation.fkid);
  return `\`${violation.table}\` row ${violation.rowid} breaks its foreign key on ${key?.from ?? "an unknown column"}`;
}

// Recreates the indexes, guards and mirrors under the new names, re-indexes the mirrors, checks the result and stamps v21.
function finishSchema(db, violationsBefore) {
  db.exec(INDEXES);
  db.exec(ISSUE_COMMENT_GUARDS);
  db.exec(ISSUE_FTS);
  db.exec(ISSUE_NUMBER_INDEXES);
  for (const mirror of MIRRORS) db.exec(`INSERT INTO ${mirror}(${mirror}) VALUES('rebuild')`);
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) {
    throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the rename: ${describeViolation(db)}`);
  }
  refuseOldNames(db);
  db.exec(`PRAGMA user_version = ${V21}`);
}

// Every step that runs once the copy is published, inside the transaction: the triggers, the mirrors, the tables, the schema.
function migrateInside(db, env, { hooks, progress }) {
  const violationsBefore = foreignKeyViolations(db);
  progress.step = "triggers";
  dropOldTriggers(db);
  progress.step = "mirrors";
  for (const mirror of OLD_MIRRORS) db.exec(`DROP TABLE IF EXISTS ${mirror}`);
  for (const table of RENAMED) {
    progress.step = table.to;
    copyTable(db, table);
    hooks.afterTable?.(table.to);
  }
  progress.step = "drop";
  dropOldTables(db);
  progress.step = "indexes";
  finishSchema(db, violationsBefore);
}

const V21_STEP = Object.freeze({
  version: V21,
  backupPath: preV21BackupPath,
  isPending: isPendingV21,
  refuse: refuseOrphansV21,
  migrateInside,
});

// Migrates a v20 database to v21 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV21(db, env, { afterTable, afterCommit } = {}) {
  return runOneShot(db, env, V21_STEP, { afterTable, afterCommit });
}
