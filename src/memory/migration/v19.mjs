import { UserError } from "../../config/errors.mjs";
import { preV19BackupPath } from "../../config/paths.mjs";
import { OWNER_KEY_GUARDS, REGISTRY, orgsDdl, projectsDdl } from "../ddl.mjs";
import { suggestKeyUnbounded } from "../refs.mjs";
import { foreignKeyViolations, rebuildTable, runOneShot, userVersion } from "./one-shot.mjs";
import { roadmapItemsDdlV19 } from "./v19-shape.mjs";
import { INDEXES_V20, ROADMAP_FTS_V20, ROADMAP_NUMBER_INDEXES_V20 } from "./v20-shape.mjs";

// The one-shot, version-gated migration of a v18 database to v19: every project and org gets a key, every roadmap item a
// per-owner number, built in the frozen v19 shape. Nothing is written unless the whole of it commits, and a byte copy stays
// beside it as `nightqueue.db.pre-v19`.

export const V19 = 19;

const OWNER_KEYS = "v19_owner_keys";

// Tells whether the database is exactly at v18, the only version this step migrates.
export function isPendingV19(db) {
  return userVersion(db) === 18;
}

// Gives every project (registration order) then every org (creation order) a free key derived from its name, recorded by owner id.
function assignKeys(db) {
  db.exec(`DROP TABLE IF EXISTS temp.${OWNER_KEYS}`);
  db.exec(`CREATE TEMP TABLE ${OWNER_KEYS} (owner_id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE)`);
  const record = db.prepare(`INSERT INTO temp.${OWNER_KEYS} (owner_id, key) VALUES (?, ?)`);
  const taken = new Set();
  const owners = [
    ...db.prepare("SELECT id, name, 'project' AS kind FROM projects ORDER BY rowid").all(),
    ...db.prepare("SELECT id, name, 'org' AS kind FROM orgs ORDER BY created_at, id").all(),
  ];
  for (const owner of owners) {
    const key = suggestKeyUnbounded(owner.name, taken, { kind: owner.kind });
    taken.add(key);
    record.run(owner.id, key);
  }
}

// The projection that copies every column a table already has and fills the new ones from the given expressions and joins.
function projectionWith(table, { extra, joins }) {
  return (db, target) => {
    const source = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
    const columns = db.prepare(`PRAGMA table_info(${target})`).all().map((column) => column.name);
    const missing = columns.filter((column) => !source.has(column) && !Object.hasOwn(extra, column));
    if (missing.length) throw new UserError(`${table}: the v19 column(s) ${missing.join(", ")} have no v18 source`);
    const values = columns.map((column) => (Object.hasOwn(extra, column) ? extra[column] : `t.${column}`));
    return { columns, select: `SELECT ${values.join(", ")} FROM ${table} AS t ${joins} ORDER BY t.rowid` };
  };
}

// The projection of a registry table: every v18 column plus the key assigned to the row.
function keyedCopy(table) {
  return projectionWith(table, { extra: { key: "k.key" }, joins: `JOIN temp.${OWNER_KEYS} AS k ON k.owner_id = t.id` });
}

// The projection of `roadmap_items`: every v18 column plus its number, 1..n per owner in id order.
const numberedItems = projectionWith("roadmap_items", {
  extra: { number: "n.number" },
  joins: `JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY scope, project_id, org_id ORDER BY id) AS number FROM roadmap_items) AS n ON n.id = t.id`,
});

// Refuses a key held by more than one project or org after the rebuild.
function refuseRepeatedKeys(db) {
  const repeated = db
    .prepare("SELECT key FROM (SELECT key FROM projects UNION ALL SELECT key FROM orgs) GROUP BY key HAVING COUNT(*) > 1 LIMIT 1")
    .get();
  if (repeated) throw new UserError(`the key \`${repeated.key}\` was given to more than one project or org`);
}

// Recreates what the rebuilt tables dropped, re-indexes the roadmap mirror, checks the result and stamps v19.
function finishSchema(db, violationsBefore) {
  db.exec(REGISTRY);
  db.exec(INDEXES_V20);
  db.exec(ROADMAP_FTS_V20);
  db.exec(ROADMAP_NUMBER_INDEXES_V20);
  db.exec(OWNER_KEY_GUARDS);
  db.exec("INSERT INTO roadmap_items_fts(roadmap_items_fts) VALUES('rebuild')");
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the rebuild`);
  refuseRepeatedKeys(db);
  db.exec(`DROP TABLE temp.${OWNER_KEYS}`);
  db.exec(`PRAGMA user_version = ${V19}`);
}

// Drops every trigger over the registry tables, which the rebuild would break and the finish recreates.
function dropRegistryTriggers(db) {
  const triggers = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('orgs', 'projects', 'project_key_aliases', 'org_key_aliases')")
    .all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
}

// Every step that runs once the copy is published, inside the transaction: keys, the registry, the roadmap items, the schema.
function migrateInside(db, env, { hooks, progress }) {
  const violationsBefore = foreignKeyViolations(db);
  progress.step = "keys";
  dropRegistryTriggers(db);
  assignKeys(db);
  for (const [table, ddl, projection] of [
    ["orgs", orgsDdl, keyedCopy("orgs")],
    ["projects", projectsDdl, keyedCopy("projects")],
    ["roadmap_items", roadmapItemsDdlV19, numberedItems],
  ]) {
    progress.step = table;
    rebuildTable(db, { table, ddl, suffix: "v19", projection });
    hooks.afterTable?.(table);
  }
  progress.step = "indexes";
  finishSchema(db, violationsBefore);
}

const V19_STEP = Object.freeze({ version: V19, backupPath: preV19BackupPath, isPending: isPendingV19, migrateInside });

// Migrates a v18 database to v19 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV19(db, env, { afterTable, afterCommit } = {}) {
  return runOneShot(db, env, V19_STEP, { afterTable, afterCommit });
}
