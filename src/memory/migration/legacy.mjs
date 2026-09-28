import { addColumnIfMissing, dropColumnIfPresent } from "../columns.mjs";
import {
  COMMENT_KINDS,
  DEFAULT_ROADMAP_TYPE,
  LIVE_JOB_STATUSES,
  OPERATOR_AUTHOR,
  ROADMAP_STATUSES,
  ROADMAP_TYPES,
  legacyStatusSql,
  sqlList,
} from "../roadmap-workflow.mjs";
import { carriesOperatorSeed } from "../shared-slug-migration.mjs";
import { closeMigrationPending, migrateCloseColumns } from "./close-columns.mjs";

// The frozen v17 schema and the steps that brought any older database to it, in the order the v17 build ran them.
// Nothing here follows the live schema: a v17 database is read by name, and only the v18 migration reads it.

const ROADMAP_TYPE_COLUMN = `TEXT NOT NULL DEFAULT '${DEFAULT_ROADMAP_TYPE}' CHECK(type IN (${sqlList(ROADMAP_TYPES)}))`;

const ROADMAP_COMMENTS = `
CREATE TABLE IF NOT EXISTS roadmap_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(COMMENT_KINDS)})),
  author TEXT NOT NULL CHECK(author = '${OPERATOR_AUTHOR}' OR author GLOB 'job:[0-9]*'),
  body TEXT NOT NULL,
  refs TEXT CHECK(refs IS NULL OR json_valid(refs)),
  project TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS roadmap_comments_no_update BEFORE UPDATE ON roadmap_comments BEGIN
  SELECT RAISE(ABORT, 'roadmap comments are append-only');
END;
CREATE TRIGGER IF NOT EXISTS roadmap_comments_no_delete BEFORE DELETE ON roadmap_comments BEGIN
  SELECT RAISE(ABORT, 'roadmap comments are append-only');
END;
`;

const ROADMAP_ITEM_PROJECTS = `
CREATE TABLE IF NOT EXISTS roadmap_item_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  project TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN (${sqlList(ROADMAP_STATUSES)})),
  job_id INTEGER,
  job_status_seen TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, project)
);
`;

// The v17 `roadmap_items` table under a given name, shared by the base schema and the rebuild of a v16 table.
function roadmapItemsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org')),
  project TEXT,
  org TEXT,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN (${sqlList(ROADMAP_STATUSES)})),
  priority INTEGER NOT NULL DEFAULT 5 CHECK(priority BETWEEN 1 AND 9),
  type ${ROADMAP_TYPE_COLUMN},
  position INTEGER NOT NULL,
  decision_id INTEGER,
  job_id INTEGER,
  job_status_seen TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
}

const V17_SCHEMA = `
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  title TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  solution TEXT NOT NULL,
  prevention TEXT NOT NULL,
  attempts INTEGER,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS project_index (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  path TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  mtime_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project, path)
);
CREATE TABLE IF NOT EXISTS project_libs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  lib TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project, lib)
);
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  slug TEXT NOT NULL,
  tier TEXT NOT NULL,
  task_type TEXT,
  outcome TEXT NOT NULL,
  gate_stop TEXT,
  duration_s INTEGER,
  model TEXT,
  session_id TEXT,
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  prompt TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 1,
  timeout_s INTEGER NOT NULL DEFAULT 14400,
  lease_until TEXT,
  worker TEXT,
  session_id TEXT,
  slug TEXT,
  branch TEXT,
  pr_url TEXT,
  notice_md TEXT,
  result TEXT,
  operator_note TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_creation INTEGER,
  cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS pipeline_phases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  phase TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  retry INTEGER NOT NULL DEFAULT 0,
  duration_s INTEGER,
  note TEXT,
  FOREIGN KEY (run_id) REFERENCES pipeline_runs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  number INTEGER,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  consequences TEXT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('proposed','accepted','superseded','rejected')),
  superseded_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  embedding_model TEXT
);
${roadmapItemsDdl("roadmap_items")}
${ROADMAP_COMMENTS}
${ROADMAP_ITEM_PROJECTS}
`;

