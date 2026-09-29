import { dbPath } from "../src/config/paths.mjs";
import { newId } from "../src/config/ids.mjs";
import { migrateToV18 } from "../src/memory/migration/v18.mjs";
import { buildLegacyHome } from "./legacy-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

// Registers the two orgs and three projects of the fixture by raw v18 SQL and answers their ids by name.
function seedRegistry(db, { checkout }) {
  const orgs = { default: db.prepare("SELECT id FROM orgs WHERE name = 'default'").get().id, dlweb: newId() };
  db.prepare("INSERT INTO orgs (id, name, created_at) VALUES (?, 'dlweb', datetime('now', '+1 second'))").run(orgs.dlweb);
  const projects = { nightqueue: newId(), api: newId(), "nq-web": newId() };
  const project = db.prepare("INSERT INTO projects (id, name, path, org_id) VALUES (?, ?, ?, ?)");
  project.run(projects.nightqueue, "nightqueue", checkout, orgs.dlweb);
  project.run(projects.api, "api", null, orgs.default);
  project.run(projects["nq-web"], "nq-web", null, orgs.dlweb);
  return { orgs, projects };
}

// Seeds roadmap items of every owner interleaved, so per-owner numbering cannot follow the id order by accident.
function seedItems(db, { orgs, projects }) {
  const item = db.prepare("INSERT INTO roadmap_items (scope, project_id, org_id, title, position) VALUES (?, ?, ?, ?, 1)");
  const owners = [
    ["project", projects.nightqueue, null],
    ["org", null, orgs.dlweb],
    ["project", null, null],
    ["project", projects.api, null],
    ["project", projects.nightqueue, null],
    ["org", null, orgs.dlweb],
    ["project", null, null],
    ["project", projects.nightqueue, null],
  ];
  owners.forEach(([scope, projectId, orgId], index) => item.run(scope, projectId, orgId, `item ${index + 1}`));
  db.exec("DELETE FROM roadmap_items WHERE id = 4");
}

// Seeds decisions of a project, an org and the global owner, jobs and comments.
function seedHistory(db, { orgs, projects }) {
  const decision = db.prepare("INSERT INTO decisions (scope, project_id, org_id, number, title, context, decision) VALUES (?, ?, ?, ?, ?, 'c', 'd')");
  decision.run("project", projects.nightqueue, null, 1, "first");
  decision.run("project", projects.nightqueue, null, 2, "second");
  decision.run("org", null, orgs.dlweb, 1, "org first");
  decision.run("project", null, null, 1, "global first");
  const job = db.prepare("INSERT INTO jobs (project_id, prompt, status) VALUES (?, ?, ?)");
  job.run(projects.nightqueue, "a done job", "done");
  job.run(projects.api, "a failed job", "failed");
  const comment = db.prepare("INSERT INTO roadmap_comments (item_id, kind, author, body) VALUES (?, 'note', 'operator', ?)");
  comment.run(1, "queued as job #1");
  comment.run(2, "an org note");
}

// Builds a REAL v18 home: a v17 home migrated by the v18 step on a raw connection (never `openDb`, which would chain to v19),
// then seeded by id with raw SQL. `extra(db, ids)` seeds more rows before the connection closes.
export function buildV18Home(env, { checkout = null, extra = null } = {}) {
  buildLegacyHome(env);
  const db = new DatabaseSync(dbPath(env));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    migrateToV18(db, env);
    const ids = seedRegistry(db, { checkout });
    seedItems(db, ids);
    seedHistory(db, ids);
    extra?.(db, ids);
    return ids;
  } finally {
    db.close();
  }
}
