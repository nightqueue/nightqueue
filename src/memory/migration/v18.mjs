import { UserError } from "../../config/errors.mjs";
import { preV18BackupPath } from "../../config/paths.mjs";
import { loadRawConfig } from "../../config/store.mjs";
import {
  DATA_TABLES,
  FTS,
  FTS_MIRRORS,
  INDEXES,
  OWNER_CHECK,
  ROADMAP_FTS,
  jobsDdl,
  lessonsDdl,
  memoryDdl,
  projectIndexDdl,
  projectLibsDdl,
} from "../ddl.mjs";
import { importLegacyRegistry, stripLegacyConfig } from "./legacy-config.mjs";
import { bringToV17 } from "./legacy.mjs";
import { foreignKeyViolations, hasTable, rebuildTable, runOneShot, userVersion } from "./one-shot.mjs";
import { moveRunsToIds } from "./runs-by-id.mjs";
import { REGISTRY_V18, roadmapItemsDdlV18 } from "./v18-shape.mjs";
import {
  ROADMAP_COMMENT_GUARDS_V19,
  decisionsDdlV19,
  pipelineRunsDdlV19,
  roadmapCommentsDdlV19,
  roadmapItemProjectsDdlV19,
} from "./v19-shape.mjs";

export { hasLegacyRegistry, importLegacyRegistry, readV17Registry } from "./legacy-config.mjs";
export { MigrationRefused } from "./one-shot.mjs";

// The one-shot, version-gated migration of a v17 (or older) database to v18: names become ids. Nothing is written unless
// the whole of it commits, and a byte copy of the database taken right before stays beside it as `nightqueue.db.pre-v18`.

export const V18 = 18;

// The data tables re-created with id columns as `{ table, ddl(name) }`, each stage adding its own, in the order they are rebuilt.
export const REBUILT_TABLES = Object.freeze([
  { table: "lessons", ddl: lessonsDdl },
  { table: "memory", ddl: memoryDdl },
  { table: "project_index", ddl: projectIndexDdl },
  { table: "project_libs", ddl: projectLibsDdl },
  { table: "pipeline_runs", ddl: pipelineRunsDdlV19 },
  { table: "jobs", ddl: jobsDdl },
  { table: "decisions", ddl: decisionsDdlV19 },
  { table: "roadmap_items", ddl: roadmapItemsDdlV18 },
  { table: "roadmap_item_projects", ddl: roadmapItemProjectsDdlV19 },
  { table: "roadmap_comments", ddl: roadmapCommentsDdlV19 },
]);

// Where the database stands: `current` at v18 or later, `legacy` below it with data tables, `fresh` with none.
export function schemaState(db) {
  if (userVersion(db) >= V18) return "current";
  return DATA_TABLES.some((table) => hasTable(db, table)) ? "legacy" : "fresh";
}

// How a v17 table's rows read in v18 terms: every v18 column as an expression over `t`, the owner names joined to their ids.
function v18Projection(db, table, target) {
  const columns = db.prepare(`PRAGMA table_info(${target})`).all().map((column) => column.name);
  const source = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const mapped = (column) => (column === "project_id" || column === "org_id") && !source.has(column);
  const plain = columns.filter((column) => !mapped(column));
  const missing = plain.filter((column) => !source.has(column));
  if (missing.length) throw new UserError(`${table}: the v18 column(s) ${missing.join(", ")} have no v17 source`);
  refuseUnmappable(db, table, source);
  const values = new Map(plain.map((column) => [column, `t.${column}`]));
  const joins = [];
  if (columns.includes("project_id") && mapped("project_id")) {
    values.set("project_id", "p.id");
    joins.push("LEFT JOIN projects AS p ON p.name = t.project");
  }
  if (columns.includes("org_id") && mapped("org_id")) {
    values.set("org_id", "o.id");
    joins.push("LEFT JOIN orgs AS o ON o.name = t.org");
  }
  return { values, from: `FROM ${table} AS t ${joins.join(" ")}` };
}

