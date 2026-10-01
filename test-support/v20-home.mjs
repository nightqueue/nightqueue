import { dbPath } from "../src/config/paths.mjs";
import { migrateToV20 } from "../src/memory/migration/v20.mjs";
import { buildV19Home, V19_LINKS } from "./v19-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

// The rows the v20 fixture links on purpose, named for the tests that follow them: the same links the v19 fixture carries.
export const V20_LINKS = V19_LINKS;

// Adds an org item with a project row and a comment, then deletes it, so the item, project-row and comment counters all run ahead of the rows.
function seedV20Scratch(db, { orgs, projects }) {
  const item = db
    .prepare("INSERT INTO roadmap_items (scope, org_id, number, title, position) VALUES ('org', ?, 50, 'scratch org item', 1)")
    .run(orgs.default);
  const itemId = Number(item.lastInsertRowid);
  db.prepare("INSERT INTO roadmap_item_projects (item_id, project_id) VALUES (?, ?)").run(itemId, projects.api);
  db.prepare("INSERT INTO roadmap_comments (item_id, kind, author, body) VALUES (?, 'note', 'operator', 'scratch comment')").run(itemId);
  db.prepare("DELETE FROM roadmap_items WHERE id = ?").run(itemId);
}

// Builds a REAL v20 home: a v19 home migrated by the v20 step on a raw connection (never `openDb`, which would chain to v21),
// with deleted highest rows in every tracker table. `extra(db, ids)` seeds more rows, orphans included, before the connection closes.
export function buildV20Home(env, { checkout = null, extra = null } = {}) {
  const ids = buildV19Home(env, { checkout });
  const db = new DatabaseSync(dbPath(env));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    migrateToV20(db, env);
    seedV20Scratch(db, ids);
    if (extra) {
      db.exec("PRAGMA foreign_keys = OFF");
      extra(db, ids);
    }
    return ids;
  } finally {
    db.close();
  }
}