const V17_EVOLVING_COLUMNS = [
  ["lessons", "target", "TEXT"],
  ["lessons", "archived", "INTEGER NOT NULL DEFAULT 0"],
  ["lessons", "archive_reason", "TEXT"],
  ["lessons", "injected", "INTEGER NOT NULL DEFAULT 0"],
  ["lessons", "last_injected_at", "TEXT"],
  ["lessons", "violated", "INTEGER NOT NULL DEFAULT 0"],
  ["lessons", "last_violated_at", "TEXT"],
  ["lessons", "last_recurred_at", "TEXT"],
  ["lessons", "embedding", "BLOB"],
  ["lessons", "embedding_model", "TEXT"],
  ["memory", "embedding", "BLOB"],
  ["memory", "embedding_model", "TEXT"],
  ["jobs", "tier", "TEXT"],
  ["jobs", "not_before", "TEXT"],
  ["jobs", "blocked_code", "TEXT"],
  ["jobs", "last_session_id", "TEXT"],
  ["jobs", "last_session_attempt", "INTEGER"],
  ["jobs", "bash_timeouts", "INTEGER"],
  ["jobs", "tasks_backgrounded", "INTEGER"],
  ["jobs", "tasks_killed", "INTEGER"],
  ["jobs", "baseline_ctx", "INTEGER"],
  ["jobs", "orch_turns", "INTEGER"],
  ["jobs", "orch_reads", "INTEGER"],
  ["jobs", "orch_bash", "INTEGER"],
  ["jobs", "orch_bash_explore", "INTEGER"],
  ["jobs", "orch_ctx_last", "INTEGER"],
  ["pipeline_runs", "tier_operator", "TEXT"],
  ["pipeline_runs", "tier_raise_reason", "TEXT"],
  ["decisions", "scope", "TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))"],
  ["decisions", "org", "TEXT"],
  ["decisions", "job_id", "INTEGER"],
  ["roadmap_items", "scope", "TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))"],
  ["roadmap_items", "org", "TEXT"],
  ["roadmap_items", "type", ROADMAP_TYPE_COLUMN],
];

const V17_DROPPED_JOB_COLUMNS = ["pr_checked_at", "merged_at", "merge_sha"];

const V17_RESULT_OBJECT_BASE = `CASE
              WHEN result IS NULL THEN '{}'
              WHEN json_valid(result) AND json_type(result) = 'object' THEN result
              ELSE json_object('previousResult', result) END`;

const SHARED_GROUPS = `SELECT project, slug FROM jobs
   WHERE slug IS NOT NULL
   GROUP BY project, slug
  HAVING COUNT(*) > 1`;

const GROUP_PROMPTS = "SELECT prompt FROM jobs WHERE project = ? AND slug = ?";

const DETACH_ROW = `UPDATE jobs
    SET slug = NULL,
        branch = CASE WHEN branch = ? THEN NULL ELSE branch END,
        pr_url = CASE WHEN pr_url = ? AND status NOT IN ('done', 'closed') THEN NULL ELSE pr_url END,
        result = CASE WHEN pr_url = ? AND status NOT IN ('done', 'closed')
          THEN json_set(${V17_RESULT_OBJECT_BASE}, '$.runSlugDetached', slug, '$.runSlugKeptBy', CAST(? AS INTEGER), '$.prUrlDetached', pr_url)
          ELSE json_set(${V17_RESULT_OBJECT_BASE}, '$.runSlugDetached', slug, '$.runSlugKeptBy', CAST(? AS INTEGER)) END
  WHERE id = ? AND project = ? AND slug = ?`;

// The (project, slug) groups shared by several jobs, none of which was seeded from an operator run.
function pendingGroups(db) {
  const prompts = db.prepare(GROUP_PROMPTS);
  return db
    .prepare(SHARED_GROUPS)
    .all()
    .filter((group) => !prompts.all(group.project, group.slug).some((row) => carriesOperatorSeed(row.prompt)));
}

// The job that keeps a shared run: the one its pipeline run points at when exactly one does, the oldest otherwise.
function keeperOf(db, { project, slug }) {
  const linked = db
    .prepare(
      `SELECT DISTINCT j.id FROM jobs AS j JOIN pipeline_runs AS r ON r.job_id = j.id AND r.project = j.project AND r.slug = j.slug
        WHERE j.project = ? AND j.slug = ?`,
    )
    .all(project, slug);
  if (linked.length === 1) return Number(linked[0].id);
  return Number(db.prepare("SELECT MIN(id) AS id FROM jobs WHERE project = ? AND slug = ?").get(project, slug).id);
}

// Detaches every job of one shared run but its keeper, recording in each detached row what it lost.
function detachGroup(db, group) {
  const keeperId = keeperOf(db, group);
  const keeper = db.prepare("SELECT branch, pr_url FROM jobs WHERE id = ?").get(keeperId);
  const others = db.prepare("SELECT id FROM jobs WHERE project = ? AND slug = ? AND id <> ?").all(group.project, group.slug, keeperId);
  const detach = db.prepare(DETACH_ROW);
  for (const { id } of others) {
    detach.run(keeper.branch, keeper.pr_url, keeper.pr_url, keeperId, keeperId, id, group.project, group.slug);
  }
}

