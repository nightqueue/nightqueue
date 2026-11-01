import { UserError } from "../../config/errors.mjs";
import { preVersionBackupPath } from "../../config/paths.mjs";
import { hasColumn } from "../columns.mjs";
import { JOBS_FTS, JOBS_FTS_BACKFILL, JOBS_FTS_DRIFT, JOBS_FTS_PRUNE } from "../ddl.mjs";
import { foreignKeyViolations, runOneShot, userVersion } from "./one-shot.mjs";

// The one-shot, version-gated migration of a v26 database to v27: `jobs.max_attempts` goes, since no attempt is bounded by a
// budget of its row any more; a home that came through v18 already lost it. Every job row is kept, nothing is written unless the
// whole of it commits, and a byte copy stays beside it as `nightqueue.db.pre-v27`.

export const V27 = 27;

const DROPPED_COLUMN = "max_attempts";

// Tells whether the database is exactly at v26, the only version this step migrates.
export function isPendingV27(db) {
  return userVersion(db) === 26;
}

// The number of job rows.
function jobCount(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
}

// Checks the result against what was taken before: the column gone, every job kept and indexed, no new foreign key break.
function verifySchema(db, { jobsBefore, violationsBefore }) {
  if (hasColumn(db, "jobs", DROPPED_COLUMN)) throw new UserError(`jobs: the column ${DROPPED_COLUMN} is still there`);
  const jobs = jobCount(db);
  if (jobs !== jobsBefore) throw new UserError(`jobs: ${jobs} rows after the migration, ${jobsBefore} before`);
  if (db.prepare(JOBS_FTS_DRIFT).get()) throw new UserError("jobs_fts: the index of the job history drifted from the jobs");
  const violations = foreignKeyViolations(db);
  if (violations > violationsBefore) throw new UserError(`${violations - violationsBefore} row(s) break a foreign key after the drop of ${DROPPED_COLUMN}`);
}

// Every step that runs once the copy is published, inside the transaction: the column, the job index, the checks and the stamp.
function migrateInside(db, env, { progress }) {
  const violationsBefore = foreignKeyViolations(db);
  const jobsBefore = jobCount(db);
  progress.step = "column";
  if (hasColumn(db, "jobs", DROPPED_COLUMN)) db.exec(`ALTER TABLE jobs DROP COLUMN ${DROPPED_COLUMN}`);
  progress.step = "index";
  db.exec(JOBS_FTS);
  db.exec(JOBS_FTS_PRUNE);
  db.exec(JOBS_FTS_BACKFILL);
  progress.step = "verify";
  verifySchema(db, { jobsBefore, violationsBefore });
  db.exec(`PRAGMA user_version = ${V27}`);
}

const V27_STEP = Object.freeze({
  version: V27,
  backupPath: (env) => preVersionBackupPath(env, V27),
  isPending: isPendingV27,
  migrateInside,
});

// Migrates a v26 database to v27 once and tells whether this call did it; the hooks are for tests only.
export function migrateToV27(db, env, { afterCommit } = {}) {
  return runOneShot(db, env, V27_STEP, { afterCommit });
}
