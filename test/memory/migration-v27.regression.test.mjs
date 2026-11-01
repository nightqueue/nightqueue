import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dbPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";

const DANGLING_JOB_ID = 999999;
const DANGLING_PROJECT_ID = 888888;

// Runs a use of a raw connection to the home's database, closed right after.
function withRaw(env, use, options = {}) {
  const raw = new DatabaseSync(dbPath(env), options);
  try {
    return use(raw);
  } finally {
    raw.close();
  }
}

// A home stamped `version`, its `jobs` still carrying the budget column, with one dangling `pipeline_runs.job_id` and one dangling `jobs.project_id`.
function danglingHome(t, name, version) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  const dangling = addJob({ projectId, prompt: "fix the worker" }, env).id;
  closeDb(env);
  withRaw(env, (raw) => {
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec("ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 1");
    raw.prepare("INSERT INTO pipeline_runs (project_id, slug, tier, outcome, job_id) VALUES (?, 'orphan-slug', 'complex', 'ok', ?)").run(projectId, DANGLING_JOB_ID);
    raw.prepare("UPDATE jobs SET project_id = ? WHERE id = ?").run(DANGLING_PROJECT_ID, dangling);
    raw.exec(`PRAGMA user_version = ${version}`);
  });
  return { env, dangling };
}

// The stamp and the two planted rows of the home, read on a raw connection.
function plantedFacts({ env, dangling }) {
  return withRaw(
    env,
    (raw) => ({
      version: raw.prepare("PRAGMA user_version").get().user_version,
      runs: raw.prepare("SELECT COUNT(*) AS n FROM pipeline_runs WHERE job_id = ?").get(DANGLING_JOB_ID).n,
      jobs: raw.prepare("SELECT COUNT(*) AS n FROM jobs WHERE id = ? AND project_id = ?").get(dangling, DANGLING_PROJECT_ID).n,
      budget: raw.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('jobs') WHERE name = 'max_attempts'").get().n,
    }),
    { readOnly: true },
  );
}

test("a v26 home with dangling references reaches v27 with both rows and a pre-v27 copy: dropping one column needs no gate", (t) => {
  const home = danglingHome(t, "v27-dangling", 26);

  const db = migrateTestHome(home.env);

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 27);
  closeDb(home.env);
  assert.deepEqual(plantedFacts(home), { version: 27, runs: 1, jobs: 1, budget: 0 });
  assert.equal(existsSync(preVersionBackupPath(home.env, 27)), true, "no pre-v27 copy was kept");
});

test("an older home with the same dangling rows is still refused before anything moves: a rebuilding step needs the gate", (t) => {
  const home = danglingHome(t, "v25-dangling", 25);

  assert.throws(() => migrateTestHome(home.env), /pipeline_runs|jobs/);

  closeDb(home.env);
  assert.deepEqual(plantedFacts(home), { version: 25, runs: 1, jobs: 1, budget: 1 });
});
