import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { projectIntegrations } from "../../src/memory/registry.mjs";
import { openStore } from "../../src/store/open.mjs";
import { buildLegacyHome } from "../../test-support/legacy-home.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

// The column names of a table.
function columnsOf(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

// A home stamped v20: the project `alpha`, one job, and neither v21 column.
function makeV20Home(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  addJob({ projectId, prompt: "fix the worker" }, env);
  openDb(env).exec("ALTER TABLE jobs DROP COLUMN origin; ALTER TABLE projects DROP COLUMN integrations; PRAGMA user_version = 20;");
  closeDb(env);
  return { env, projectId };
}

test("the schema is v21", () => {
  assert.equal(DB_USER_VERSION, 21);
});

test("a v20 home gains jobs.origin and projects.integrations once, keeping every row, on every open", (t) => {
  const { env } = makeV20Home(t, "migration-v21");
  for (const pass of [1, 2]) {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION, `pass ${pass}`);
    assert.equal(columnsOf(db, "jobs").filter((column) => column === "origin").length, 1, `pass ${pass}`);
    assert.equal(columnsOf(db, "projects").filter((column) => column === "integrations").length, 1, `pass ${pass}`);
    assert.deepEqual(db.prepare("SELECT prompt, origin FROM jobs").all().map((row) => ({ ...row })), [{ prompt: "fix the worker", origin: null }]);
    closeDb(env);
  }
});

test("a read-only open of a v20 home reads no origin and no integrations instead of throwing", async (t) => {
  const { env, projectId } = makeV20Home(t, "migration-v21-read-only");
  const db = openDbReadOnly(env);
  t.after(() => db.close());
  assert.equal(projectIntegrations(db, projectId), null);
  assert.equal(jobView(db.prepare("SELECT * FROM jobs WHERE id = 1").get()).origin, null);
});

test("a stored integrations value reads as an object, an empty or broken one as none", async (t) => {
  const env = makeHome(t, "migration-v21-integrations");
  makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const store = openStore(env);
  const write = (value) => openDb(env).prepare("UPDATE projects SET integrations = ? WHERE id = ?").run(value, projectId);
  assert.equal(await store.projects.integrations(projectId), null);
  write(JSON.stringify({ tracker: { onClosed: "resolved" } }));
  assert.deepEqual(await store.projects.integrations(projectId), { tracker: { onClosed: "resolved" } });
  for (const value of ["{}", "[]", "{broken", "null"]) {
    write(value);
    assert.equal(await store.projects.integrations(projectId), null, value);
  }
});

test("a v17 home reaches v21 in one open with both columns", (t) => {
  const env = makeHome(t, "migration-v21-from-v17");
  buildLegacyHome(env, {
    seed: (db) => db.prepare("INSERT INTO roadmap_items (scope, project, title, position) VALUES ('project', 'alpha', 'old item', 1)").run(),
  });
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.ok(columnsOf(db, "jobs").includes("origin"));
  assert.ok(columnsOf(db, "projects").includes("integrations"));
  assert.deepEqual(db.prepare("SELECT title FROM roadmap_items").all().map((row) => row.title), ["old item"]);
  assert.equal(jobView(getJob(addJob({ projectId: projectIdOf(env, "alpha"), prompt: "x" }, env).id, env)).origin, null);
});
