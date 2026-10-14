import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { dbPath } from "../../src/config/paths.mjs";
import { closeDb } from "../../src/memory/db.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { plantDecisionsV25 } from "../../test-support/legacy-home.mjs";
import { ensureProject, makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";

// Builds a v25 home with one lesson and one decision row planted by the given SQL, foreign keys off.
function buildV25Home(t, name, orphanSql) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  saveLesson({ projectId, title: "a lesson", root_cause: "r", solution: "s", prevention: "p" }, env);
  closeDb(env);
  const raw = new DatabaseSync(dbPath(env));
  try {
    plantDecisionsV25(raw);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw.exec(orphanSql);
    raw.exec("PRAGMA user_version = 25");
  } finally {
    raw.close();
  }
  return env;
}

// Asserts the home reached v26 with the decisions gone and the lesson kept.
function assertMigrated(env) {
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 26);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'decisions%'").get().n, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM lessons").get().n, 1);
}

test("a v25 home with a decision whose job_id dangles migrates to v26", (t) => {
  const env = buildV25Home(
    t,
    "v26-orphan-job",
    "INSERT INTO decisions (scope, project_id, org_id, number, title, context, decision, status, job_id) VALUES ('project', NULL, NULL, 1, 't', 'c', 'd', 'proposed', 999999)",
  );
  assertMigrated(env);
});

test("a v25 home with a decision whose superseded_by dangles migrates to v26", (t) => {
  const env = buildV25Home(
    t,
    "v26-orphan-superseded",
    "INSERT INTO decisions (scope, project_id, org_id, number, title, context, decision, status, superseded_by) VALUES ('project', NULL, NULL, 1, 't', 'c', 'd', 'superseded', 999999)",
  );
  assertMigrated(env);
});
