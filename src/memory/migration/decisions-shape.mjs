// The frozen shape of the removed `decisions` table: the DDL, owner rule, indexes and lexical mirror v20 to v25 carried, kept
// byte-equal so the v18 to v26 steps behave as they always did; nothing outside `migration/` and the test fixtures reads them.

const PROJECT_ID = "project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT";
const ORG_ID = "org_id TEXT REFERENCES orgs(id) ON DELETE RESTRICT";
const SCOPE_COLUMN = "scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))";

// The one owner a decision has: a project row (or a global one) carries no org, an org row no project.
export const OWNER_CHECK =
  "(scope = 'project' AND org_id IS NULL) OR (scope = 'org' AND org_id IS NOT NULL AND project_id IS NULL)";

// The v20 to v25 `decisions` table under a given name: owned by a project id (NULL for a global decision) or by an org id.
export function decisionsDdlV25(name) {
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
  superseded_by INTEGER REFERENCES decisions(id) ON DELETE RESTRICT,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  embedding BLOB,
  embedding_model TEXT,
  CHECK(${OWNER_CHECK})
);`;
}

export const DECISIONS_INDEXES_V25 = `
CREATE UNIQUE INDEX IF NOT EXISTS decisions_number_idx ON decisions(project_id, number);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_number_idx ON decisions(org_id, number) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS decisions_job_idx ON decisions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS decisions_superseded_idx ON decisions(superseded_by);
`;

export const DECISIONS_FTS_V25 = `
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

export const DECISION_OBJECTS = Object.freeze([
  "decisions_fts_ai",
  "decisions_fts_ad",
  "decisions_fts_au",
  "decisions_fts",
  "decisions",
]);
