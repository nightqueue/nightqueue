import { openDb } from "../src/memory/db.mjs";

const ROADMAP_TABLES = ["roadmap_items", "roadmap_item_projects", "roadmap_comments"];

// Deletes job rows through the memory connection, the way a lost write-ahead log leaves a job on disk with no row.
export function dropJobRows(env, ids) {
  const db = openDb(env);
  const statement = db.prepare("DELETE FROM jobs WHERE id = ?");
  for (const id of ids) {
    if (statement.run(id).changes !== 1) throw new Error(`dropJobRows: J-${id} had no row to drop`);
  }
}

// Every roadmap row and comment of a home as one string, so a test can prove a write left them byte-identical.
export function roadmapSnapshot(env) {
  const db = openDb(env);
  return JSON.stringify(ROADMAP_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
}

// The row of a job as the table holds it, or null when there is none.
export function jobRow(env, id) {
  return openDb(env).prepare("SELECT * FROM jobs WHERE id = ?").get(id) ?? null;
}
