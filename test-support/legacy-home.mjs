import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configPath, dbPath, homeDir } from "../src/config/paths.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { bringToV17 } from "../src/memory/migration/legacy.mjs";

const { DatabaseSync } = await import("node:sqlite");

// Builds the home a v17 (or older) build left behind, never through `openDb`: the frozen v17 schema on a raw connection, the named
// rows the test seeds, the version it asks for, a v1 `config.json` carrying `projects`/`orgs`, and `runs/<name>/<slug>/` directories.
export function buildLegacyHome(env, { version = 17, config = null, seed = null, runs = {}, mutate = null } = {}) {
  closeDb(env);
  ensureHome(env);
  const db = new DatabaseSync(dbPath(env));
  try {
    db.exec("PRAGMA foreign_keys = OFF");
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
