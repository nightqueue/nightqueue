import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isId } from "../src/config/ids.mjs";
import { requireGitPath } from "../src/config/projects.mjs";
import { loadConfig } from "../src/config/store.mjs";
import { hasColumn } from "../src/memory/columns.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { acquireClose, addJob, claimJobById, finishJob, persistRunFacts, settleClose } from "../src/memory/jobs.mjs";
import * as registry from "../src/memory/registry.mjs";
import { buildLegacyHome } from "./legacy-home.mjs";

const OWN_ENV_KEYS = [
  "NIGHTQUEUE_HOME",
  "NIGHTQUEUE_EMBED_DISABLED",
  "NIGHTQUEUE_EMBED_DEADLINE_MS",
  "NIGHTQUEUE_REFLECT",
  "NIGHTQUEUE_REFLECT_MODEL",
  "NIGHTQUEUE_CLAUDE_BIN",
  "NIGHTQUEUE_MODEL",
  "NIGHTQUEUE_SESSION_ID",
  "NIGHTQUEUE_JOB_ID",
  "NIGHTQUEUE_CLOSE_WORKER",
  "NIGHTQUEUE_JOB_HOME",
  "NIGHTQUEUE_JOB_CLAUDE_DIR",
  "NIGHTQUEUE_NO_UPDATE_CHECK",
  "NIGHTQUEUE_NO_PR_CHECK",
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
  const dir = mkdtempSync(join(tmpdir(), `nightqueue-${name}-`));
  t.after(() => finishedDirs.add(dir));
  return dir;
}

// Environment of an isolated home, with the semantic path off unless the test asks for it.
export function makeHome(t, name, { embed = false } = {}) {
  const home = join(makeDir(t, name), "home");
  const env = { ...process.env };
  for (const key of OWN_ENV_KEYS) delete env[key];
  env.NIGHTQUEUE_HOME = home;
  env.NIGHTQUEUE_NO_UPDATE_CHECK = "1";
  env.NIGHTQUEUE_NO_PR_CHECK = "1";
  if (!embed) env.NIGHTQUEUE_EMBED_DISABLED = "1";
  t.after(() => closeDb(env));
  return env;
}

// Creates an org of the home through the registry, the owner an org decision or an org roadmap item is saved under.
export function makeOrg(env, name) {
  const db = openDb(env);
  if (!registry.orgByName(db, name)) registry.insertOrg(db, name);
  return name;
}

// The default org of the home: the one config.json names by id, else the earliest org.
function defaultOrgRow(env) {
  const db = openDb(env);
  const named = loadConfig(env, { warn: () => {} }).defaultOrg;
  return (isId(named) ? registry.orgById(db, named) : null) ?? registry.earliestOrg(db);
}

// The checkout path the registry holds for a project of the home, by name.
export function projectPathOf(env, name) {
  return registry.projectByName(openDb(env), name)?.path ?? null;
}

// The id of an org of the home, by name.
export function orgIdOf(env, name) {
  return registry.orgByName(openDb(env), name)?.id ?? null;
}

// A well-formed project id no home registered, for the tests of run paths that never open a database.
export const FIXED_PROJECT_ID = "01J9Z00000000000000000000A";

// The id of a project of the home, by name.
export function projectIdOf(env, name) {
  return registry.projectByName(openDb(env), name)?.id ?? null;
}

// The `{ projectId }` / `{ orgId }` a decision or roadmap call takes, from the `{ project }` / `{ org }` names a test writes.
export function ownerIdsOf(env, { project, org } = {}) {
  return {
    ...(project === undefined ? {} : { projectId: projectIdOf(env, project) }),
    ...(org === undefined ? {} : { orgId: orgIdOf(env, org) }),
  };
}

// The id of a project of the home, registering it without a checkout (in the given org, else the default one) when it is missing.
export function ensureProject(env, name, { org } = {}) {
  const found = projectIdOf(env, name);
  if (found) return found;
  const orgId = org ? orgIdOf(env, makeOrg(env, org)) : defaultOrgRow(env).id;
  return registry.insertProject(openDb(env), { name, path: null, orgId }).id;
}

