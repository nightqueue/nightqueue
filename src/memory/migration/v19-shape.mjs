import {
  COMMENT_KINDS,
  DEFAULT_ISSUE_TYPE,
  OPERATOR_AUTHOR,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  sqlList,
} from "./tracker-shape.mjs";

// The frozen v19 shapes of the DDLs v20 changed: only the v18 and v19 migrations build them, so they never reach a v20 foreign key.

const ROADMAP_TYPE_COLUMN = `TEXT NOT NULL DEFAULT '${DEFAULT_ISSUE_TYPE}' CHECK(type IN (${sqlList(ISSUE_TYPES)}))`;

const PROJECT_ID = "project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT";
const REQUIRED_PROJECT_ID = "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT";
const ORG_ID = "org_id TEXT REFERENCES orgs(id) ON DELETE RESTRICT";
const SCOPE_COLUMN = "scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))";
const OWNER_CHECK = "(scope = 'project' AND org_id IS NULL) OR (scope = 'org' AND org_id IS NOT NULL AND project_id IS NULL)";

// The v19 comment thread under a given name: `item_id` with no foreign key.
export function roadmapCommentsDdlV19(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(COMMENT_KINDS)})),
  author TEXT NOT NULL CHECK(author = '${OPERATOR_AUTHOR}' OR author GLOB 'job:[0-9]*'),
  body TEXT NOT NULL,
  refs TEXT CHECK(refs IS NULL OR json_valid(refs)),
  ${PROJECT_ID},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
}

// The v19 append-only guards of the comment thread: every UPDATE and DELETE is refused.
export const ROADMAP_COMMENT_GUARDS_V19 = `
CREATE TRIGGER IF NOT EXISTS roadmap_comments_no_update BEFORE UPDATE ON roadmap_comments BEGIN
  SELECT RAISE(ABORT, 'roadmap comments are append-only');
END;
CREATE TRIGGER IF NOT EXISTS roadmap_comments_no_delete BEFORE DELETE ON roadmap_comments BEGIN
  SELECT RAISE(ABORT, 'roadmap comments are append-only');
END;
`;

// The v19 per-project rows of an org item under a given name: `item_id` and `job_id` with no foreign key.
export function roadmapItemProjectsDdlV19(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL,
  ${REQUIRED_PROJECT_ID},
  status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN (${sqlList(ISSUE_STATUSES)})),
  job_id INTEGER,
  job_status_seen TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(item_id, project_id)
);`;
}

// The v19 `roadmap_items` table under a given name: `decision_id` and `job_id` with no foreign key.
export function roadmapItemsDdlV19(name) {
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
  decision_id INTEGER,
  job_id INTEGER,
  job_status_seen TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK(${OWNER_CHECK})
);`;
}

// The v19 `decisions` table under a given name: `superseded_by` and `job_id` with no foreign key.
export function decisionsDdlV19(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ${SCOPE_COLUMN},
  ${PROJECT_ID},
  ${ORG_ID},
  number INTEGER,
  title TEXT NOT NULL,
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  consequences TEXT,
  status TEXT NOT NULL DEFAULT 'accepted' CHECK(status IN ('proposed','accepted','superseded','rejected')),
  superseded_by INTEGER,
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  embedding_model TEXT,
  CHECK(${OWNER_CHECK})
);`;
}

// The v19 `pipeline_runs` table under a given name: `job_id` with no foreign key.
export function pipelineRunsDdlV19(name) {
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
