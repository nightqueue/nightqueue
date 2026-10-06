import { addColumnIfMissing } from "../columns.mjs";
import { inTransaction } from "../tx.mjs";

const UNRECORDED_JOB = `jobs.started_at IS NOT NULL AND jobs.status <> 'pending'
  AND NOT EXISTS (SELECT 1 FROM job_attempts AS a WHERE a.job_id = jobs.id)`;

// A column of the job copied onto its backfilled row, left empty for a running job whose attempt has not been measured yet.
function unlessRunning(column) {
  return `CASE WHEN status = 'running' THEN NULL ELSE ${column} END`;
}

const BACKFILL_ATTEMPTS = `INSERT INTO job_attempts
    (job_id, attempt, worker, started_at, finished_at, outcome, spawns,
     tokens_in, tokens_out, cache_read, cache_creation, cost_usd, measured, backfilled)
  SELECT id, 1, worker, started_at,
         CASE WHEN status = 'running' THEN NULL ELSE COALESCE(finished_at, started_at) END,
         CASE WHEN status = 'closed' THEN 'done' WHEN status IN ('done', 'gate', 'failed', 'cancelled') THEN status END,
         1, ${unlessRunning("tokens_in")}, ${unlessRunning("tokens_out")}, ${unlessRunning("cache_read")},
         ${unlessRunning("cache_creation")}, ${unlessRunning("cost_usd")}, CASE WHEN status = 'running' THEN 0 ELSE 1 END, 1
    FROM jobs WHERE ${UNRECORDED_JOB}`;

const UNANCHORED_RUNNING = "status = 'running' AND attempt_started_at IS NULL AND started_at IS NOT NULL";

// Adds the v23 columns and backfills the attempt history of older jobs on every open, each write behind a read that finds nothing once done.
export function migrateV23(db) {
  addColumnIfMissing(db, "jobs", "attempt_started_at", "TEXT");
  addColumnIfMissing(db, "jobs", "next_attempt_fresh", "INTEGER");
  backfillAttempts(db);
  backfillAttemptStart(db);
}

// Records the last attempt of every job that ran before v23 as its one backfilled attempt row, its usage already counted in the job's totals.
function backfillAttempts(db) {
  if (!db.prepare(`SELECT 1 FROM jobs WHERE ${UNRECORDED_JOB} LIMIT 1`).get()) return;
  inTransaction(db, () => db.prepare(BACKFILL_ATTEMPTS).run());
}

// Anchors the orphan ceiling of a job that was running at migration time on the start of its claim.
function backfillAttemptStart(db) {
  if (!db.prepare(`SELECT 1 FROM jobs WHERE ${UNANCHORED_RUNNING} LIMIT 1`).get()) return;
  inTransaction(db, () => db.prepare(`UPDATE jobs SET attempt_started_at = started_at WHERE ${UNANCHORED_RUNNING}`).run());
}
