import { sqliteToIso } from "./schema.mjs";

const ROW_MEASURES = Object.freeze([
  ["tokens_in", (m) => m.usage?.tokensIn],
  ["tokens_out", (m) => m.usage?.tokensOut],
  ["cache_read", (m) => m.usage?.cacheRead],
  ["cache_creation", (m) => m.usage?.cacheCreation],
  ["cost_usd", (m) => m.usage?.costUsd],
]);

const JOB_TOTALS = Object.freeze([
  ...ROW_MEASURES,
  ["bash_timeouts", (m) => m.hostCommands?.bashTimeouts],
  ["tasks_backgrounded", (m) => m.hostCommands?.tasksBackgrounded],
  ["tasks_killed", (m) => m.hostCommands?.tasksKilled],
  ["orch_turns", (m) => m.orchestrator?.turns],
  ["orch_reads", (m) => m.orchestrator?.reads],
  ["orch_bash", (m) => m.orchestrator?.bash],
  ["orch_bash_explore", (m) => m.orchestrator?.bashExplore],
]);

const MARK_MEASURED = `UPDATE job_attempts
    SET ${ROW_MEASURES.map(([column]) => `${column} = ?`).join(", ")}, measured = 1
  WHERE job_id = ? AND attempt = ? AND measured = 0`;

const ADD_TO_TOTALS = `UPDATE jobs
    SET ${JOB_TOTALS.map(([column]) => `${column} = COALESCE(${column} + ?, ?, ${column})`).join(", ")},
        orch_ctx_last = COALESCE(?, orch_ctx_last)
  WHERE id = ?`;

const CLOSE_OPEN_ATTEMPT = `UPDATE job_attempts
    SET finished_at = MAX(started_at, COALESCE(?, datetime('now'))), outcome = ?, exit_reason = ?
  WHERE job_id = ? AND finished_at IS NULL
  RETURNING attempt`;

const ATTEMPT_ROWS = `SELECT job_id, attempt, worker, session_id, started_at, finished_at, outcome, exit_reason, spawns,
       tokens_in, tokens_out, cache_read, cache_creation, cost_usd, fresh, backfilled,
       CASE WHEN finished_at IS NULL THEN NULL
            ELSE CAST(ROUND((julianday(finished_at) - julianday(started_at)) * 86400) AS INTEGER) END AS duration_s,
       CAST(ROUND((julianday(COALESCE(finished_at, datetime('now'))) - julianday(started_at)) * 86400) AS INTEGER) AS elapsed_s,
       CAST(strftime('%s', started_at) AS INTEGER) AS start_epoch,
       CAST(strftime('%s', COALESCE(finished_at, datetime('now'))) AS INTEGER) AS end_epoch
  FROM job_attempts WHERE job_id IN (SELECT value FROM json_each(?)) ORDER BY job_id, attempt`;

// The value of one measure when it is a usable number, null otherwise.
function measureOf(read, measures) {
  const value = read(measures);
  return Number.isFinite(value) ? value : null;
}

// Tells whether a write carries any measure at all; a gate before the spawn carries none.
function hasMeasures(measures) {
  return Boolean(measures && (measures.usage || measures.hostCommands || measures.orchestrator));
}

// Closes the open attempt row of a job with its outcome, at the given SQLite instant or now; the ordinal it closed, or null when none was open.
export function closeOpenAttempt(db, jobId, { outcome, exitReason = null, finishedAt = null }) {
  const row = db.prepare(CLOSE_OPEN_ATTEMPT).get(finishedAt, outcome, exitReason, jobId);
  return row ? Number(row.attempt) : null;
}

// Opens the attempt row of a claim just taken, closing a stale open one first, and answers its ordinal.
export function openAttempt(db, claimed) {
  closeOpenAttempt(db, claimed.id, { outcome: "lost", exitReason: "superseded" });
  const next = db.prepare("SELECT COALESCE(MAX(attempt), 0) + 1 AS next FROM job_attempts WHERE job_id = ?").get(claimed.id).next;
  db.prepare("INSERT INTO job_attempts (job_id, attempt, worker, started_at, fresh) VALUES (?, ?, ?, ?, ?)").run(
    claimed.id,
    next,
    claimed.worker,
    claimed.attempt_started_at,
    claimed.next_attempt_fresh === 1 ? 1 : 0,
  );
  if (claimed.next_attempt_fresh !== null && claimed.next_attempt_fresh !== undefined) {
    db.prepare("UPDATE jobs SET next_attempt_fresh = NULL WHERE id = ?").run(claimed.id);
  }
  return Number(next);
}

