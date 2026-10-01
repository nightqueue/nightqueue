import { DEFAULT_ISSUE_TYPE, ISSUE_STATUSES, ISSUE_TYPES, sqlList } from "../issue-workflow.mjs";

// The frozen v18 shapes of the two DDLs v19 changed: only the v18 migration builds them, so it never reaches a v19 column.

const ROADMAP_TYPE_COLUMN = `TEXT NOT NULL DEFAULT '${DEFAULT_ISSUE_TYPE}' CHECK(type IN (${sqlList(ISSUE_TYPES)}))`;

// The v18 registry of orgs and projects: names and ids, no keys.
export const REGISTRY_V18 = `
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

// The v18 `roadmap_items` table under a given name: owned by a project id or an org id, no per-owner number.
export function roadmapItemsDdlV18(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org')),
  project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
  org_id TEXT REFERENCES orgs(id) ON DELETE RESTRICT,
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
  CHECK((scope = 'project' AND org_id IS NULL) OR (scope = 'org' AND org_id IS NOT NULL AND project_id IS NULL))
);`;
}
