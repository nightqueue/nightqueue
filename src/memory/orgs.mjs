import { existsSync } from "node:fs";
import { dbPath } from "../config/paths.mjs";
import { openDb, withWriteRetry } from "./db.mjs";

// The two tables that own rows by org name, which a rename must follow and a removal must never orphan.
export const ORG_TABLES = ["decisions", "roadmap_items"];

// Undoes a failed transaction without ever masking the error that caused it.
function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
}

// Rewrites the org of every decision and roadmap item a rename moves, both tables in one transaction; a home with no database has none.
export function renameOrgRows(env, oldName, newName) {
  if (!existsSync(dbPath(env))) return;
  const db = openDb(env);
  const statements = ORG_TABLES.map((table) => db.prepare(`UPDATE ${table} SET org = ? WHERE scope = 'org' AND org = ?`));
  withWriteRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) statement.run(newName, oldName);
      db.exec("COMMIT");
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
  });
}

// How many decisions and roadmap items an org still owns, per table and only where there is any.
export function orgRowCounts(env, name) {
  if (!existsSync(dbPath(env))) return [];
  const db = openDb(env);
  return ORG_TABLES.map((table) => ({
    table,
    total: db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE scope = 'org' AND org = ?`).get(name).total,
  })).filter((entry) => entry.total > 0);
}

// Org rows per name, from both tables and with no filtering, on the connection the caller already holds: a diagnosis never creates nor migrates the database it inspects.
export function orgRowCountsByOrg(db) {
  return ORG_TABLES.flatMap((table) =>
    db.prepare(`SELECT org, COUNT(*) AS total FROM ${table} WHERE scope = 'org' GROUP BY org`).all(),
  );
}
