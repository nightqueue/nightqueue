import { spawnSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, renameSync, rmSync, statSync } from "node:fs";
import { UserError } from "../../config/errors.mjs";
import { dbPath, preV18BackupPath } from "../../config/paths.mjs";
import { loadRawConfig } from "../../config/store.mjs";
import {
  DATA_TABLES,
  FTS,
  FTS_MIRRORS,
  INDEXES,
  OWNER_CHECK,
  REGISTRY,
  ROADMAP_COMMENT_GUARDS,
  ROADMAP_FTS,
  decisionsDdl,
  jobsDdl,
  lessonsDdl,
  memoryDdl,
  pipelineRunsDdl,
  projectIndexDdl,
  projectLibsDdl,
  roadmapCommentsDdl,
  roadmapItemProjectsDdl,
  roadmapItemsDdl,
} from "../ddl.mjs";
import { ACTIVE_JOB_PREDICATE } from "../schema.mjs";
import { isBusyError, rollbackQuietly, sleepSync, withWriteRetry } from "../tx.mjs";
import { importLegacyRegistry, stripLegacyConfig } from "./legacy-config.mjs";
import { bringToV17, keepSequence, sequenceOf } from "./legacy.mjs";
import { moveRunsToIds } from "./runs-by-id.mjs";

export { hasLegacyRegistry, importLegacyRegistry, readV17Registry } from "./legacy-config.mjs";

// The one-shot, version-gated migration of a v17 (or older) database to v18: names become ids. Nothing is written unless
// the whole of it commits, and a byte copy of the database taken right before stays beside it as `nightqueue.db.pre-v18`.

export const V18 = 18;
const COPY_ATTEMPTS = 10;
const RETRY_PAUSE_MS = 50;

// The data tables re-created with id columns as `{ table, ddl(name) }`, each stage adding its own, in the order they are rebuilt.
export const REBUILT_TABLES = Object.freeze([
  { table: "lessons", ddl: lessonsDdl },
  { table: "memory", ddl: memoryDdl },
  { table: "project_index", ddl: projectIndexDdl },
  { table: "project_libs", ddl: projectLibsDdl },
  { table: "pipeline_runs", ddl: pipelineRunsDdl },
  { table: "jobs", ddl: jobsDdl },
  { table: "decisions", ddl: decisionsDdl },
  { table: "roadmap_items", ddl: roadmapItemsDdl },
  { table: "roadmap_item_projects", ddl: roadmapItemProjectsDdl },
  { table: "roadmap_comments", ddl: roadmapCommentsDdl },
]);

// The refusal a live lease causes: exactly one line, never wrapped, because only stopping the runners fixes it.
export class MigrationRefused extends UserError {}

// The schema version the connection reports.
function userVersion(db) {
  return db.prepare("PRAGMA user_version").get()?.user_version ?? 0;
}

// Tells whether a table exists in the schema.
function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// Where the database stands: `current` at v18 or later, `legacy` below it with data tables, `fresh` with none.
export function schemaState(db) {
  if (userVersion(db) >= V18) return "current";
  return DATA_TABLES.some((table) => hasTable(db, table)) ? "legacy" : "fresh";
}

// Runs a file tool in a child process. The database file is only ever opened by another process: a POSIX lock belongs to the
// process, and closing any descriptor of the file in this one would silently drop the locks its SQLite connections hold.
function fileTool(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) throw result.error;
  return result;
}

// Tells whether the copy is the whole database as it stands under the write lock: no log beside the file, and the same bytes.
function copyIsCurrent(env, tmp) {
  const wal = statSync(`${dbPath(env)}-wal`, { throwIfNoEntry: false });
  if (wal && wal.size > 0) return false;
  return fileTool("cmp", ["-s", dbPath(env), tmp]).status === 0;
}

// Refuses the migration while a runner holds a live lease, naming the job; a crashed runner's expired lease does not block it.
function refuseLiveLease(db) {
  if (!hasTable(db, "jobs")) return;
  const live = db.prepare(`SELECT slot.id FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE} LIMIT 1`).get();
  if (!live) return;
  throw new MigrationRefused(
    `the database must migrate to v18, but a runner holds a live lease on job #${live.id}: stop the runners (\`nightqueue queue run --stop\`) and run the command again`,
  );
}

// Folds the write-ahead log into the database file so the file alone is the whole database; false when a reader kept it busy.
function walFolded(db) {
  if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") return true;
  try {
    return db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy === 0;
  } catch (err) {
    if (isBusyError(err)) return false;
    throw err;
  }
}

// Copies the database file to a private temporary name and flushes it to disk; published only once the lock proves it current.
function copyDatabase(env) {
  const tmp = `${preV18BackupPath(env)}.${process.pid}.tmp`;
  try {
    const copied = fileTool("cp", [dbPath(env), tmp]);
    if (copied.status !== 0) throw new Error(copied.stderr.trim() || `cp exited ${copied.status}`);
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tmp;
  } catch (err) {
    rmSync(tmp, { force: true });
    throw new UserError(`could not copy the database to ${tmp} before migrating it to v18: ${err?.message ?? err}; nothing was written`);
  }
}

// The verdict of the checks made once the write lock is held: another process migrated it, wrote after the copy, or it may go.
function verdictUnderLock(db, env, tmp) {
  if (schemaState(db) !== "legacy") return "skipped";
  if (!copyIsCurrent(env, tmp)) return "retry";
  refuseLiveLease(db);
  return "go";
}

