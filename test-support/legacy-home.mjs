import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, dbPath, homeDir } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { bringToV17 } from "../src/memory/migration/legacy.mjs";
import { issueCommentsDdl, issueProjectsDdl, issuesDdl } from "../src/memory/migration/tracker-shape.mjs";

const { DatabaseSync } = await import("node:sqlite");

const PRE_V22_NAMES = Object.freeze([
  ["issues", "roadmap_items"],
  ["issue_projects", "roadmap_item_projects"],
  ["issue_comments", "roadmap_comments"],
]);

// The name a current table had before v22, the one a pre-v22 database or copy holds it under.
export function preV22Name(table) {
  return PRE_V22_NAMES.find(([current]) => current === table)?.[1] ?? table;
}

// Gives the tracker tables of a home already opened at the current schema their pre-v22 names, the only ones a legacy build knew.
export function restorePreV22Names(db) {
  const tables = PRE_V22_NAMES.map(([current]) => `'${current}'`).join(", ");
  const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN (${tables})`).all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER "${name}"`);
  db.exec("DROP TABLE IF EXISTS issues_fts; DROP TABLE IF EXISTS issue_comments_fts");
  for (const [current, old] of PRE_V22_NAMES) {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(current)) db.exec(`ALTER TABLE ${current} RENAME TO ${old}`);
  }
}

// Gives a home opened at the current schema the tracker tables a pre-v22 build had, from their frozen shapes, under their pre-v22 names.
export function plantPreV22Tracker(db) {
  db.exec(`${issuesDdl("issues")}\n${issueCommentsDdl("issue_comments")}\n${issueProjectsDdl("issue_projects")}`);
  restorePreV22Names(db);
}

// Builds the home a v17 (or older) build left behind, never through `openDb`: the frozen v17 schema on a raw connection, the named
// rows the test seeds, the version it asks for, a v1 `config.json` carrying `projects`/`orgs`, and `runs/<name>/<slug>/` directories.
export function buildLegacyHome(env, { version = 17, config = null, seed = null, runs = {}, mutate = null } = {}) {
  closeDb(env);
  ensureHome(env);
  const db = new DatabaseSync(dbPath(env));
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    restorePreV22Names(db);
    db.exec("DROP TRIGGER IF EXISTS roadmap_comments_no_delete");
    bringToV17(db);
    seed?.(db);
    mutate?.(db);
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
  if (config !== null) writeFileSync(configPath(env), `${JSON.stringify(config, null, 2)}\n`);
  for (const [project, slugs] of Object.entries(runs)) {
    for (const slug of slugs) mkdirSync(join(homeDir(env), "runs", project, slug), { recursive: true });
  }
  return dbPath(env);
}

// A v1 `config.json` as a v17 build wrote it: the default org, the given orgs (name -> github connection or null) and projects.
export function legacyConfig({ defaultOrg = "default", orgs = {}, projects = {}, extra = {} } = {}) {
  const orgEntries = { [defaultOrg]: { displayName: defaultOrg, connections: { github: null } } };
  for (const [name, github] of Object.entries(orgs)) orgEntries[name] = { displayName: name, connections: { github: github ?? null } };
  return { version: 1, defaultOrg, orgs: orgEntries, projects, queue: { maxConcurrent: null }, embedding: null, ...extra };
}