// Gives every run slug shared by several jobs back to one of them, by project name; a no-op once done.
function migrateSharedSlugsByName(db) {
  for (const group of pendingGroups(db)) detachGroup(db, group);
}

const V17_BUMPED_ITEMS = Object.freeze({ project: "nightqueue", ids: [9, 36], priority: 3 });

// Tells whether `roadmap_items` still has the v16 shape, the one with a `horizon` column.
function hasLegacyRoadmapItems(db) {
  return db.prepare("PRAGMA table_info(roadmap_items)").all().some((column) => column.name === "horizon");
}

// Copies every v16 roadmap row into the v17 table: the legacy status map, `closed_at` on `done` only, priority 5 (the bumped
// nightqueue items excepted), positions renumbered per owner and priority, and the job status the item already reflects.
function copyLegacyRoadmapItems(db) {
  const bumped = `r.id IN (${V17_BUMPED_ITEMS.ids.join(", ")}) AND r.scope = 'project' AND r.project = '${V17_BUMPED_ITEMS.project}'`;
  db.exec(`INSERT INTO roadmap_items_v17
      (id, scope, project, org, title, detail, status, priority, position, decision_id, job_id, job_status_seen, closed_at, created_at, updated_at)
    SELECT id, scope, project, org, title, detail, status, priority,
           ROW_NUMBER() OVER (PARTITION BY scope, project, org, priority ORDER BY horizon_rank, position, id),
           decision_id, job_id, job_status_seen, closed_at, created_at, updated_at
      FROM (SELECT r.id, r.scope, r.project, r.org, r.title, r.detail, r.position, r.decision_id, r.job_id,
                   r.created_at, r.updated_at,
                   ${legacyStatusSql("r")} AS status,
                   CASE WHEN ${bumped} THEN ${V17_BUMPED_ITEMS.priority} ELSE 5 END AS priority,
                   CASE r.horizon WHEN 'now' THEN 0 WHEN 'next' THEN 1 ELSE 2 END AS horizon_rank,
                   CASE WHEN r.status = 'queued' AND (j.status IS NULL OR j.status NOT IN (${sqlList(LIVE_JOB_STATUSES)}))
                        THEN NULL ELSE j.status END AS job_status_seen,
                   CASE WHEN r.status = 'done' THEN r.updated_at END AS closed_at
              FROM roadmap_items r LEFT JOIN jobs j ON j.id = r.job_id)`);
}

// Restores the AUTOINCREMENT counter of a rebuilt table to at least what the old table had reached.
export function keepSequence(db, table, sequence) {
  db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(sequence, table);
  db.prepare(
    "INSERT INTO sqlite_sequence (name, seq) SELECT ?, ? WHERE ? > 0 AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = ?)",
  ).run(table, sequence, sequence, table);
}

// The AUTOINCREMENT counter a table has reached, 0 when it never handed out an id.
export function sequenceOf(db, table) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq ?? 0;
}

// Rebuilds a v16 `roadmap_items` into the v17 shape, inside the caller's transaction.
function rebuildLegacyRoadmapItems(db) {
  if (!hasLegacyRoadmapItems(db)) return;
  const sequence = sequenceOf(db, "roadmap_items");
  db.exec("DROP TABLE IF EXISTS roadmap_items_v17");
  db.exec(roadmapItemsDdl("roadmap_items_v17"));
  copyLegacyRoadmapItems(db);
  db.exec("DROP TABLE roadmap_items");
  db.exec("ALTER TABLE roadmap_items_v17 RENAME TO roadmap_items");
  keepSequence(db, "roadmap_items", sequence);
}

// Brings any older database to the v17 shape inside the caller's transaction, in the order the v17 build migrated it.
export function bringToV17(db) {
  db.exec(V17_SCHEMA);
  for (const [table, column, definition] of V17_EVOLVING_COLUMNS) addColumnIfMissing(db, table, column, definition);
  for (const column of V17_DROPPED_JOB_COLUMNS) dropColumnIfPresent(db, "jobs", column);
  if (closeMigrationPending(db)) migrateCloseColumns(db);
  migrateSharedSlugsByName(db);
  rebuildLegacyRoadmapItems(db);
}
