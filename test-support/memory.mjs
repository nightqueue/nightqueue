import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOrg, getOrg } from "../src/config/orgs.mjs";
import { addProject } from "../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";

const OWN_ENV_KEYS = [
  "NIGHTSHIFT_HOME",
  "NIGHTSHIFT_EMBED_DISABLED",
  "NIGHTSHIFT_EMBED_DEADLINE_MS",
  "NIGHTSHIFT_REFLECT",
  "NIGHTSHIFT_REFLECT_MODEL",
  "NIGHTSHIFT_CLAUDE_BIN",
  "NIGHTSHIFT_MODEL",
  "NIGHTSHIFT_SESSION_ID",
  "NIGHTSHIFT_JOB_ID",
  "NIGHTSHIFT_SHIP_WORKER",
  "NIGHTSHIFT_JOB_HOME",
  "NIGHTSHIFT_JOB_CLAUDE_DIR",
  "NIGHTSHIFT_NO_UPDATE_CHECK",
  "NIGHTSHIFT_NO_PR_CHECK",
];

const finishedDirs = new Set();

// Removes the temporary directories of the tests that already finished.
function flushFinishedDirs() {
  for (const dir of finishedDirs) rmSync(dir, { recursive: true, force: true });
  finishedDirs.clear();
}

process.on("exit", flushFinishedDirs);

// Creates a temporary directory removed once the test ended, so a cleanup hook the test registers later still finds its files.
export function makeDir(t, name) {
  flushFinishedDirs();
  const dir = mkdtempSync(join(tmpdir(), `nightshift-${name}-`));
  t.after(() => finishedDirs.add(dir));
  return dir;
}

// Environment of an isolated home, with the semantic path off unless the test asks for it.
export function makeHome(t, name, { embed = false } = {}) {
  const home = join(makeDir(t, name), "home");
  const env = { ...process.env };
  for (const key of OWN_ENV_KEYS) delete env[key];
  env.NIGHTSHIFT_HOME = home;
  env.NIGHTSHIFT_NO_UPDATE_CHECK = "1";
  env.NIGHTSHIFT_NO_PR_CHECK = "1";
  if (!embed) env.NIGHTSHIFT_EMBED_DISABLED = "1";
  t.after(() => closeDb(env));
  return env;
}

// Creates an org of the home, the owner an org decision or an org roadmap item is saved under.
export function makeOrg(env, name) {
  const config = loadConfig(env, { warn: () => {} });
  if (getOrg(config, name)) return name;
  saveConfig(addOrg(config, name), env);
  return name;
}

// Registers a temporary directory that looks like a git repository as a project of the home, in the org the test asks for.
export function makeProject(t, env, name, { org } = {}) {
  const path = makeDir(t, `repo-${name}`);
  mkdirSync(join(path, ".git"), { recursive: true });
  if (org) makeOrg(env, org);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name, org }).config, env);
  return path;
}

// Everything the owner scope added to the schema, undone: what a test execs to turn an open database back into the v5 shape a previous build wrote.
export const DOWNGRADE_TO_V5 = `
DROP INDEX decisions_org_number_idx;
DROP INDEX roadmap_items_org_order_idx;
DROP INDEX decisions_job_idx;
ALTER TABLE decisions DROP COLUMN job_id;
ALTER TABLE decisions DROP COLUMN scope;
ALTER TABLE decisions DROP COLUMN org;
ALTER TABLE roadmap_items DROP COLUMN scope;
ALTER TABLE roadmap_items DROP COLUMN org;
PRAGMA user_version = 5;
`;

// Re-creates what a v8 build leaves behind - the `pr_checked_at` column and rows still on the retired `merged` status -
// so a test can drive the runtime that is supposed to migrate it and check the home landed on v9.
export function seedLegacyV8Home(env, { rows = 1, project = "alpha" } = {}) {
  const db = openDb(env);
  if (!db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "pr_checked_at")) {
    db.exec("ALTER TABLE jobs ADD COLUMN pr_checked_at TEXT");
  }
  const insert = db.prepare("INSERT INTO jobs (project, prompt, status) VALUES (?, ?, 'merged')");
  const ids = Array.from({ length: rows }, (_, index) => Number(insert.run(project, `legacy job ${index + 1}`).lastInsertRowid));
  db.exec("PRAGMA user_version = 8");
  closeDb(env);
  return ids;
}

// Embedder double with a fixed vector, so the hybrid recall never depends on the real model.
export function fakeEmbedder(vector, { model = "fake-embedder@v1" } = {}) {
  const calls = [];
  return {
    calls,
    model,
    embedText: async (text) => {
      calls.push(text);
      return typeof vector === "function" ? vector(text) : vector;
    },
  };
}