// Counts one more host spawn on the open attempt row of a job.
export function countSpawn(db, jobId) {
  db.prepare("UPDATE job_attempts SET spawns = spawns + 1 WHERE job_id = ? AND finished_at IS NULL").run(jobId);
}

// Records the session of the open attempt row of a job this worker runs.
export function noteAttemptSession(db, { jobId, worker, sessionId }) {
  if (typeof sessionId !== "string" || sessionId.trim() === "") return;
  db.prepare("UPDATE job_attempts SET session_id = ? WHERE job_id = ? AND worker = ? AND finished_at IS NULL").run(sessionId.trim(), jobId, worker);
}

// Adds the measures of one attempt to the job's totals, the last orchestrator context replacing the stored one.
function addToTotals(db, jobId, measures) {
  const totals = JOB_TOTALS.flatMap(([, read]) => [measureOf(read, measures), measureOf(read, measures)]);
  db.prepare(ADD_TO_TOTALS).run(...totals, measureOf((m) => m.orchestrator?.ctxLast, measures), jobId);
}

// Stores the measures of one attempt on its row and adds them to the job's totals, once: false when the row is gone, already measured, or nothing was measured.
export function applyMeasures(db, jobId, attempt, measures) {
  if (!Number.isInteger(attempt) || !hasMeasures(measures)) return false;
  const rowValues = ROW_MEASURES.map(([, read]) => measureOf(read, measures));
  if (db.prepare(MARK_MEASURED).run(...rowValues, jobId, attempt).changes !== 1) return false;
  addToTotals(db, jobId, measures);
  return true;
}

// Applies the measures of the claim a writer just ended: on the attempt row it closed, or straight to the totals when the claim had no open row.
export function settleMeasures(db, jobId, attempt, measures) {
  if (attempt !== null) return applyMeasures(db, jobId, attempt, measures);
  if (!hasMeasures(measures)) return false;
  addToTotals(db, jobId, measures);
  return true;
}

// Sets `attempt_rows` on every job row given, read in one statement; a row with no attempt gets an empty list.
export function attachAttemptRows(db, rows) {
  const jobs = rows.filter((row) => row && Number.isInteger(row.id));
  if (jobs.length === 0) return rows;
  const byJob = new Map(jobs.map((row) => [row.id, []]));
  for (const attempt of db.prepare(ATTEMPT_ROWS).all(JSON.stringify([...byJob.keys()]))) byJob.get(attempt.job_id)?.push(attempt);
  for (const row of jobs) row.attempt_rows = byJob.get(row.id);
  return rows;
}

// One attempt row as the public view shows it.
function attemptEntry(row) {
  return {
    attempt: row.attempt,
    worker: row.worker ?? null,
    session_id: row.session_id ?? null,
    started_at: sqliteToIso(row.started_at),
    finished_at: sqliteToIso(row.finished_at),
    duration_s: row.duration_s ?? null,
    outcome: row.outcome ?? null,
    exit_reason: row.exit_reason ?? null,
    spawns: Number(row.spawns ?? 1),
    tokens_in: row.tokens_in ?? null,
    tokens_out: row.tokens_out ?? null,
    cache_read: row.cache_read ?? null,
    cache_creation: row.cache_creation ?? null,
    cost_usd: row.cost_usd ?? null,
    fresh: row.fresh === 1,
    backfilled: row.backfilled === 1,
  };
}

// The active time of a job: the sum of its attempts' durations, the open one counted up to the read.
function activeSeconds(rows) {
  if (rows.length === 0) return null;
  return rows.reduce((sum, row) => sum + (Number.isFinite(row.elapsed_s) ? Math.max(0, row.elapsed_s) : 0), 0);
}

// The wall time of a job: from its first start to the end of its last attempt, the open one ending at the read.
function wallSeconds(startedAt, rows) {
  if (rows.length === 0) return null;
  const firstMs = Date.parse(sqliteToIso(startedAt) ?? "");
  const starts = rows.map((row) => row.start_epoch).filter(Number.isFinite);
  const start = Number.isFinite(firstMs) ? Math.floor(firstMs / 1000) : Math.min(...starts);
  const end = Math.max(...rows.map((row) => row.end_epoch).filter(Number.isFinite));
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

// The attempt keys of a job's view (`attempts_log`, `active_s`, `wall_s`), or none when the row was read without its attempts.
export function attemptViewKeys(row) {
  if (!Array.isArray(row?.attempt_rows)) return {};
  const rows = row.attempt_rows;
  return { attempts_log: rows.map(attemptEntry), active_s: activeSeconds(rows), wall_s: wallSeconds(row.started_at, rows) };
}