// Registers an existing git checkout as a project of the home through the registry, in the org the test asks for, and answers its row.
export function registerCheckout(env, { path, name, org } = {}) {
  const orgId = org ? orgIdOf(env, makeOrg(env, org)) : defaultOrgRow(env).id;
  return registry.insertProject(openDb(env), { name, path: requireGitPath(path), orgId });
}

// Takes the checkout away from a registered project, which leaves it known only from history: for the tests of a project with nowhere to run.
export function dropCheckout(env, name) {
  const db = openDb(env);
  const project = registry.projectByName(db, name);
  if (!project) throw new Error(`dropCheckout: no project \`${name}\``);
  registry.moveProject(db, { id: project.id, path: null });
}

// Registers a temporary directory that looks like a git repository as a project of the home, in the org the test asks for.
export function makeProject(t, env, name, { org } = {}) {
  const path = makeDir(t, `repo-${name}`);
  mkdirSync(join(path, ".git"), { recursive: true });
  registerCheckout(env, { path, name, org });
  return path;
}

// Everything the owner scope added to the schema, undone: what a `buildLegacyHome` mutate execs on the frozen v17 tables to leave the v5 shape a previous build wrote.
export const DOWNGRADE_TO_V5 = `
ALTER TABLE decisions DROP COLUMN job_id;
ALTER TABLE decisions DROP COLUMN scope;
ALTER TABLE decisions DROP COLUMN org;
ALTER TABLE roadmap_items DROP COLUMN scope;
ALTER TABLE roadmap_items DROP COLUMN org;
PRAGMA user_version = 5;
`;

// A statement inserting a legacy job row whose first value is its project NAME: by name into a v17 `jobs`, or mapped
// through the registry into the id-keyed `jobs` of a home that was already opened (registered) before it was turned legacy.
function legacyJobInsert(db, columns) {
  const byId = hasColumn(db, "jobs", "project_id");
  const owner = byId ? "project_id" : "project";
  const first = byId ? "(SELECT id FROM projects WHERE name = ?)" : "?";
  const rest = columns.map(() => "?");
  return db.prepare(`INSERT INTO jobs (${[owner, ...columns].join(", ")}) VALUES (${[first, ...rest].join(", ")})`);
}

// Re-creates what a v8 build leaves behind - the `pr_checked_at` column and rows still on the retired `merged` status -
// so a test can drive the runtime that is supposed to migrate it and check the home landed on v9.
export function seedLegacyV8Home(env, { rows = 1, project = "alpha" } = {}) {
  let ids = [];
  buildLegacyHome(env, {
    version: 8,
    mutate(db) {
      db.exec("ALTER TABLE jobs ADD COLUMN pr_checked_at TEXT");
      const insert = legacyJobInsert(db, ["prompt", "status", "pr_url"]);
      const legacyRow = (index) => insert.run(project, `legacy job ${index + 1}`, "merged", `https://github.com/acme/api/pull/${index + 1}`);
      ids = Array.from({ length: rows }, (_, index) => Number(legacyRow(index).lastInsertRowid));
    },
  });
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
  const { id } = addJob({ projectId: ensureProject(env, project), prompt }, env);
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
DROP TRIGGER IF EXISTS roadmap_comments_fts_ad;
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
  buildLegacyHome(env, { version: 16, mutate: (db) => seedV16Rows(db, { items, jobs, sequence }) });
}

// The raw v16 rows of a legacy roadmap: the table rebuilt in its v16 shape, then its jobs and items as a v16 build wrote them.
function seedV16Rows(db, { items, jobs, sequence }) {
  db.exec(LEGACY_V16_ROADMAP_DDL);
  const insertJob = legacyJobInsert(db, ["id", "prompt", "status", "result", "pr_url"]);
  for (const job of jobs) insertJob.run(job.project, job.id, "legacy job", job.status, job.result ?? null, job.pr_url ?? null);
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
