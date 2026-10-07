import { CLOSED_REQUIRES_MERGE, sqlList } from "./schema.mjs";

// The current (v22) schema of the memory database: one source for a fresh creation and for the v22 migration; the frozen
// v18, v19 and v20 shapes the earlier migrations build live under `migration/`.

const PROJECT_ID = "project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT";
const REQUIRED_PROJECT_ID = "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT";
const ORG_ID = "org_id TEXT REFERENCES orgs(id) ON DELETE RESTRICT";
const SCOPE_COLUMN = "scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'))";

// The one owner a decision has: a project row (or a global one) carries no org, an org row no project.
export const OWNER_CHECK =
  "(scope = 'project' AND org_id IS NULL) OR (scope = 'org' AND org_id IS NOT NULL AND project_id IS NULL)";

// The `decisions` table under a given name: owned by a project id (NULL for a global decision) or by an org id.
export function decisionsDdl(name) {
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

// The format rule of an owner key column: 2 to 5 uppercase letters or digits, starting with a letter.
export function OWNER_KEY_FORMAT(column) {
  return `length(${column}) BETWEEN 2 AND 5 AND ${column} GLOB '[A-Z]*' AND ${column} NOT GLOB '*[^A-Z0-9]*'`;
}

// The `orgs` table under a given name: an id, a renamable name and a renamable key.
export function orgsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 26),
  name TEXT NOT NULL UNIQUE,
  key TEXT NOT NULL UNIQUE CHECK(${OWNER_KEY_FORMAT("key")}),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
}

