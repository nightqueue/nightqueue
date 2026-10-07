import { OWNER_CHECK } from "../ddl.mjs";
import { sqlList } from "../schema.mjs";

// The frozen shapes of the removed issue tracker: the constants and DDLs the v18 to v22 steps built it with, kept byte-equal
// so those steps behave as they always did; nothing outside `migration/` reads them.

export { sqlList };

export const ISSUE_STATUSES =Object.freeze(["backlog", "todo", "in_progress", "in_review", "done", "cancelled"]);
export const LIVE_JOB_STATUSES = Object.freeze(["pending", "running", "gate"]);
export const ISSUE_TYPES = Object.freeze(["bug", "feature", "improvement", "chore", "incident"]);
export const DEFAULT_ISSUE_TYPE = "improvement";
export const COMMENT_KINDS = Object.freeze(["note", "queued", "pr", "gate", "merged", "failed", "reopened", "closed"]);
export const OPERATOR_AUTHOR = "operator";

// SQL expression mapping a legacy row (`status`, `horizon`) of alias `r` to its v17 status.
export function legacyStatusSql(alias = "r") {
  return `CASE ${alias}.status
    WHEN 'open' THEN CASE WHEN ${alias}.horizon = 'now' THEN 'todo' ELSE 'backlog' END
    WHEN 'queued' THEN 'in_progress'
    WHEN 'done' THEN 'done'
    WHEN 'dropped' THEN 'cancelled'
    ELSE 'backlog' END`;
}

const ISSUE_TYPE_COLUMN = `TEXT NOT NULL DEFAULT '${DEFAULT_ISSUE_TYPE}' CHECK(type IN (${sqlList(ISSUE_TYPES)}))`;

const PROJECT_ID = "project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT";
const REQUIRED_PROJECT_ID = "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT";
const ORG_ID = "org_id TEXT REFERENCES orgs(id) ON DELETE RESTRICT";
const SCOPE_COLUMN = "scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))";

// The append-only comment thread of the issues, under a given name; a comment under a project carries its id.
export function issueCommentsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN (${sqlList(COMMENT_KINDS)})),
  author TEXT NOT NULL CHECK(author = '${OPERATOR_AUTHOR}' OR author GLOB 'job:[0-9]*'),
  body TEXT NOT NULL,
  refs TEXT CHECK(refs IS NULL OR json_valid(refs)),
  ${PROJECT_ID},
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
}

// The triggers that keep the comment thread append-only: every UPDATE is refused; a DELETE is refused while its item exists, so a comment only ends with its item.
export const ISSUE_COMMENT_GUARDS = `
CREATE TRIGGER IF NOT EXISTS issue_comments_no_update BEFORE UPDATE ON issue_comments BEGIN
  SELECT RAISE(ABORT, 'issue comments are append-only');
END;
CREATE TRIGGER IF NOT EXISTS issue_comments_no_delete BEFORE DELETE ON issue_comments
WHEN EXISTS (SELECT 1 FROM issues WHERE id = OLD.item_id) BEGIN
  SELECT RAISE(ABORT, 'issue comments are append-only');
END;
`;

// The per-project rows of an org item under a given name: one per project it was queued for, each linked to that project's job.
export function issueProjectsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
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

// The lexical mirrors of the issues: item title and detail follow every write, comments follow inserts and the deletes their item's removal makes.
export const ISSUE_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  title, detail,
  content='issues', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS issues_fts_ai AFTER INSERT ON issues BEGIN
  INSERT INTO issues_fts(rowid, title, detail) VALUES (new.id, new.title, new.detail);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_ad AFTER DELETE ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, detail) VALUES ('delete', old.id, old.title, old.detail);
END;
CREATE TRIGGER IF NOT EXISTS issues_fts_au AFTER UPDATE OF title, detail ON issues BEGIN
  INSERT INTO issues_fts(issues_fts, rowid, title, detail) VALUES ('delete', old.id, old.title, old.detail);
  INSERT INTO issues_fts(rowid, title, detail) VALUES (new.id, new.title, new.detail);
END;
CREATE VIRTUAL TABLE IF NOT EXISTS issue_comments_fts USING fts5(
  body,
  content='issue_comments', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS issue_comments_fts_ai AFTER INSERT ON issue_comments BEGIN
  INSERT INTO issue_comments_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER IF NOT EXISTS issue_comments_fts_ad AFTER DELETE ON issue_comments BEGIN
  INSERT INTO issue_comments_fts(issue_comments_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;
`;

// The `issues` table under a given name: owned by a project id (NULL for a global item) or by an org id, numbered per owner.
export function issuesDdl(name) {
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
  type ${ISSUE_TYPE_COLUMN},
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

// The v22/v23 index set, issue indexes included, that the v22 step rebuilds.
export const INDEXES = `
CREATE INDEX IF NOT EXISTS lessons_recall_idx ON lessons(archived, project_id, created_at);
CREATE INDEX IF NOT EXISTS lessons_embedding_idx ON lessons(embedding_model);
CREATE INDEX IF NOT EXISTS memory_project_idx ON memory(project_id, created_at);
CREATE INDEX IF NOT EXISTS project_index_project_idx ON project_index(project_id, updated_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_project_idx ON pipeline_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS pipeline_phases_run_idx ON pipeline_phases(run_id, seq);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_project_slug_idx ON jobs(project_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_number_idx ON decisions(project_id, number);
CREATE INDEX IF NOT EXISTS issues_order_idx ON issues(scope, project_id, org_id, priority, position);
CREATE INDEX IF NOT EXISTS issues_job_idx ON issues(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_number_idx ON decisions(org_id, number) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS issues_org_order_idx ON issues(org_id, priority, position) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS decisions_job_idx ON decisions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS issue_comments_item_idx ON issue_comments(item_id, id);
CREATE INDEX IF NOT EXISTS issue_projects_job_idx ON issue_projects(job_id);
CREATE INDEX IF NOT EXISTS pipeline_runs_job_idx ON pipeline_runs(job_id);
CREATE INDEX IF NOT EXISTS issues_decision_idx ON issues(decision_id);
CREATE INDEX IF NOT EXISTS decisions_superseded_idx ON decisions(superseded_by);
`;

// The per-owner uniqueness of issue numbers, kept out of INDEXES so a fresh creation builds it with the issues table.
export const ISSUE_NUMBER_INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS issues_number_idx ON issues(project_id, number) WHERE scope = 'project';
CREATE UNIQUE INDEX IF NOT EXISTS issues_org_number_idx ON issues(org_id, number) WHERE scope = 'org';
CREATE UNIQUE INDEX IF NOT EXISTS issues_global_number_idx ON issues(number) WHERE scope = 'project' AND project_id IS NULL;
`;
