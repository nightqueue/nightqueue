import { UserError } from "../../config/errors.mjs";
import { preVersionBackupPath } from "../../config/paths.mjs";
import { foreignKeyViolations, hasTable, runOneShot, userVersion } from "./one-shot.mjs";

// The one-shot, version-gated migration of a v25 database to v26: the `decisions` table goes with its lexical mirror, triggers
// and indexes, and every decision row with it; lessons, memories and jobs are kept as they are, nothing is written unless the
// whole of it commits, and a byte copy stays beside it as `nightqueue.db.pre-v26`.

export const V26 = 26;

const KEPT_TABLES = Object.freeze(["lessons", "memory", "jobs"]);

// Tells whether the database is exactly at v25, the only version this step migrates.
export function isPendingV26(db) {
  return userVersion(db) === 25;
}

// The number of rows of each kept table, as `{ table: n }`.
function keptCounts(db) {
  return Object.fromEntries(KEPT_TABLES.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

// Refuses the drop while any other table still holds a foreign key to `decisions`, naming the table and the column.
function refuseReferences(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name <> 'decisions'").all();
  for (const { name } of tables) {
    const key = db.prepare(`PRAGMA foreign_key_list("${name}")`).all().find((fk) => fk.table === "decisions");
    if (key) throw new UserError(`${name}.${key.from} still points at \`decisions\`; drop or move it with sqlite3 first`);
  }
}

// Drops every trigger over `decisions`.
function dropDecisionTriggers(db) {
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'decisions'").all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

// Drops the `decisions` table, its indexes with it, and its AUTOINCREMENT counter.
function dropDecisionsTable(db) {
  db.exec("DROP TABLE IF EXISTS decisions");
  if (hasTable(db, "sqlite_sequence")) db.exec("DELETE FROM sqlite_sequence WHERE name = 'decisions'");
}

// Checks the result against the counts taken before: nothing of the decisions left, every kept row kept, no new foreign key break.
function verifySchema(db, { countsBefore, violationsBefore }) {
  const object = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'decisions%' OR tbl_name = 'decisions' LIMIT 1").get();
  if (object) throw new UserError(`the schema object \`${object.name}\` of the decisions is still there`);
  const counts = keptCounts(db);
  for (const table of KEPT_TABLES) {
    if (counts[table] !== countsBefore[table]) throw new UserError(`${table}: ${counts[table]} rows after the migration, ${countsBefore[table]} before`);
  }
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the decisions were dropped`);
}

// Every step that runs once the copy is published, inside the transaction: the references, the triggers, the mirror, the table, the checks and the stamp.
function migrateInside(db, env, { progress }) {
  const violationsBefore = foreignKeyViolations(db);
  const countsBefore = keptCounts(db);
  progress.step = "references";
  refuseReferences(db);
  progress.step = "triggers";
  dropDecisionTriggers(db);
  progress.step = "mirror";
  db.exec("DROP TABLE IF EXISTS decisions_fts");
  progress.step = "table";
  dropDecisionsTable(db);
  progress.step = "verify";
  verifySchema(db, { countsBefore, violationsBefore });
  db.exec(`PRAGMA user_version = ${V26}`);
}

const V26_STEP = Object.freeze({
  version: V26,
  backupPath: (env) => preVersionBackupPath(env, V26),
  isPending: isPendingV26,
  migrateInside,
});

// Migrates a v25 database to v26 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV26(db, env, { afterCommit } = {}) {
  return runOneShot(db, env, V26_STEP, { afterCommit });
}