// Refuses a decision or roadmap item whose owner breaks the v18 owner CHECK, naming the table, the row and its owner.
function refuseOwnerConflict(db, table, { values, from }) {
  if (!values.has("scope") || !values.has("org_id")) return;
  const check = OWNER_CHECK.replaceAll("scope", values.get("scope"))
    .replaceAll("project_id", values.get("project_id"))
    .replaceAll("org_id", values.get("org_id"));
  const project = values.get("project_id") === "p.id" ? "t.project" : values.get("project_id");
  const org = values.get("org_id") === "o.id" ? "t.org" : values.get("org_id");
  const row = db
    .prepare(`SELECT t.id AS id, ${values.get("scope")} AS scope, ${project} AS project, ${org} AS org ${from} WHERE NOT (${check}) LIMIT 1`)
    .get();
  if (row) {
    throw new UserError(
      `${table} row ${row.id} has scope \`${row.scope}\` with project \`${row.project ?? "none"}\` and org \`${row.org ?? "none"}\`: a project row names no org, an org row names an org and no project`,
    );
  }
}

// The projection a v17 table is copied with into its v18 twin, the owner names mapped to ids and the owner rule checked first.
function v18Copy(table) {
  return (db, target) => {
    const projection = v18Projection(db, table, target);
    refuseOwnerConflict(db, table, projection);
    return {
      columns: [...projection.values.keys()],
      select: `SELECT ${[...projection.values.values()].join(", ")} ${projection.from}`,
    };
  };
}

// Refuses a row whose owner name the registry cannot map, naming the table, the row and the value.
function refuseUnmappable(db, table, source) {
  for (const [column, registryTable] of [["project", "projects"], ["org", "orgs"]]) {
    if (!source.has(column)) continue;
    const row = db
      .prepare(`SELECT t.id, t.${column} AS value FROM ${table} AS t WHERE t.${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM ${registryTable} AS r WHERE r.name = t.${column}) LIMIT 1`)
      .get();
    if (row) throw new UserError(`${table} row ${row.id} names the unknown ${column} \`${row.value}\``);
  }
}

// Creates every index, trigger and lexical mirror of the v18 schema, re-indexes the mirrors and stamps v18.
function finishSchema(db, violationsBefore) {
  db.exec(INDEXES);
  db.exec(ROADMAP_COMMENT_GUARDS_V19);
  db.exec(FTS);
  db.exec(ROADMAP_FTS);
  for (const mirror of FTS_MIRRORS) db.exec(`INSERT INTO ${mirror}(${mirror}) VALUES('rebuild')`);
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the rebuild`);
  db.exec(`PRAGMA user_version = ${V18}`);
}

// Every step that runs once the copy is published, inside the transaction: v17 first, then the registry, the tables and the schema.
function migrateInside(db, env, { hooks, progress }) {
  progress.step = "v17";
  bringToV17(db);
  progress.step = "registry";
  db.exec(REGISTRY_V18);
  importLegacyRegistry(db, loadRawConfig(env));
  const violationsBefore = foreignKeyViolations(db);
  for (const { table, ddl } of REBUILT_TABLES) {
    progress.step = table;
    rebuildTable(db, { table, ddl, suffix: "v18", projection: v18Copy(table) });
    hooks.afterTable?.(table);
  }
  progress.step = "indexes";
  finishSchema(db, violationsBefore);
}

const V18_STEP = Object.freeze({
  version: V18,
  backupPath: preV18BackupPath,
  isPending: (db) => schemaState(db) === "legacy",
  migrateInside,
});

// Migrates a legacy database to v18 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV18(db, env, { afterTable, afterCommit } = {}) {
  return runOneShot(db, env, V18_STEP, { afterTable, afterCommit });
}

// The per-open steps that follow the migration: read-guarded, idempotent, and never fatal for the open.
export function finishV18(db, env, { warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  try {
    stripLegacyConfig(db, env, { warn });
  } catch (err) {
    warn(`nightqueue: warning: could not finish the v18 migration of config.json: ${err?.message ?? err}`);
  }
  try {
    moveRunsToIds(db, env, { warn });
  } catch (err) {
    warn(`nightqueue: warning: could not move the run directories to project ids: ${err?.message ?? err}`);
  }
}
