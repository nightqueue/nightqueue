import { UserError } from "../../config/errors.mjs";
import { dbPath, preV20BackupPath } from "../../config/paths.mjs";
import {
  FTS,
  INDEXES,
  REFERENCED_COLUMNS,
  ROADMAP_COMMENT_GUARDS,
  ROADMAP_FTS,
  ROADMAP_NUMBER_INDEXES,
  decisionsDdl,
  pipelineRunsDdl,
  roadmapCommentsDdl,
  roadmapItemProjectsDdl,
  roadmapItemsDdl,
} from "../ddl.mjs";
import { hasColumn } from "../columns.mjs";
import { MigrationRefused, foreignKeyViolations, hasTable, rebuildTable, runOneShot, userVersion } from "./one-shot.mjs";

// The one-shot, version-gated migration of a v19 database to v20: every column holding another row's id gets its foreign key.
// A row pointing at a missing row refuses it before anything is written; otherwise a byte copy stays beside it as `nightqueue.db.pre-v20`.

export const V20 = 20;

const MAX_LISTED_ORPHANS = 20;

const REBUILT = Object.freeze([
  { table: "decisions", ddl: decisionsDdl },
  { table: "roadmap_items", ddl: roadmapItemsDdl },
  { table: "roadmap_item_projects", ddl: roadmapItemProjectsDdl },
  { table: "roadmap_comments", ddl: roadmapCommentsDdl },
  { table: "pipeline_runs", ddl: pipelineRunsDdl },
]);

const MIRRORS = Object.freeze(["decisions_fts", "roadmap_items_fts", "roadmap_comments_fts"]);

// Tells whether the database is exactly at v19, the only version this step migrates.
export function isPendingV20(db) {
  return userVersion(db) === 19;
}

// A stored value as one line of text, whatever its type: a BLOB as hex, a text quoted, anything else as it prints.
function printable(value) {
  if (value instanceof Uint8Array) return `x'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

// The rows of one reference that name no parent row; none when an older shape lacks the column, all when it lacks the parent table.
function danglingRows(db, { table, column, parent }) {
  if (!hasColumn(db, table, column)) return [];
  const missingParent = hasTable(db, parent) ? `NOT EXISTS (SELECT 1 FROM ${parent} AS p WHERE p.id = t.${column})` : "1";
  return db
    .prepare(`SELECT t.id AS row, t.${column} AS missing FROM ${table} AS t WHERE t.${column} IS NOT NULL AND ${missingParent} ORDER BY t.id`)
    .all();
}

// Every row whose reference names a row that does not exist, as `{ table, column, parent, row, missing }` in audit order.
export function orphansOf(db) {
  const orphans = [];
  for (const reference of REFERENCED_COLUMNS) {
    for (const { row, missing } of danglingRows(db, reference)) orphans.push({ ...reference, row, missing: printable(missing) });
  }
  return orphans;
}

// The one-line description of the orphans, the first ones named and the rest counted.
function orphanList(orphans) {
  const named = orphans
    .slice(0, MAX_LISTED_ORPHANS)
    .map(({ table, column, parent, row, missing }) => `\`${table}\` row ${row} has ${column} ${missing} (no \`${parent}\` row ${missing})`);
  const rest = orphans.length - named.length;
  return rest > 0 ? `${named.join("; ")}; and ${rest} more` : named.join("; ");
}

// Refuses the migration while any row points at a row that does not exist, naming them; the refusal writes nothing.
export function refuseOrphans(db, env) {
  const orphans = orphansOf(db);
  if (!orphans.length) return;
  throw new MigrationRefused(
    `the database must migrate to v${V20}, but ${orphans.length} row(s) point at a row that does not exist: ${orphanList(orphans)}; fix or clear them with sqlite3 on ${dbPath(env)} and run the command again; nothing was written`,
  );
}

// Drops every trigger over the rebuilt tables, which the rebuild would break and the finish recreates.
function dropRebuiltTriggers(db) {
  const tables = REBUILT.map(({ table }) => `'${table}'`).join(", ");
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${tables})`).all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

// The column names of a table, in order.
function columnNames(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

// The projection that copies a table into its twin column by column, refusing a column either side lacks so no data is dropped.
function sameColumns(table) {
  return (db, target) => {
    const source = columnNames(db, table);
    const columns = columnNames(db, target);
    const missing = columns.filter((column) => !source.includes(column));
    if (missing.length) throw new UserError(`${table}: the v20 column(s) ${missing.join(", ")} have no v19 source`);
    const unknown = source.filter((column) => !columns.includes(column));
    if (unknown.length) {
      throw new UserError(`the v20 shape has no ${unknown.map((column) => `${table}.${column}`).join(", ")}, so its data would be lost; drop or move it with sqlite3 first`);
    }
    return { columns, select: `SELECT ${columns.join(", ")} FROM ${table} ORDER BY rowid` };
  };
}

// The first foreign key break, as `table row N breaks its foreign key on column`.
function describeViolation(db) {
  const violation = db.prepare("PRAGMA foreign_key_check").get();
  if (!violation) return "";
  const key = db.prepare(`PRAGMA foreign_key_list(${violation.table})`).all().find((fk) => fk.id === violation.fkid);
  return `\`${violation.table}\` row ${violation.rowid} breaks its foreign key on ${key?.from ?? "an unknown column"}`;
}

// Recreates what the rebuilt tables dropped, re-indexes their mirrors, checks the result and stamps v20.
function finishSchema(db, violationsBefore) {
  db.exec(INDEXES);
  db.exec(ROADMAP_COMMENT_GUARDS);
  db.exec(FTS);
  db.exec(ROADMAP_FTS);
  db.exec(ROADMAP_NUMBER_INDEXES);
  for (const mirror of MIRRORS) db.exec(`INSERT INTO ${mirror}(${mirror}) VALUES('rebuild')`);
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) {
    throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the rebuild: ${describeViolation(db)}`);
  }
  db.exec(`PRAGMA user_version = ${V20}`);
}

// Every step that runs once the copy is published, inside the transaction: the orphans, the triggers, the tables, the schema.
function migrateInside(db, env, { hooks, progress }) {
  progress.step = "orphans";
  refuseOrphans(db, env);
  const violationsBefore = foreignKeyViolations(db);
  progress.step = "triggers";
  dropRebuiltTriggers(db);
  for (const { table, ddl } of REBUILT) {
    progress.step = table;
    rebuildTable(db, { table, ddl, suffix: "v20", projection: sameColumns(table) });
    hooks.afterTable?.(table);
  }
  progress.step = "indexes";
  finishSchema(db, violationsBefore);
}

const V20_STEP = Object.freeze({
  version: V20,
  backupPath: preV20BackupPath,
  isPending: isPendingV20,
  refuse: refuseOrphans,
  migrateInside,
});

// Migrates a v19 database to v20 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV20(db, env, { afterTable, afterCommit } = {}) {
  return runOneShot(db, env, V20_STEP, { afterTable, afterCommit });
}
