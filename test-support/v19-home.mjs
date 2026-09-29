import { dbPath } from "../src/config/paths.mjs";
import { migrateToV19 } from "../src/memory/migration/v19.mjs";
import { buildV18Home } from "./v18-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

// The rows the v19 fixture links on purpose, one per column v20 gives a foreign key, named for the tests that follow them.
export const V19_LINKS = Object.freeze({
  job: 1,
  otherJob: 2,
  orgItem: 2,
  otherItem: 1,
  linkedItem: 5,
  supersededTarget: 2,
  linkedDecision: 3,
  run: 1,
  commentWord: "zebra",
});

// Links jobs to items, org item rows, a decision and a run, and deletes the highest decision, item and run so the counters must survive.
function seedV19Links(db, { projects }) {
  db.prepare("UPDATE roadmap_items SET job_id = 1 WHERE id = 1").run();
  db.prepare("UPDATE roadmap_items SET decision_id = 3 WHERE id = 5").run();
  const itemProject = db.prepare("INSERT INTO roadmap_item_projects (item_id, project_id, job_id) VALUES (2, ?, ?)");
  itemProject.run(projects.nightqueue, 1);
  itemProject.run(projects["nq-web"], null);
  db.prepare("UPDATE decisions SET status = 'superseded', superseded_by = 2 WHERE id = 1").run();
  db.prepare("UPDATE decisions SET status = 'proposed', job_id = 1 WHERE id = 4").run();
  db.prepare("INSERT INTO roadmap_comments (item_id, kind, author, body) VALUES (2, 'note', 'job:1', 'a zebra crossed the org item')").run();
  db.prepare("INSERT INTO roadmap_comments (item_id, kind, author, body) VALUES (1, 'note', 'operator', 'a giraffe on the first item')").run();
  const run = db.prepare("INSERT INTO pipeline_runs (project_id, slug, tier, outcome, job_id) VALUES (?, ?, 'M', 'done', ?)");
  run.run(projects.nightqueue, "run-linked", 1);
  run.run(projects.nightqueue, "run-scratch", null);
  const phase = db.prepare("INSERT INTO pipeline_phases (run_id, seq, phase) VALUES (1, ?, ?)");
  phase.run(1, "triage");
  phase.run(2, "plan");
  db.prepare("INSERT INTO decisions (scope, project_id, number, title, context, decision) VALUES ('project', ?, 9, 'scratch', 'c', 'd')").run(projects.api);
  db.prepare("INSERT INTO roadmap_items (scope, project_id, number, title, position) VALUES ('project', ?, 99, 'scratch item', 1)").run(projects.api);
  db.exec("DELETE FROM decisions WHERE title = 'scratch'");
  db.exec("DELETE FROM roadmap_items WHERE title = 'scratch item'");
  db.exec("DELETE FROM pipeline_runs WHERE slug = 'run-scratch'");
}

// Builds a REAL v19 home: a v18 home migrated by the v19 step on a raw connection (never `openDb`, which would chain to v20),
// with a link on every column v20 converts. `extra(db, ids)` seeds more rows, orphans included, before the connection closes.
export function buildV19Home(env, { checkout = null, extra = null } = {}) {
  const ids = buildV18Home(env, { checkout });
  const db = new DatabaseSync(dbPath(env));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    migrateToV19(db, env);
    seedV19Links(db, ids);
    extra?.(db, ids);
    return ids;
  } finally {
    db.close();
  }
}
