import { existsSync } from "node:fs";
import { dbPath } from "../config/paths.mjs";
import { loadRawConfig } from "../config/store.mjs";
import { hasCachedWriteConnection, openDb, openDbReadOnly, schemaVersionOn } from "./db.mjs";
import { hasLegacyRegistry } from "./migration/v18.mjs";
import * as registry from "./registry.mjs";
import { DB_USER_VERSION } from "./schema.mjs";

// Runs a registry read on a short-lived read-only connection when the database is current, answering null when it is not.
function readCurrent(env, read) {
  const db = openDbReadOnly(env);
  try {
    return schemaVersionOn(db) >= DB_USER_VERSION ? { value: read(db) } : null;
  } finally {
    db.close();
  }
}

// Runs a registry read on the connection it can use without writing anything it should not: the process's writable one when
// open, a short-lived read-only one on a current database, the writable one when there is something to migrate or import, and
// none (null) on a home with no database and nothing to import.
export function withRegistry(env, read) {
  if (hasCachedWriteConnection(env)) return read(openDb(env));
  if (!existsSync(dbPath(env))) return hasLegacyRegistry(loadRawConfig(env)) ? read(openDb(env)) : read(null);
  return (readCurrent(env, read) ?? { value: read(openDb(env)) }).value;
}

// The registered project with its org, by NAME, or null.
export function registeredProject(name, env = process.env) {
  if (typeof name !== "string" || !name) return null;
  return withRegistry(env, (db) => (db ? registry.projectByName(db, name) : null));
}

// The checkout of a job's project: the `project_path` a job view carries, or the registry's by its `project_id` for a job object that carries none.
export function checkoutOfJob(job, env = process.env) {
  if (job && Object.hasOwn(job, "project_path")) return job.project_path ?? null;
  if (!job?.project_id) return null;
  return withRegistry(env, (db) => (db ? registry.projectById(db, job.project_id) : null))?.path ?? null;
}

// Resolves the project of a working directory, or null when the directory is not inside a registered project.
export function projectFromCwd(cwd, env = process.env) {
  const target = typeof cwd === "string" ? cwd.trim() : "";
  if (!target) return null;
  return withRegistry(env, (db) => (db ? registry.projectAt(db, target) : null));
}
