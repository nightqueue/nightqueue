import {
  COMMENT_KINDS,
  DEFAULT_ROADMAP_TYPE,
  OPERATOR_AUTHOR,
  ROADMAP_STATUSES,
  ROADMAP_TYPES,
  sqlList,
} from "./roadmap-workflow.mjs";
import { CLOSED_REQUIRES_MERGE } from "./schema.mjs";

// The current schema of the memory database: one source for a fresh creation and for the v18 migration.

const ROADMAP_TYPE_COLUMN = `TEXT NOT NULL DEFAULT '${DEFAULT_ROADMAP_TYPE}' CHECK(type IN (${sqlList(ROADMAP_TYPES)}))`;

// The append-only comment thread of the roadmap items: triggers refuse every UPDATE and DELETE.
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

// The per-project rows of an org item: one per project it was queued for, each linked to that project's job.
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

// The lexical mirrors of the roadmap: item title and detail follow every write, comments are append-only so only inserts.
export const ROADMAP_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS roadmap_items_fts USING fts5(
  title, detail,
  content='roadmap_items', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS roadmap_items_fts_ai AFTER INSERT ON roadmap_items BEGIN
  INSERT INTO roadmap_items_fts(rowid, title, detail) VALUES (new.id, new.title, new.detail);
END;
CREATE TRIGGER IF NOT EXISTS roadmap_items_fts_ad AFTER DELETE ON roadmap_items BEGIN
  INSERT INTO roadmap_items_fts(roadmap_items_fts, rowid, title, detail) VALUES ('delete', old.id, old.title, old.detail);
END;
CREATE TRIGGER IF NOT EXISTS roadmap_items_fts_au AFTER UPDATE OF title, detail ON roadmap_items BEGIN
  INSERT INTO roadmap_items_fts(roadmap_items_fts, rowid, title, detail) VALUES ('delete', old.id, old.title, old.detail);
  INSERT INTO roadmap_items_fts(rowid, title, detail) VALUES (new.id, new.title, new.detail);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS roadmap_comments_fts USING fts5(
  body,
  content='roadmap_comments', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS roadmap_comments_fts_ai AFTER INSERT ON roadmap_comments BEGIN
  INSERT INTO roadmap_comments_fts(rowid, body) VALUES (new.id, new.body);
END;
`;

// The `roadmap_items` table under a given name.
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

// The registry of orgs and projects: the only place a name lives, every other table owns rows by id.
export const REGISTRY = `
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 26),
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 26),
  name TEXT NOT NULL UNIQUE,
  path TEXT UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(org_id);
`;

// The data tables that own rows by project or org, the ones whose presence tells a database that already holds data.
export const DATA_TABLES = Object.freeze([
  "lessons",
  "memory",
  "project_index",
  "project_libs",
  "pipeline_runs",
  "jobs",
  "decisions",
  "roadmap_items",
  "roadmap_item_projects",
  "roadmap_comments",
]);

// The lexical mirrors a rebuilt content table needs indexed again.
export const FTS_MIRRORS = Object.freeze(["lessons_fts", "memory_fts", "decisions_fts", "roadmap_items_fts", "roadmap_comments_fts"]);

const PROJECT_ID = "project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT";
const REQUIRED_PROJECT_ID = "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT";

// The `lessons` table under a given name: owned by a project id, NULL for a global lesson.
export function lessonsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${PROJECT_ID},
  title TEXT NOT NULL,
  root_cause TEXT NOT NULL,
  solution TEXT NOT NULL,
  prevention TEXT NOT NULL,
  attempts INTEGER,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  target TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  archive_reason TEXT,
  injected INTEGER NOT NULL DEFAULT 0,
  last_injected_at TEXT,
  violated INTEGER NOT NULL DEFAULT 0,
  last_violated_at TEXT,
  last_recurred_at TEXT,
  embedding BLOB,
  embedding_model TEXT
);`;
}

// The `memory` table under a given name: owned by a project id, NULL for a global fact.
export function memoryDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${PROJECT_ID},
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  embedding_model TEXT
);`;
}

// The `project_index` table under a given name: one row per file of a project.
export function projectIndexDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${REQUIRED_PROJECT_ID},
  path TEXT NOT NULL,
  responsibility TEXT NOT NULL,
  mtime_ms INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, path)
);`;
}

// The `project_libs` table under a given name: one row per library of a project.
export function projectLibsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${REQUIRED_PROJECT_ID},
  lib TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, lib)
);`;
}

// The `pipeline_runs` table under a given name: the telemetry of one /resolve run.
export function pipelineRunsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${PROJECT_ID},
  slug TEXT NOT NULL,
  tier TEXT NOT NULL,
  task_type TEXT,
  outcome TEXT NOT NULL,
  gate_stop TEXT,
  duration_s INTEGER,
  model TEXT,
  session_id TEXT,
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  tier_operator TEXT,
  tier_raise_reason TEXT
);`;
}

