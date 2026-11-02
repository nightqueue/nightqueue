import { UserError } from "../../config/errors.mjs";
import { preVersionBackupPath } from "../../config/paths.mjs";
import { hasColumn } from "../columns.mjs";
import { runOneShot, userVersion } from "./one-shot.mjs";

// The one-shot, version-gated migration of a v27 database to v28: `jobs.pipeline` names the pipeline a job runs, every existing
// job on `resolve`. Every job row is kept, nothing is written unless the whole of it commits, and a byte copy stays beside it as
// `nightqueue.db.pre-v28`.

export const V28 = 28;

export const JOBS_PIPELINE_COLUMN = "pipeline";
export const JOBS_PIPELINE_TYPE = "TEXT NOT NULL DEFAULT 'resolve'";

// Tells whether the database is exactly at v27, the only version this step migrates.
export function isPendingV28(db) {
  return userVersion(db) === 27;
}

// The number of job rows.
function jobCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
}

// Whether a home already holds the columns every open adds, which `pipeline` follows so a migrated table reads like a fresh one; a home coming up the chain takes it from that same per-open step, right after them.
function holdsPerOpenColumns(db) {
  return hasColumn(db, "jobs", "start_worktree");
}

// Checks the result against what was taken before: the column there when this step adds it, and every job kept.
function verifySchema(db, { jobsBefore }) {
  if (holdsPerOpenColumns(db) && !hasColumn(db, "jobs", JOBS_PIPELINE_COLUMN)) throw new UserError(`jobs: the column ${JOBS_PIPELINE_COLUMN} is not there`);
  const jobs = jobCount(db);
  if (jobs !== jobsBefore) throw new UserError(`jobs: ${jobs} rows after the migration, ${jobsBefore} before`);
}

// Every step that runs once the copy is published, inside the transaction: the column, the checks and the stamp.
function migrateInside(db, _env, { progress }) {
  const jobsBefore = jobCount(db);
  progress.step = "column";
  if (holdsPerOpenColumns(db) && !hasColumn(db, "jobs", JOBS_PIPELINE_COLUMN)) db.exec(`ALTER TABLE jobs ADD COLUMN ${JOBS_PIPELINE_COLUMN} ${JOBS_PIPELINE_TYPE}`);
  progress.step = "verify";
  verifySchema(db, { jobsBefore });
  db.exec(`PRAGMA user_version = ${V28}`);
}

const V28_STEP = Object.freeze({
  version: V28,
  backupPath: (env) => preVersionBackupPath(env, V28),
  isPending: isPendingV28,
  migrateInside,
});

// Migrates a v27 database to v28 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV28(db, env, { afterCommit } = {}) {
  return runOneShot(db, env, V28_STEP, { afterCommit });
}