// Rebuilds one data table with its id columns: same rows, same ids, the AUTOINCREMENT counter kept.
function rebuildTable(db, table, ddl) {
  const sequence = sequenceOf(db, table);
  const before = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  db.exec(`DROP TABLE IF EXISTS ${table}_v18`);
  db.exec(ddl(`${table}_v18`));
  const copied = copyRows(db, table);
  if (copied !== before) throw new UserError(`${table}: copied ${copied} of ${before} rows`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_v18 RENAME TO ${table}`);
  keepSequence(db, table, sequence);
}

// How a v17 table's rows read in v18 terms: every v18 column as an expression over `t`, the owner names joined to their ids.
function v18Projection(db, table) {
  const target = db.prepare(`PRAGMA table_info(${table}_v18)`).all().map((column) => column.name);
  const source = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const mapped = (column) => (column === "project_id" || column === "org_id") && !source.has(column);
  const plain = target.filter((column) => !mapped(column));
  const missing = plain.filter((column) => !source.has(column));
  if (missing.length) throw new UserError(`${table}: the v18 column(s) ${missing.join(", ")} have no v17 source`);
  refuseUnmappable(db, table, source);
  const values = new Map(plain.map((column) => [column, `t.${column}`]));
  const joins = [];
  if (target.includes("project_id") && mapped("project_id")) {
    values.set("project_id", "p.id");
    joins.push("LEFT JOIN projects AS p ON p.name = t.project");
  }
  if (target.includes("org_id") && mapped("org_id")) {
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

// Copies every row of a v17 table into its v18 twin, mapping the owner names to ids, and answers how many landed.
function copyRows(db, table) {
  const projection = v18Projection(db, table);
  refuseOwnerConflict(db, table, projection);
  const columns = [...projection.values.keys()].join(", ");
  const values = [...projection.values.values()].join(", ");
  db.exec(`INSERT INTO ${table}_v18 (${columns}) SELECT ${values} ${projection.from}`);
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}_v18`).get().n;
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

// How many rows break a foreign key right now.
function foreignKeyViolations(db) {
  return db.prepare("PRAGMA foreign_key_check").all().length;
}

// Creates every index, trigger and lexical mirror of the current schema, re-indexes the mirrors and stamps v18.
function finishSchema(db, violationsBefore) {
  db.exec(INDEXES);
  db.exec(ROADMAP_COMMENT_GUARDS);
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
  db.exec(REGISTRY);
  importLegacyRegistry(db, loadRawConfig(env));
  const violationsBefore = foreignKeyViolations(db);
  for (const { table, ddl } of REBUILT_TABLES) {
    progress.step = table;
    rebuildTable(db, table, ddl);
    hooks.afterTable?.(table);
  }
  progress.step = "indexes";
  finishSchema(db, violationsBefore);
}

// The failure of a migration that rolled back, saying where and that nothing changed.
function failureOf(err, { step, version, env }) {
  if (err instanceof MigrationRefused) return err;
  const detail = err?.message ?? String(err);
  return new UserError(
    `migration to v18 failed at ${step}: ${detail}; nothing was written, the database is still at v${version} (a copy is at ${preV18BackupPath(env)})`,
  );
}

// One attempt at the transaction over a copy already taken: `done`, `skipped` (a racer migrated it) or `retry` (a racer wrote).
function migrateFromCopy(db, env, { tmp, hooks }) {
  db.exec("PRAGMA foreign_keys = OFF");
  const progress = { step: "gate", version: userVersion(db) };
  try {
    withWriteRetry(() => db.exec("BEGIN IMMEDIATE"));
    try {
      const verdict = verdictUnderLock(db, env, tmp);
      if (verdict !== "go") {
        rollbackQuietly(db);
        return verdict;
      }
      progress.version = userVersion(db);
      renameSync(tmp, preV18BackupPath(env));
      migrateInside(db, env, { hooks, progress });
      db.exec("COMMIT");
    } catch (err) {
      rollbackQuietly(db);
      throw failureOf(err, { ...progress, env });
    }
  } finally {
    rmSync(tmp, { force: true });
    db.exec("PRAGMA foreign_keys = ON");
  }
  hooks.afterCommit?.();
  return "done";
}

// Waits until no other connection holds the write lock, so a racer already migrating is let finish before the gate is read again.
function waitForWriters(db) {
  withWriteRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
  });
}

// Migrates a legacy database to v18 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV18(db, env, { afterTable, afterCommit } = {}) {
  const hooks = { afterTable, afterCommit };
  for (let attempt = 0; attempt < COPY_ATTEMPTS; attempt += 1) {
    waitForWriters(db);
    if (schemaState(db) !== "legacy") return false;
    refuseLiveLease(db);
    if (!walFolded(db)) {
      sleepSync(RETRY_PAUSE_MS);
      continue;
    }
    const outcome = migrateFromCopy(db, env, { tmp: copyDatabase(env), hooks });
    if (outcome === "done") return true;
    if (outcome === "skipped") return false;
  }
  if (schemaState(db) !== "legacy") return false;
  throw new UserError("could not migrate the database to v18: another process kept writing to it; nothing was written, run the command again");
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