// The `projects` table under a given name: an id, a renamable name and key, an optional checkout path and its org (`integrations` is added per open by migration/v21.mjs).
export function projectsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id) = 26),
  name TEXT NOT NULL UNIQUE,
  key TEXT NOT NULL UNIQUE CHECK(${OWNER_KEY_FORMAT("key")}),
  path TEXT UNIQUE,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);`;
}

// The registry of orgs and projects: the only place a name or a key lives, every other table owns rows by id.
export const REGISTRY = `
${orgsDdl("orgs")}
${projectsDdl("projects")}
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(org_id);
CREATE TABLE IF NOT EXISTS project_key_aliases (
  key TEXT PRIMARY KEY NOT NULL CHECK(${OWNER_KEY_FORMAT("key")}),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS org_key_aliases (
  key TEXT PRIMARY KEY NOT NULL CHECK(${OWNER_KEY_FORMAT("key")}),
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

// Tells, as SQL, whether a key is already held anywhere: a project or org key, or an old key of either.
function keyHeld(key) {
  return `(EXISTS (SELECT 1 FROM projects WHERE key = ${key})
    OR EXISTS (SELECT 1 FROM orgs WHERE key = ${key})
    OR EXISTS (SELECT 1 FROM project_key_aliases WHERE key = ${key})
    OR EXISTS (SELECT 1 FROM org_key_aliases WHERE key = ${key}))`;
}

// The database guarantee that a key lives once across projects, orgs and their old keys; aliases are never edited.
export const OWNER_KEY_GUARDS = `
CREATE TRIGGER IF NOT EXISTS projects_key_ai BEFORE INSERT ON projects WHEN ${keyHeld("NEW.key")} BEGIN
  SELECT RAISE(ABORT, 'owner key taken');
END;
CREATE TRIGGER IF NOT EXISTS projects_key_au BEFORE UPDATE OF key ON projects WHEN NEW.key IS NOT OLD.key AND ${keyHeld("NEW.key")} BEGIN
  SELECT RAISE(ABORT, 'owner key taken');
END;
CREATE TRIGGER IF NOT EXISTS orgs_key_ai BEFORE INSERT ON orgs WHEN ${keyHeld("NEW.key")} BEGIN
  SELECT RAISE(ABORT, 'owner key taken');
END;
CREATE TRIGGER IF NOT EXISTS orgs_key_au BEFORE UPDATE OF key ON orgs WHEN NEW.key IS NOT OLD.key AND ${keyHeld("NEW.key")} BEGIN
  SELECT RAISE(ABORT, 'owner key taken');
END;
CREATE TRIGGER IF NOT EXISTS project_key_aliases_ai BEFORE INSERT ON project_key_aliases WHEN ${keyHeld("NEW.key")} BEGIN
  SELECT RAISE(ABORT, 'owner key taken');
END;
CREATE TRIGGER IF NOT EXISTS org_key_aliases_ai BEFORE INSERT ON org_key_aliases WHEN ${keyHeld("NEW.key")} BEGIN
  SELECT RAISE(ABORT, 'owner key taken');
END;
CREATE TRIGGER IF NOT EXISTS project_key_aliases_au BEFORE UPDATE ON project_key_aliases BEGIN
  SELECT RAISE(ABORT, 'owner key aliases are never edited');
END;
CREATE TRIGGER IF NOT EXISTS org_key_aliases_au BEFORE UPDATE ON org_key_aliases BEGIN
  SELECT RAISE(ABORT, 'owner key aliases are never edited');
END;
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
]);

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
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  tier_operator TEXT,
  tier_raise_reason TEXT
);`;
}

// The `jobs` table under a given name: the queue, every job owned by a project id, a closed job always carrying its merge (`origin` is added per open by migration/v21.mjs).
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

export const ATTEMPT_OUTCOMES = Object.freeze(["gate", "done", "failed", "cancelled", "released", "timed_out", "lost"]);

// The `job_attempts` table under a given name: one row per claim of a job, its own start, end, outcome and measures.
export function jobAttemptsDdl(name) {
  return `CREATE TABLE IF NOT EXISTS ${name} (
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  worker TEXT,
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN (${sqlList(ATTEMPT_OUTCOMES)})),
  exit_reason TEXT,
  spawns INTEGER NOT NULL DEFAULT 1,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cache_read INTEGER,
  cache_creation INTEGER,
  cost_usd REAL,
  measured INTEGER NOT NULL DEFAULT 0,
  fresh INTEGER NOT NULL DEFAULT 0,
  backfilled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, attempt)
);`;
}

export const SCHEMA = `
${lessonsDdl("lessons")}
${memoryDdl("memory")}
${projectIndexDdl("project_index")}
${projectLibsDdl("project_libs")}
${pipelineRunsDdl("pipeline_runs")}
${jobsDdl("jobs")}
${jobAttemptsDdl("job_attempts")}
CREATE UNIQUE INDEX IF NOT EXISTS job_attempts_open_idx ON job_attempts(job_id) WHERE finished_at IS NULL;
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
${decisionsDdl("decisions")}
`;

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
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_number_idx ON decisions(org_id, number) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS decisions_job_idx ON decisions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pipeline_runs_job_idx ON pipeline_runs(job_id);
CREATE INDEX IF NOT EXISTS decisions_superseded_idx ON decisions(superseded_by);
`;

// The lexical index of the job history (slug, brief, notice), kept out of FTS because the older one-shot steps exec FTS while `jobs` is being rebuilt.
export const JOBS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(slug, brief, notice);
CREATE TRIGGER IF NOT EXISTS jobs_fts_ai AFTER INSERT ON jobs BEGIN
  DELETE FROM jobs_fts WHERE rowid = new.id;
  INSERT INTO jobs_fts(rowid, slug, brief, notice) VALUES (new.id, new.slug, substr(new.prompt, 1, 1500), new.notice_md);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_au AFTER UPDATE OF slug, notice_md, prompt ON jobs BEGIN
  DELETE FROM jobs_fts WHERE rowid IN (old.id, new.id);
  INSERT INTO jobs_fts(rowid, slug, brief, notice) VALUES (new.id, new.slug, substr(new.prompt, 1, 1500), new.notice_md);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_ad AFTER DELETE ON jobs BEGIN
  DELETE FROM jobs_fts WHERE rowid = old.id;
END;
`;

// Indexes every job the lexical index of the job history does not hold yet.
export const JOBS_FTS_BACKFILL = `
INSERT INTO jobs_fts(rowid, slug, brief, notice)
SELECT id, slug, substr(prompt, 1, 1500), notice_md FROM jobs
 WHERE NOT EXISTS (SELECT 1 FROM jobs_fts f WHERE f.rowid = jobs.id);
`;

// Removes every row of the lexical index of the job history whose job no longer exists.
export const JOBS_FTS_PRUNE = `
DELETE FROM jobs_fts WHERE rowid NOT IN (SELECT id FROM jobs);
`;

// Finds one job missing from the lexical index of the job history, or one index row left without its job.
export const JOBS_FTS_DRIFT = `
SELECT 1 FROM jobs WHERE id NOT IN (SELECT rowid FROM jobs_fts)
UNION ALL
SELECT 1 FROM jobs_fts WHERE rowid NOT IN (SELECT id FROM jobs)
LIMIT 1
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
