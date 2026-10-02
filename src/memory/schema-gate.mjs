import { existsSync } from "node:fs";
import { dbPath } from "../config/paths.mjs";
import { openDbReadOnly } from "./db.mjs";
import { hasTable } from "./migration/one-shot.mjs";
import { ACTIVE_JOB_PREDICATE } from "./schema.mjs";

const NO_ACTIVITY = Object.freeze({ liveJobs: [], staleRunning: [], liveCloses: [] });

const LIVE_CLOSE_PREDICATE = `close_worker IS NOT NULL AND close_lease_until IS NOT NULL
      AND datetime(close_lease_until) >= datetime('now')`;

// The column names of the jobs table, so a gate on an older schema only asks for the columns it has.
function jobColumns(db) {
  return new Set(db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name));
}

// The ids a query answers, in order.
function ids(db, sql) {
  return db.prepare(sql).all().map((row) => row.id);
}

// The jobs holding a live run lease, when the schema has leases at all.
function liveJobIds(db, columns) {
  if (!columns.has("lease_until")) return [];
  return ids(db, `SELECT slot.id AS id FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE} ORDER BY slot.id`);
}

// The jobs holding a live close lease (a close in flight, or the post-close hold of a closed row), when the schema has close leases.
function liveCloseIds(db, columns) {
  if (!columns.has("close_lease_until") || !columns.has("close_worker")) return [];
  return ids(db, `SELECT id FROM jobs WHERE ${LIVE_CLOSE_PREDICATE} ORDER BY id`);
}

// The activity of a home's database the schema migration must respect, read read-only on any schema: `{ liveJobs, staleRunning, liveCloses }`.
export function homeActivity(env = process.env) {
  if (!existsSync(dbPath(env))) return NO_ACTIVITY;
  const db = openDbReadOnly(env, { anySchema: true });
  try {
    if (!hasTable(db, "jobs")) return NO_ACTIVITY;
    const columns = jobColumns(db);
    const liveJobs = liveJobIds(db, columns);
    const running = ids(db, "SELECT id FROM jobs WHERE status = 'running' ORDER BY id");
    const staleRunning = running.filter((id) => !liveJobs.includes(id));
    return { liveJobs, staleRunning, liveCloses: liveCloseIds(db, columns) };
  } finally {
    db.close();
  }
}
