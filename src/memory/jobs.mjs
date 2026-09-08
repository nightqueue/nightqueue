import { UserError } from "../config/errors.mjs";
import { openDb, sqliteToIso, withWriteRetry } from "./db.mjs";

export const JOB_STATUSES = ["pending", "running", "done", "gate", "failed", "cancelled"];
export const PRIORITY_RANGE = { min: 1, max: 9, fallback: 5 };
export const MAX_ATTEMPTS_RANGE = { min: 1, max: 10, fallback: 1 };
export const TIMEOUT_RANGE = { min: 60, max: 86400, fallback: 14400 };
export const LEASE_SLACK_S = 600;
export const LEASE_GRACE_S = 60;

// Predicate of an active job for one alias: running under a lease still inside the grace window of its owner.
function activeFor(alias) {
  return `${alias}.status = 'running' AND ${alias}.lease_until IS NOT NULL
      AND datetime(${alias}.lease_until) > datetime('now', '-${LEASE_GRACE_S} seconds')`;
}

// Predicate of a project with no active job, correlated with the row of the given alias.
function projectFree(alias) {
  return `NOT EXISTS (SELECT 1 FROM jobs AS busy
             WHERE busy.project = ${alias}.project AND busy.id <> ${alias}.id AND ${activeFor("busy")})`;
}

// A job is active while it is running under a lease inside the grace window: the ceiling counts these.
export const ACTIVE_JOB_PREDICATE = activeFor("slot");

// A job is orphaned once its lease has been gone for longer than the grace window: its runner died.
export const ORPHAN_PREDICATE =
  `status = 'running' AND (lease_until IS NULL
     OR datetime(lease_until) < datetime('now', '-${LEASE_GRACE_S} seconds'))`;

// The `result` a cancel or a retry grafts its own field onto: the JSON object already there, or a new one keeping what was.
const RESULT_OBJECT_BASE = `CASE
              WHEN result IS NULL THEN '{}'
              WHEN json_valid(result) AND json_type(result) = 'object' THEN result
              ELSE json_object('previousResult', result) END`;

const LEASE_EXPRESSION = `datetime('now', '+' || (timeout_s + ${LEASE_SLACK_S}) || ' seconds')`;
const HARD_CEILING_OPEN = `datetime(started_at, '+' || (timeout_s + ${LEASE_SLACK_S}) || ' seconds') > datetime('now')`;

const JOB_VIEW_COLUMNS = [
  "id",
  "project",
  "status",
  "priority",
  "attempts",
  "max_attempts",
  "timeout_s",
  "session_id",
  "slug",
  "branch",
  "pr_url",
  "worker",
  "operator_note",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "cache_creation",
  "cost_usd",
];
const JOB_VIEW_TIMESTAMPS = ["created_at", "started_at", "finished_at", "lease_until"];
const JOB_VIEW_TRUNCATED = ["notice_md", "result"];
const VIEW_TEXT_LIMIT = 500;
const LIST_LIMIT_RANGE = { min: 1, max: 50, fallback: 10 };

// Requires a non-empty text field, because the column is NOT NULL and a raw SQLite error helps nobody.
function requireText(field, value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new UserError(`job field \`${field}\` is required and cannot be empty`);
  return text;
}

// Requires an integer job id, so a malformed reference never reaches the database.
function requireId(id) {
  if (!Number.isInteger(id) || id <= 0) throw new UserError(`expected a positive integer job id, got \`${String(id)}\``);
  return id;
}

// Requires an integer inside the accepted range, or falls back to the default when nothing was informed.
function optionalRangedInt(field, value, range) {
  if (value === undefined || value === null || value === "") return range.fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new UserError(`invalid \`${field}\`: \`${String(value)}\`; expected an integer between ${range.min} and ${range.max}`);
  }
  return parsed;
}

