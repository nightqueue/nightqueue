import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addOrg, getOrg } from "../src/config/orgs.mjs";
import { addProject } from "../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { acquireClose, addJob, claimJobById, finishJob, persistRunFacts, settleClose } from "../src/memory/jobs.mjs";

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
  "NIGHTSHIFT_CLOSE_WORKER",
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
DROP INDEX roadmap_items_order_idx;
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
  const insert = db.prepare("INSERT INTO jobs (project, prompt, status, pr_url) VALUES (?, ?, 'merged', ?)");
  const legacyRow = (index) => insert.run(project, `legacy job ${index + 1}`, `https://github.com/acme/api/pull/${index + 1}`);
  const ids = Array.from({ length: rows }, (_, index) => Number(legacyRow(index).lastInsertRowid));
  db.exec("PRAGMA user_version = 8");
  closeDb(env);
  return ids;
}

const SEED_WORKER = "test:seed";
const SEED_MERGE_SHA = "abc1234def567890";

// A merged close checklist, the one a settled close leaves on the job.
export function mergedChecklist(prNumber = 7) {
  const at = "2026-09-21T10:00:00Z";
  return {
    attempts: 1,
    steps: { preflight: { status: "done", note: "seeded", at }, merge: { status: "done", note: "seeded", at }, settle: { status: "done", note: "seeded", at } },
    data: { prNumber, merged: true, mergeSha: SEED_MERGE_SHA, noticeLine: `Closed: PR #${prNumber} merged as abc1234 on 2026-09-21` },
  };
}

// Seeds a job that ended `done` with a pull request, through the real store writes, and answers its id.
export function seedDoneJob(env, { project = "alpha", prompt = "seeded job", prUrl = "https://github.com/acme/api/pull/7", slug = null } = {}) {
  const { id } = addJob({ project, prompt }, env);
  claimJobById(id, { worker: SEED_WORKER, cap: null }, env);
  if (slug) persistRunFacts(id, { worker: SEED_WORKER, slug }, env);
  if (!finishJob(id, { worker: SEED_WORKER, status: "done", prUrl }, env)) throw new Error(`seedDoneJob: job #${id} could not be finished`);
  return id;
}

// Seeds a job closed through the real close writes - lease, then settle with a merged checklist - never through raw SQL, and answers its id.
export function seedClosedJob(env, options = {}) {
  const id = seedDoneJob(env, options);
  if (!acquireClose(id, { worker: SEED_WORKER, leaseS: 600 }, env)) throw new Error(`seedClosedJob: job #${id} refused the close lease`);
  const checklist = mergedChecklist();
  if (!settleClose(id, { worker: SEED_WORKER, close: checklist, noticeLine: checklist.data.noticeLine }, env)) {
    throw new Error(`seedClosedJob: job #${id} refused the settle`);
  }
  return id;
}

// Closes a `done` job through a store's own close writes - lease, then settle with a merged checklist - so the roadmap follows it, and answers the settled view.
export async function settleThroughStore(store, jobId, { worker = "test:close", prNumber = 7 } = {}) {
  if (!(await store.jobs.acquireClose(jobId, { worker, leaseS: 600 }))) throw new Error(`settleThroughStore: job #${jobId} refused the close lease`);
  const checklist = mergedChecklist(prNumber);
  const settled = await store.jobs.settleClose(jobId, { worker, close: checklist, noticeLine: checklist.data.noticeLine });
  if (!settled) throw new Error(`settleThroughStore: job #${jobId} refused the settle`);
  return settled;
}

// The `roadmap_items` table exactly as a v16 build left it: the horizon, the four legacy statuses and the indexes on them.
export const LEGACY_V16_ROADMAP_DDL = `
DROP TRIGGER IF EXISTS roadmap_comments_fts_ai;
DROP TABLE IF EXISTS roadmap_comments_fts;
DROP TABLE IF EXISTS roadmap_items_fts;
DROP TABLE roadmap_items;
CREATE TABLE roadmap_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT,
  horizon TEXT NOT NULL CHECK(horizon IN ('now','next','later')),
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','queued','done','dropped')),
  position INTEGER NOT NULL,
  decision_id INTEGER,
  job_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE roadmap_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'project' CHECK(scope IN ('project','org'));
ALTER TABLE roadmap_items ADD COLUMN org TEXT;
CREATE INDEX roadmap_items_order_idx ON roadmap_items(project, horizon, position);
CREATE INDEX roadmap_items_job_idx ON roadmap_items(job_id);
CREATE INDEX roadmap_items_org_order_idx ON roadmap_items(org, horizon, position) WHERE scope = 'org';
`;

// Turns the database of a home back into the v16 roadmap shape and seeds it with raw legacy rows, then closes it so the next open migrates.
export function seedLegacyV16Roadmap(env, { items = [], jobs = [], sequence = null } = {}) {
  const db = openDb(env);
  db.exec(LEGACY_V16_ROADMAP_DDL);
  const insertJob = db.prepare("INSERT INTO jobs (id, project, prompt, status, result, pr_url) VALUES (?, ?, ?, ?, ?, ?)");
  for (const job of jobs) insertJob.run(job.id, job.project, "legacy job", job.status, job.result ?? null, job.pr_url ?? null);
  const insertItem = db.prepare(
    `INSERT INTO roadmap_items (id, scope, project, org, horizon, title, status, position, job_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const item of items) {
    insertItem.run(
      item.id,
      item.org ? "org" : "project",
      item.org ? null : (item.project ?? null),
      item.org ?? null,
      item.horizon,
      item.title ?? `item ${item.id}`,
      item.status,
      item.position,
      item.job_id ?? null,
      item.updated_at ?? "2026-01-02 03:04:05",
    );
  }
  if (sequence !== null) db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'roadmap_items'").run(sequence);
  db.exec("PRAGMA user_version = 16");
  closeDb(env);
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
