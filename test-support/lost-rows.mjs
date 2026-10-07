import { openDb } from "../src/memory/db.mjs";

// Deletes job rows through the memory connection, the way a lost write-ahead log leaves a job on disk with no row.
export function dropJobRows(env, ids) {
  const db = openDb(env);
  const statement = db.prepare("DELETE FROM jobs WHERE id = ?");
  for (const id of ids) {
    if (statement.run(id).changes !== 1) throw new Error(`dropJobRows: J-${id} had no row to drop`);
  }
}

// The row of a job as the table holds it, or null when there is none.
export function jobRow(env, id) {
  return openDb(env).prepare("SELECT * FROM jobs WHERE id = ?").get(id) ?? null;
}