// Requires a value of an enum, naming the accepted values in the error.
function requireStatus(status) {
  if (JOB_STATUSES.includes(status)) return status;
  throw new UserError(`invalid job \`status\`: \`${String(status)}\`; expected one of ${JOB_STATUSES.join("|")}`);
}

// Returns the trimmed string, or null when there is nothing to store.
function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

// Returns the number as given, or null when the value is not a usable counter.
function optionalNumber(value) {
  return Number.isFinite(value) ? value : null;
}

// Serializes a result payload for the `result` column, accepting an object or an already encoded string.
function toJsonText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.trim() || null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

// Truncates by code point, so a surrogate pair is never cut in half by the view.
export function truncateByCodePoint(text, max = VIEW_TEXT_LIMIT) {
  if (typeof text !== "string" || !text) return text ?? null;
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max).join("")}...`;
}

// Undoes a failed transaction without ever masking the error that caused it.
function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
}

// Runs the given steps inside one immediate transaction, so no reader is ever promoted to writer.
function inTransaction(db, steps) {
  return withWriteRetry(() => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const value = steps();
      db.exec("COMMIT");
      return value;
    } catch (err) {
      rollbackQuietly(db);
      throw err;
    }
  });
}

// Public projection of a job row: allowlisted columns, ISO timestamps, truncated free text, never the prompt.
export function jobView(row) {
  if (!row) return null;
  const view = {};
  for (const column of JOB_VIEW_COLUMNS) view[column] = row[column] ?? null;
  for (const column of JOB_VIEW_TIMESTAMPS) view[column] = sqliteToIso(row[column]);
  for (const column of JOB_VIEW_TRUNCATED) view[column] = truncateByCodePoint(row[column] ?? null, VIEW_TEXT_LIMIT);
  return view;
}

// Enqueues a job for a project, validating every range before the write.
export function addJob({ project, prompt, priority, maxAttempts, timeoutS } = {}, env = process.env) {
  const values = [
    requireText("project", project),
    requireText("prompt", prompt),
    optionalRangedInt("priority", priority, PRIORITY_RANGE),
    optionalRangedInt("max_attempts", maxAttempts, MAX_ATTEMPTS_RANGE),
    optionalRangedInt("timeout_s", timeoutS, TIMEOUT_RANGE),
  ];
  const statement = openDb(env).prepare(
    "INSERT INTO jobs (project, prompt, priority, max_attempts, timeout_s) VALUES (?, ?, ?, ?, ?)",
  );
  const inserted = withWriteRetry(() => statement.run(...values));
  return { id: Number(inserted.lastInsertRowid), project: values[0], priority: values[2], maxAttempts: values[3], timeoutS: values[4] };
}

const CLAIM_ASSIGNMENT = `SET status = 'running',
            worker = ?,
            attempts = attempts + 1,
            started_at = datetime('now'),
            lease_until = ${LEASE_EXPRESSION}`;
const CANDIDATE_QUERY = `SELECT candidate.id FROM jobs AS candidate
              WHERE candidate.status = 'pending' AND ${projectFree("candidate")}
              ORDER BY candidate.priority ASC, candidate.created_at ASC, candidate.id ASC
              LIMIT 1`;
const CAP_CONDITION = `(SELECT COUNT(*) FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE}) < ?`;

// Claims the highest priority pending job of a free project: the whole decision lives in the WHERE.
export function claimNextJob({ worker, cap } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        ${CLAIM_ASSIGNMENT}
      WHERE id = (${CANDIDATE_QUERY})
        AND status = 'pending'
        AND ${projectFree("jobs")}
        AND ${CAP_CONDITION}
      RETURNING *`,
  );
  return withWriteRetry(() => statement.get(requireText("worker", worker), requireCap(cap))) ?? null;
}

