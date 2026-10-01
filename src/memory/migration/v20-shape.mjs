import {
  COMMENT_KINDS,
  DEFAULT_ISSUE_TYPE,
  OPERATOR_AUTHOR,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  sqlList,
} from "../issue-workflow.mjs";

// The frozen v20 shapes of the tracker tables, under their pre-v21 names: the v18, v19 and v20 migrations build them, and v21
// renames them.

const ROADMAP_TYPE_COLUMN = `TEXT NOT NULL DEFAULT '${DEFAULT_ISSUE_TYPE}' CHECK(type IN (${sqlList(ISSUE_TYPES)}))`;

const PROJECT_ID = "project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT";
const REQUIRED_PROJECT_ID = "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT";
const ORG_ID = "org_id TEXT REFERENCES orgs(id) ON DELETE RESTRICT";
const SCOPE_COLUMN = "scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))";
const OWNER_CHECK = "(scope = 'project' AND org_id IS NULL) OR (scope = 'org' AND org_id IS NOT NULL AND project_id IS NULL)";

// The v20 comment thread under a given name.
export function roadmapCommentsDdlV20(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(COMMENT_KINDS)})),
  author TEXT NOT NULL CHECK(author = '${OPERATOR_AUTHOR}' OR author GLOB 'job:[0-9]*'),
  body TEXT NOT NULL,
  refs TEXT CHECK(refs IS NULL OR json_valid(refs)),
  ${PROJECT_ID},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
}

// The v20 append-only guards of the comment thread.
export const ROADMAP_COMMENT_GUARDS_V20 = `
CREATE TRIGGER IF NOT EXISTS roadmap_comments_no_update BEFORE UPDATE ON roadmap_comments BEGIN
  SELECT RAISE(ABORT, 'roadmap comments are append-only');
END;
CREATE TRIGGER IF NOT EXISTS roadmap_comments_no_delete BEFORE DELETE ON roadmap_comments
WHEN EXISTS (SELECT 1 FROM roadmap_items WHERE id = OLD.item_id) BEGIN
  SELECT RAISE(ABORT, 'roadmap comments are append-only');
END;
`;

// The v20 per-project rows of an org item under a given name.
export function roadmapItemProjectsDdlV20(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES roadmap_items(id) ON DELETE CASCADE,
  ${REQUIRED_PROJECT_ID},
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN (${sqlList(ISSUE_STATUSES)})),
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  job_status_seen TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, project_id)
);`;
}

// The v20 lexical mirrors of the tracker tables.
export const ROADMAP_FTS_V20 = `
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
CREATE TRIGGER IF NOT EXISTS roadmap_comments_fts_ad AFTER DELETE ON roadmap_comments BEGIN
  INSERT INTO roadmap_comments_fts(roadmap_comments_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
`;

// The v20 `roadmap_items` table under a given name.
export function roadmapItemsDdlV20(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${SCOPE_COLUMN},
  ${PROJECT_ID},
  ${ORG_ID},
  number INTEGER NOT NULL CHECK(number > 0),
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN (${sqlList(ISSUE_STATUSES)})),
  priority INTEGER NOT NULL DEFAULT 5 CHECK(priority BETWEEN 1 AND 9),
  type ${ROADMAP_TYPE_COLUMN},
  position INTEGER NOT NULL,
  decision_id INTEGER REFERENCES decisions(id) ON DELETE SET NULL,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  job_status_seen TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(${OWNER_CHECK})
);`;
}

// The v20 data tables that own rows by project or org, the ones whose presence tells a database that already holds data.
export const DATA_TABLES_V20 = Object.freeze([
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

// The v20 lexical mirrors a rebuilt content table needs indexed again.
export const FTS_MIRRORS_V20 = Object.freeze(["lessons_fts", "memory_fts", "decisions_fts", "roadmap_items_fts", "roadmap_comments_fts"]);

// The v20 indexes of every table.
export const INDEXES_V20 = `
CREATE INDEX IF NOT EXISTS lessons_recall_idx ON lessons(archived, project_id, created_at);
CREATE INDEX IF NOT EXISTS lessons_embedding_idx ON lessons(embedding_model);
CREATE INDEX IF NOT EXISTS memory_project_idx ON memory(project_id, created_at);
CREATE INDEX IF NOT EXISTS project_index_project_idx ON project_index(project_id, updated_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_project_idx ON pipeline_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_phases_run_idx ON pipeline_phases(run_id, seq);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_project_slug_idx ON jobs(project_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_number_idx ON decisions(project_id, number);
CREATE INDEX IF NOT EXISTS roadmap_items_order_idx ON roadmap_items(scope, project_id, org_id, priority, position);
CREATE INDEX IF NOT EXISTS roadmap_items_job_idx ON roadmap_items(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_number_idx ON decisions(org_id, number) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS roadmap_items_org_order_idx ON roadmap_items(org_id, priority, position) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS decisions_job_idx ON decisions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS roadmap_comments_item_idx ON roadmap_comments(item_id, id);
CREATE INDEX IF NOT EXISTS roadmap_item_projects_job_idx ON roadmap_item_projects(job_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_job_idx ON pipeline_runs(job_id);
CREATE INDEX IF NOT EXISTS roadmap_items_decision_idx ON roadmap_items(decision_id);
CREATE INDEX IF NOT EXISTS decisions_superseded_idx ON decisions(superseded_by);
`;

// The v20 columns that hold another row's id with a foreign key, as `{ table, column, parent }`; the v20 migration checks them.
export const REFERENCED_COLUMNS_V20 = Object.freeze([
  { table: "roadmap_comments", column: "item_id", parent: "roadmap_items" },
  { table: "roadmap_item_projects", column: "item_id", parent: "roadmap_items" },
  { table: "roadmap_item_projects", column: "job_id", parent: "jobs" },
  { table: "roadmap_items", column: "job_id", parent: "jobs" },
  { table: "roadmap_items", column: "decision_id", parent: "decisions" },
  { table: "decisions", column: "job_id", parent: "jobs" },
  { table: "decisions", column: "superseded_by", parent: "decisions" },
  { table: "pipeline_runs", column: "job_id", parent: "jobs" },
]);

// The v20 per-owner uniqueness of item numbers.
export const ROADMAP_NUMBER_INDEXES_V20 = `
CREATE UNIQUE INDEX IF NOT EXISTS roadmap_items_number_idx ON roadmap_items(project_id, number) WHERE scope = 'project';
CREATE UNIQUE INDEX IF NOT EXISTS roadmap_items_org_number_idx ON roadmap_items(org_id, number) WHERE scope = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS roadmap_items_global_number_idx ON roadmap_items(number) WHERE scope = 'project' AND project_id IS NULL;
`;