// The `jobs` table under a given name: the queue, every job owned by a project id, a closed job always carrying its merge.
export function jobsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${REQUIRED_PROJECT_ID},
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
  finished_at TEXT,
  tier TEXT,
  not_before TEXT,
  blocked_code TEXT,
  last_session_id TEXT,
  last_session_attempt INTEGER,
  bash_timeouts INTEGER,
  tasks_backgrounded INTEGER,
  tasks_killed INTEGER,
  baseline_ctx INTEGER,
  orch_turns INTEGER,
  orch_reads INTEGER,
  orch_bash INTEGER,
  orch_bash_explore INTEGER,
  orch_ctx_last INTEGER,
  close_status TEXT CHECK(close_status IN ('closing','failed')),
  close TEXT,
  close_lease_until TEXT,
  close_worker TEXT,
  ${CLOSED_REQUIRES_MERGE}
);`;
}

export const SCHEMA = `
${lessonsDdl("lessons")}
${memoryDdl("memory")}
${projectIndexDdl("project_index")}
${projectLibsDdl("project_libs")}
${pipelineRunsDdl("pipeline_runs")}
${jobsDdl("jobs")}
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

export const EVOLVING_COLUMNS = [
  ["decisions", "scope", "TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))"],
  ["decisions", "org", "TEXT"],
  ["decisions", "job_id", "INTEGER"],
  ["roadmap_items", "scope", "TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))"],
  ["roadmap_items", "org", "TEXT"],
  ["roadmap_items", "type", ROADMAP_TYPE_COLUMN],
];

export const INDEXES = `
CREATE INDEX IF NOT EXISTS lessons_recall_idx ON lessons(archived, project_id, created_at);
CREATE INDEX IF NOT EXISTS lessons_embedding_idx ON lessons(embedding_model);
CREATE INDEX IF NOT EXISTS memory_project_idx ON memory(project_id, created_at);
CREATE INDEX IF NOT EXISTS project_index_project_idx ON project_index(project_id, updated_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_project_idx ON pipeline_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_phases_run_idx ON pipeline_phases(run_id, seq);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_project_slug_idx ON jobs(project_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_number_idx ON decisions(project, number);
CREATE INDEX IF NOT EXISTS roadmap_items_order_idx ON roadmap_items(scope, project, org, priority, position);
CREATE INDEX IF NOT EXISTS roadmap_items_job_idx ON roadmap_items(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_number_idx ON decisions(org, number) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS roadmap_items_org_order_idx ON roadmap_items(org, priority, position) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS decisions_job_idx ON decisions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS roadmap_comments_item_idx ON roadmap_comments(item_id, id);
CREATE INDEX IF NOT EXISTS roadmap_item_projects_job_idx ON roadmap_item_projects(job_id);
`;

export const FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
  title, root_cause, solution, prevention,
  content='lessons', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS lessons_fts_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, title, root_cause, solution, prevention)
  VALUES (new.id, new.title, new.root_cause, new.solution, new.prevention);
END;
CREATE TRIGGER IF NOT EXISTS lessons_fts_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, title, root_cause, solution, prevention)
  VALUES ('delete', old.id, old.title, old.root_cause, old.solution, old.prevention);
END;
CREATE TRIGGER IF NOT EXISTS lessons_fts_au AFTER UPDATE OF title, root_cause, solution, prevention ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, title, root_cause, solution, prevention)
  VALUES ('delete', old.id, old.title, old.root_cause, old.solution, old.prevention);
  INSERT INTO lessons_fts(rowid, title, root_cause, solution, prevention)
  VALUES (new.id, new.title, new.root_cause, new.solution, new.prevention);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  key, value,
  content='memory', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS memory_fts_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_ad AFTER DELETE ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
END;
CREATE TRIGGER IF NOT EXISTS memory_fts_au AFTER UPDATE OF key, value ON memory BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, key, value) VALUES ('delete', old.id, old.key, old.value);
  INSERT INTO memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  title, context, decision, consequences,
  content='decisions', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS decisions_fts_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, title, context, decision, consequences)
  VALUES (new.id, new.title, new.context, new.decision, new.consequences);
END;
CREATE TRIGGER IF NOT EXISTS decisions_fts_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, context, decision, consequences)
  VALUES ('delete', old.id, old.title, old.context, old.decision, old.consequences);
END;
CREATE TRIGGER IF NOT EXISTS decisions_fts_au AFTER UPDATE OF title, context, decision, consequences ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, title, context, decision, consequences)
  VALUES ('delete', old.id, old.title, old.context, old.decision, old.consequences);
  INSERT INTO decisions_fts(rowid, title, context, decision, consequences)
  VALUES (new.id, new.title, new.context, new.decision, new.consequences);
END;
`;