// Claims one specific job, refusing in the same WHERE when it is not pending, its project is busy or the ceiling is full.
export function claimJobById(id, { worker, cap } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        ${CLAIM_ASSIGNMENT}
      WHERE id = ?
        AND status = 'pending'
        AND ${projectFree("jobs")}
        AND ${CAP_CONDITION}
      RETURNING *`,
  );
  return withWriteRetry(() => statement.get(requireText("worker", worker), requireId(id), requireCap(cap))) ?? null;
}

// Requires a positive concurrency ceiling, because a missing one would silently claim everything.
function requireCap(cap) {
  if (!Number.isInteger(cap) || cap <= 0) throw new UserError(`invalid concurrency cap \`${String(cap)}\`; expected a positive integer`);
  return cap;
}

// Puts a claimed job back in the queue without spending the attempt, recording why it came back.
export function releaseJob(id, { worker, result } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET status = 'pending',
            worker = NULL,
            lease_until = NULL,
            started_at = NULL,
            attempts = MAX(0, attempts - 1),
            result = COALESCE(?, result)
      WHERE id = ? AND status = 'running' AND worker = ?`,
  );
  const changed = withWriteRetry(() => statement.run(toJsonText(result), requireId(id), requireText("worker", worker)));
  return changed.changes === 1;
}

// Re-arms the lease of a job this worker still owns; false means the row moved on and the runner must stop.
export function renewLease(id, { worker } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs SET lease_until = ${LEASE_EXPRESSION} WHERE id = ? AND status = 'running' AND worker = ?`,
  );
  const changed = withWriteRetry(() => statement.run(requireId(id), requireText("worker", worker)));
  return changed.changes === 1;
}

// Spends one attempt of a job this worker still owns, at the start of every retry of the loop.
export function countAttempt(id, { worker } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs SET attempts = attempts + 1, lease_until = ${LEASE_EXPRESSION}
      WHERE id = ? AND status = 'running' AND worker = ?`,
  );
  const changed = withWriteRetry(() => statement.run(requireId(id), requireText("worker", worker)));
  return changed.changes === 1;
}

// Liveness seam of the sweep by default: without an implementation nothing is protected from recycling.
function neverLive() {
  return false;
}

// Applies the liveness seam to one worker; an implementation that throws or answers oddly never protects a job.
function isLiveWorker(liveWorkerImpl, worker) {
  try {
    return liveWorkerImpl(worker) === true;
  } catch {
    return false;
  }
}

// Placeholders of a variable id list, or an empty clause when there is nothing to exclude.
function excludeIdsClause(ids) {
  return ids.length ? ` AND id NOT IN (${ids.map(() => "?").join(", ")})` : "";
}

// Requeues every job whose runner died, failing the ones that already spent their own max_attempts.
export function sweepOrphans(env = process.env, { liveWorkerImpl = neverLive } = {}) {
  const db = openDb(env);
  const protectable = db.prepare(
    `SELECT id, worker FROM jobs WHERE ${ORPHAN_PREDICATE} AND started_at IS NOT NULL AND ${HARD_CEILING_OPEN}`,
  );
  return inTransaction(db, () => {
    const guarded = protectable.all().filter((row) => isLiveWorker(liveWorkerImpl, row.worker)).map((row) => row.id);
    const exclude = excludeIdsClause(guarded);
    const fail = db.prepare(
      `UPDATE jobs
          SET status = 'failed',
              finished_at = datetime('now'),
              worker = NULL,
              lease_until = NULL,
              result = '{"orphaned":true}'
        WHERE ${ORPHAN_PREDICATE} AND attempts >= max_attempts${exclude}`,
    );
    const requeue = db.prepare(
      `UPDATE jobs SET status = 'pending', worker = NULL, lease_until = NULL, started_at = NULL
        WHERE ${ORPHAN_PREDICATE}${exclude}`,
    );
    return { failed: fail.run(...guarded).changes, requeued: requeue.run(...guarded).changes };
  });
}

// Records a fact discovered while the job runs (slug, session or branch), each one written only once.
export function persistRunFacts(id, { worker, slug, sessionId, branch } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET slug = COALESCE(?, slug), session_id = COALESCE(?, session_id), branch = COALESCE(?, branch)
      WHERE id = ? AND worker = ?`,
  );
  const changed = withWriteRetry(() =>
    statement.run(optionalText(slug), optionalText(sessionId), optionalText(branch), requireId(id), requireText("worker", worker)),
  );
  return changed.changes === 1;
}

// Points the pipeline run of this project and slug at the job that produced it.
function linkRun(db, jobId, project, slug) {
  if (!project || !slug) return 0;
  return db
    .prepare("UPDATE pipeline_runs SET job_id = ? WHERE project = ? AND slug = ? AND job_id IS NULL")
    .run(jobId, project, slug).changes;
}

// Points the pipeline run of a project and slug at its job, for a caller outside the finish transaction.
export function linkPipelineRun(jobId, { project, slug } = {}, env = process.env) {
  const db = openDb(env);
  return inTransaction(db, () => linkRun(db, requireId(jobId), optionalText(project), optionalText(slug)));
}

// Closes a job with its outcome and links the pipeline run, in one transaction; false means the job was lost.
export function finishJob(id, { worker, status, result, prUrl, noticeMd, usage } = {}, env = process.env) {
  const db = openDb(env);
  const tokens = usage ?? {};
  const statement = db.prepare(
    `UPDATE jobs
        SET status = ?,
            finished_at = datetime('now'),
            worker = NULL,
            lease_until = NULL,
            result = COALESCE(?, result),
            pr_url = COALESCE(?, pr_url),
            notice_md = COALESCE(?, notice_md),
            tokens_in = COALESCE(?, tokens_in),
            tokens_out = COALESCE(?, tokens_out),
            cache_read = COALESCE(?, cache_read),
            cache_creation = COALESCE(?, cache_creation),
            cost_usd = COALESCE(?, cost_usd)
      WHERE id = ? AND status = 'running' AND worker = ?
      RETURNING project, slug`,
  );
  const values = [
    requireStatus(status),
    toJsonText(result),
    optionalText(prUrl),
    optionalText(noticeMd),
    optionalNumber(tokens.tokensIn),
    optionalNumber(tokens.tokensOut),
    optionalNumber(tokens.cacheRead),
    optionalNumber(tokens.cacheCreation),
    optionalNumber(tokens.costUsd),
    requireId(id),
    requireText("worker", worker),
  ];
  return inTransaction(db, () => {
    const row = statement.get(...values);
    if (!row) return false;
    linkRun(db, id, row.project, row.slug);
    return true;
  });
}

// Explains, from the current row, why a cancel was refused; it never decides anything, only phrases it.
function cancelRefusal(id, row) {
  if (!row) return `unknown job \`${id}\``;
  if (row.status === "running") return `job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`;
  return `job \`${id}\` is already finished with status \`${row.status}\``;
}

// Cancels a pending, gated or orphaned job; the decision is in the WHERE and a refusal writes nothing.
export function cancelJob(id, { reason } = {}, env = process.env) {
  const db = openDb(env);
  const statement = db.prepare(
    `UPDATE jobs
        SET result = json_set(${RESULT_OBJECT_BASE}, '$.cancelledFrom', status),
            status = 'cancelled',
            finished_at = COALESCE(finished_at, datetime('now')),
            operator_note = COALESCE(?, operator_note),
            worker = NULL,
            lease_until = NULL
      WHERE id = ? AND (status IN ('pending', 'gate') OR (${ORPHAN_PREDICATE}))
      RETURNING *`,
  );
  const jobId = requireId(id);
  const row = withWriteRetry(() => statement.get(optionalText(reason), jobId));
  if (row) return jobView(row);
  throw new UserError(cancelRefusal(jobId, getJob(jobId, env)));
}

// Explains, from the current row, why a retry was refused; it never decides anything, only phrases it.
function retryRefusal(id, row, { note } = {}) {
  if (!row) return `unknown job \`${id}\``;
  if (row.status === "running") return `job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`;
  if (row.status === "pending") return `job \`${id}\` is already pending; there is nothing to retry`;
  if (row.status === "gate" && !note) {
    const reason = jobView(row).notice_md;
    return [reason, 'This job is waiting for a decision. Re-run with --note "<your answer>".'].filter(Boolean).join("\n");
  }
  return `job \`${id}\` cannot be retried from status \`${row.status}\``;
}

// Columns a `--fresh` retry gives up, so the next run starts from phase 0 with a worktree of its own.
const RETRY_FRESH_COLUMNS = ", slug = NULL, branch = NULL, session_id = NULL";

// Sends a gated, failed or cancelled job back to the queue; the decision is in the WHERE and a refusal writes nothing.
export function retryJob(id, { note, fresh } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET result = json_set(${RESULT_OBJECT_BASE}, '$.retriedFrom', status),
            status = 'pending',
            worker = NULL,
            lease_until = NULL,
            started_at = NULL,
            finished_at = NULL,
            max_attempts = min(max_attempts + 1, ${MAX_ATTEMPTS_RANGE.max}),
            operator_note = ?${fresh === true ? RETRY_FRESH_COLUMNS : ""}
      WHERE id = ? AND (status IN ('failed', 'cancelled') OR (status = 'gate' AND ? IS NOT NULL))
      RETURNING *`,
  );
  const jobId = requireId(id);
  const answer = optionalText(note);
  const row = withWriteRetry(() => statement.get(answer, jobId, answer));
  if (row) return jobView(row);
  throw new UserError(retryRefusal(jobId, getJob(jobId, env), { note: answer }));
}

// Returns the raw row of a job, or null.
export function getJob(id, env = process.env) {
  return openDb(env).prepare("SELECT * FROM jobs WHERE id = ?").get(requireId(id)) ?? null;
}

// Returns the most recent jobs, newest first.
export function listJobs({ limit } = {}, env = process.env) {
  const clamped = optionalRangedInt("limit", limit, LIST_LIMIT_RANGE);
  return openDb(env).prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(clamped);
}

// Counts the jobs of every status, including the statuses with no row at all.
export function countsByStatus(env = process.env) {
  const counts = {};
  for (const status of JOB_STATUSES) counts[status] = 0;
  for (const row of openDb(env).prepare("SELECT status, COUNT(*) AS total FROM jobs GROUP BY status").all()) {
    if (!JOB_STATUSES.includes(row.status)) continue;
    counts[row.status] = row.total;
  }
  return counts;
}

// Counts the jobs currently running under a live lease, the number the concurrency ceiling compares against.
export function countActiveJobs(env = process.env) {
  return openDb(env).prepare(`SELECT COUNT(*) AS total FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE}`).get().total;
}

// Tells whether a project already has an active job, which is what makes a second job of the same repository wait.
export function isProjectBusy(project, env = process.env) {
  const row = openDb(env)
    .prepare(`SELECT COUNT(*) AS total FROM jobs AS busy WHERE busy.project = ? AND ${activeFor("busy")}`)
    .get(optionalText(project) ?? "");
  return row.total > 0;
}

// Tells whether some pending job could be claimed right now, that is, whether any of them has a free project.
export function hasClaimablePending(env = process.env) {
  return Boolean(openDb(env).prepare(`${CANDIDATE_QUERY}`).get());
}

// Returns the job the next claim would pick, for the read-only report of `queue run --dry`.
export function peekNextJob(env = process.env) {
  return (
    openDb(env)
      .prepare(
        `SELECT candidate.* FROM jobs AS candidate
          WHERE candidate.status = 'pending' AND ${projectFree("candidate")}
          ORDER BY candidate.priority ASC, candidate.created_at ASC, candidate.id ASC
          LIMIT 1`,
      )
      .get() ?? null
  );
}
