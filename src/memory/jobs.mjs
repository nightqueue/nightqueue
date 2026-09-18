import { appendFileSync, mkdirSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, logsDir } from "../config/paths.mjs";
import {
  finishVerificationReport,
  isoToSqlite,
  openDb,
  openDbReadOnly,
  sqliteToIso,
  withFullSync,
  withWriteRetry,
} from "./db.mjs";
import { PIPELINE_TIERS } from "./runs.mjs";

export const JOB_STATUSES = ["pending", "running", "done", "gate", "failed", "cancelled", "closed"];
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
  "tier",
  "attempts",
  "max_attempts",
  "timeout_s",
  "session_id",
  "slug",
  "branch",
  "pr_url",
  "merge_sha",
  "worker",
  "operator_note",
  "blocked_code",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "cache_creation",
  "cost_usd",
];
const JOB_VIEW_TIMESTAMPS = ["created_at", "started_at", "finished_at", "lease_until", "merged_at", "not_before"];
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

// Requires the operator's tier when one was informed; nothing informed stays null.
function optionalTier(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (PIPELINE_TIERS.includes(text)) return text;
  throw new UserError(`invalid \`tier\`: \`${text}\`; expected one of ${PIPELINE_TIERS.join("|")}`);
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
// The public view of a job: the prompt never, timestamps as ISO, and the free text cut for listings unless `full` asks for
// the whole thing - the detail of one job (`queue status <id>`) needs the entire notice, because that is where a gate is answered from.
export function jobView(row, { full = false } = {}) {
  if (!row) return null;
  const view = {};
  for (const column of JOB_VIEW_COLUMNS) view[column] = row[column] ?? null;
  for (const column of JOB_VIEW_TIMESTAMPS) view[column] = sqliteToIso(row[column]);
  for (const column of JOB_VIEW_TRUNCATED) view[column] = full ? (row[column] ?? null) : truncateByCodePoint(row[column] ?? null, VIEW_TEXT_LIMIT);
  return view;
}

// Enqueues a job for a project, validating every range before the write.
export function addJob({ project, prompt, priority, maxAttempts, timeoutS, tier } = {}, env = process.env) {
  const values = [
    requireText("project", project),
    requireText("prompt", prompt),
    optionalRangedInt("priority", priority, PRIORITY_RANGE),
    optionalRangedInt("max_attempts", maxAttempts, MAX_ATTEMPTS_RANGE),
    optionalRangedInt("timeout_s", timeoutS, TIMEOUT_RANGE),
    optionalTier(tier),
  ];
  const statement = openDb(env).prepare(
    "INSERT INTO jobs (project, prompt, priority, max_attempts, timeout_s, tier) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const inserted = withWriteRetry(() => statement.run(...values));
  return {
    id: Number(inserted.lastInsertRowid),
    project: values[0],
    priority: values[2],
    maxAttempts: values[3],
    timeoutS: values[4],
    tier: values[5],
  };
}

const CLAIM_ASSIGNMENT = `SET status = 'running',
            worker = ?,
            attempts = attempts + 1,
            started_at = datetime('now'),
            lease_until = ${LEASE_EXPRESSION},
            blocked_code = NULL`;
// A job parked by a rate limit is pending but not claimable yet: it comes back into scope by itself at the instant the limit resets.
const DUE_NOW = `(candidate.not_before IS NULL OR datetime(candidate.not_before) <= datetime('now'))`;
const CANDIDATE_QUERY = `SELECT candidate.id FROM jobs AS candidate
              WHERE candidate.status = 'pending' AND ${DUE_NOW}
              ORDER BY candidate.priority ASC, candidate.created_at ASC, candidate.id ASC
              LIMIT 1`;
const CAP_CONDITION = `(SELECT COUNT(*) FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE}) < ?`;

// Claims the highest priority pending job: the whole decision lives in the WHERE, bounded only by the ceiling when one is set.
export function claimNextJob({ worker, cap } = {}, env = process.env) {
  const ceiling = capClause(cap);
  const statement = openDb(env).prepare(
    `UPDATE jobs
        ${CLAIM_ASSIGNMENT}
      WHERE id = (${CANDIDATE_QUERY})
        AND status = 'pending'
        ${ceiling.sql}
      RETURNING *`,
  );
  return withWriteRetry(() => statement.get(requireText("worker", worker), ...ceiling.values)) ?? null;
}

// Claims one specific job, refusing in the same WHERE when it is not pending or the ceiling is full.
export function claimJobById(id, { worker, cap } = {}, env = process.env) {
  const ceiling = capClause(cap);
  const statement = openDb(env).prepare(
    `UPDATE jobs
        ${CLAIM_ASSIGNMENT}
      WHERE id = ?
        AND status = 'pending'
        ${ceiling.sql}
      RETURNING *`,
  );
  return withWriteRetry(() => statement.get(requireText("worker", worker), requireId(id), ...ceiling.values)) ?? null;
}

// The ceiling clause of a claim and the value it binds; a claim with no ceiling carries no clause and binds nothing.
function capClause(cap) {
  if (cap === null) return { sql: "", values: [] };
  return { sql: `AND ${CAP_CONDITION}`, values: [requireCap(cap)] };
}

// Requires a positive concurrency ceiling, because only an explicit null may lift it.
function requireCap(cap) {
  if (!Number.isInteger(cap) || cap <= 0) {
    throw new UserError(`invalid concurrency cap \`${String(cap)}\`; expected a positive integer, or null for no ceiling`);
  }
  return cap;
}

// Puts a claimed job back in the queue without spending the attempt, recording why it came back; `blockedCode` is written
// as given, never merged with what was there, so a release with no code of its own always clears a stale one from a prior attempt.
export function releaseJob(id, { worker, result, blockedCode } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET status = 'pending',
            worker = NULL,
            lease_until = NULL,
            started_at = NULL,
            attempts = MAX(0, attempts - 1),
            result = COALESCE(?, result),
            blocked_code = ?
      WHERE id = ? AND status = 'running' AND worker = ?`,
  );
  const changed = withWriteRetry(() =>
    statement.run(toJsonText(result), optionalText(blockedCode), requireId(id), requireText("worker", worker)),
  );
  return changed.changes === 1;
}

// Parks a claimed job on the instant a rate limit resets: it goes back to the queue without spending the attempt and is out of every claim until then.
export function parkJob(id, { worker, notBefore, result } = {}, env = process.env) {
  const due = isoToSqlite(notBefore);
  if (due === null) throw new UserError(`invalid \`notBefore\` \`${String(notBefore)}\`; expected an instant the job may be claimed again at`);
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET status = 'pending',
            worker = NULL,
            lease_until = NULL,
            started_at = NULL,
            attempts = MAX(0, attempts - 1),
            not_before = ?,
            result = COALESCE(?, result)
      WHERE id = ? AND status = 'running' AND worker = ?`,
  );
  const changed = withWriteRetry(() => statement.run(due, toJsonText(result), requireId(id), requireText("worker", worker)));
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

const FINISH_COLUMNS = ["status", "pr_url", "finished_at"];

// The terminal columns of a finish, in the fixed order the verification message prints them.
function describeFinish(row) {
  return FINISH_COLUMNS.map((column) => `${column}=${row?.[column] ?? "null"}`).join(" ");
}

// Reads the terminal columns of a job through a connection of its own, so no cached snapshot answers for the file.
function readFinishedColumns(id, env) {
  const db = openDbReadOnly(env);
  try {
    return db.prepare(`SELECT ${FINISH_COLUMNS.join(", ")} FROM jobs WHERE id = ?`).get(id) ?? null;
  } finally {
    db.close();
  }
}

// Appends a line to the log of a job; a log that cannot be written never costs the outcome it describes.
function appendJobLog(id, text, env) {
  try {
    mkdirSync(logsDir(env), { recursive: true });
    appendFileSync(jobLogPath(id, env), text);
  } catch {
    return;
  }
}

// Writes a verification failure where the operator reads it: the log of the job and the stderr of the runner.
function reportFinishMismatch(id, detail, env) {
  const text = finishVerificationReport(detail);
  appendJobLog(id, text, env);
  try {
    process.stderr.write(text);
  } catch {
    return;
  }
}

// Compares what the transaction committed with what a fresh connection reads back, reporting the difference.
function verifyFinish(id, written, env) {
  const read = readFinishedColumns(id, env);
  if (read && FINISH_COLUMNS.every((column) => (read[column] ?? null) === (written[column] ?? null))) return true;
  reportFinishMismatch(id, `expected ${describeFinish(written)}; read ${describeFinish(read)}`, env);
  return false;
}

// Writes the terminal columns again, by id: after a successful commit the claim predicate matches nothing anymore.
function reapplyFinish(id, written, env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET status = ?,
            pr_url = COALESCE(?, pr_url),
            finished_at = COALESCE(finished_at, ?),
            worker = NULL,
            lease_until = NULL
      WHERE id = ?`,
  );
  withWriteRetry(() => statement.run(written.status, written.pr_url ?? null, written.finished_at ?? null, id));
}

// Confirms on disk what the finish committed and repairs it once; a failure that survives is logged, never a lost job.
function ensureFinishDurable(id, written, env) {
  try {
    if (verifyFinish(id, written, env)) return true;
    reapplyFinish(id, written, env);
    return verifyFinish(id, written, env);
  } catch (err) {
    reportFinishMismatch(id, `expected ${describeFinish(written)}; read failed: ${err?.message ?? String(err)}`, env);
    return false;
  }
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
            not_before = NULL,
            result = COALESCE(?, result),
            pr_url = COALESCE(?, pr_url),
            notice_md = COALESCE(?, notice_md),
            tokens_in = COALESCE(?, tokens_in),
            tokens_out = COALESCE(?, tokens_out),
            cache_read = COALESCE(?, cache_read),
            cache_creation = COALESCE(?, cache_creation),
            cost_usd = COALESCE(?, cost_usd)
      WHERE id = ? AND status = 'running' AND worker = ?
      RETURNING project, slug, status, pr_url, finished_at`,
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
  const written = withFullSync(db, () =>
    inTransaction(db, () => {
      const row = statement.get(...values);
      if (row) linkRun(db, id, row.project, row.slug);
      return row ?? null;
    }),
  );
  if (!written) return false;
  ensureFinishDurable(requireId(id), written, env);
  return true;
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

// The terminal statuses a close may leave from; the same list the WHERE of the close and the candidates of `--merged` both filter by.
const CLOSABLE_STATUSES = ["done", "failed", "gate", "cancelled"];
const CLOSABLE_PLACEHOLDERS = CLOSABLE_STATUSES.map(() => "?").join(", ");

// Explains, from the current row, why a close was refused; it never decides anything, only phrases it.
function closeRefusal(id, row) {
  if (!row) return `unknown job \`${id}\``;
  if (row.status === "closed") return `job \`${id}\` is already closed`;
  if (row.status === "running") return `job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`;
  if (row.status === "pending") return `job \`${id}\` is pending; the queue still owes work for it`;
  return `job \`${id}\` cannot be closed from status \`${row.status}\``;
}

// Closes a job from any terminal status (done, failed, gate, cancelled), the operator's act that ends its life; the decision is in the WHERE and a refusal writes nothing.
export function closeJob(id, env = process.env) {
  const statement = openDb(env).prepare(`UPDATE jobs SET status = 'closed' WHERE id = ? AND status IN (${CLOSABLE_PLACEHOLDERS}) RETURNING *`);
  const jobId = requireId(id);
  const row = withWriteRetry(() => statement.get(jobId, ...CLOSABLE_STATUSES));
  if (row) return jobView(row);
  throw new UserError(closeRefusal(jobId, getJob(jobId, env)));
}

// Explains, from the current row, why a retry was refused; it never decides anything, only phrases it.
function retryRefusal(id, row, { note } = {}) {
  if (!row) return `unknown job \`${id}\``;
  if (row.status === "running") return `job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`;
  if (row.status === "pending") return `job \`${id}\` is already pending; there is nothing to retry`;
  if (row.status === "gate" && !note) {
    const reason = jobView(row).notice_md;
    const whole = reason && reason !== row.notice_md ? `Read the whole notice with: nightshift queue status ${id}.` : null;
    return [reason, whole, 'This job is waiting for a decision. Re-run with --note "<your answer>".'].filter(Boolean).join("\n");
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
            not_before = NULL,
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
export function getJob(id, env = process.env, db = openDb(env)) {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(requireId(id)) ?? null;
}

const BLOCKED_PENDING_PREDICATE = "status = 'pending' AND blocked_code IS NOT NULL";

// Returns the most recent jobs, newest first, or only the pending ones a preflight block is holding back with `blockedOnly`.
export function listJobs({ limit, blockedOnly } = {}, env = process.env, db = openDb(env)) {
  const clamped = optionalRangedInt("limit", limit, LIST_LIMIT_RANGE);
  const where = blockedOnly === true ? `WHERE ${BLOCKED_PENDING_PREDICATE} ` : "";
  return db.prepare(`SELECT * FROM jobs ${where}ORDER BY id DESC LIMIT ?`).all(clamped);
}

// Terminal jobs that still carry a pull request url, the candidates `queue close --merged` may confirm and close.
export function listCloseCandidates(env = process.env, db = openDb(env)) {
  return db
    .prepare(`SELECT * FROM jobs WHERE status IN (${CLOSABLE_PLACEHOLDERS}) AND pr_url IS NOT NULL ORDER BY id DESC`)
    .all(...CLOSABLE_STATUSES);
}

// Unfinished jobs that already have a run directory; a job with no slug never ran, so no witness can speak for it.
export function listJobsWithSlug(env = process.env, db = openDb(env)) {
  return db.prepare("SELECT id, project, slug FROM jobs WHERE status IN ('running', 'pending') AND slug IS NOT NULL").all();
}

// Reads the status of a job on the connection the caller holds; a job whose row is gone has no status at all.
// The freshness a follow needs lives in `withReadOnlyStore(env, fn)`, which hands every poll its own connection.
export function jobStatus(id, env = process.env, db = openDb(env)) {
  return db.prepare("SELECT status FROM jobs WHERE id = ?").get(id)?.status ?? null;
}

// Counts the jobs left `running` by a runner that died, on the connection the caller already holds: a diagnosis never creates nor migrates the database it inspects.
export function countOrphanJobs(db) {
  return db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${ORPHAN_PREDICATE}`).get().n;
}

// Counts the pending jobs a preflight block is holding back, the number the queue view shows next to `pending`.
export function countPendingBlocked(env = process.env, db = openDb(env)) {
  return db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE ${BLOCKED_PENDING_PREDICATE}`).get().n;
}

// Counts the jobs of every status, including the statuses with no row at all.
export function countsByStatus(env = process.env, db = openDb(env)) {
  const counts = {};
  for (const status of JOB_STATUSES) counts[status] = 0;
  for (const row of db.prepare("SELECT status, COUNT(*) AS total FROM jobs GROUP BY status").all()) {
    if (!JOB_STATUSES.includes(row.status)) continue;
    counts[row.status] = row.total;
  }
  return counts;
}

// Counts the jobs currently running under a live lease, the number the concurrency ceiling compares against.
export function countActiveJobs(env = process.env, db = openDb(env)) {
  return db.prepare(`SELECT COUNT(*) AS total FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE}`).get().total;
}

// Jobs running under a live lease, counted per project: with one job per runner, the runners working each repository right now.
export function countActiveJobsByProject(env = process.env, db = openDb(env)) {
  return db
    .prepare(`SELECT slot.project AS project, COUNT(*) AS count FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE} GROUP BY slot.project ORDER BY slot.project ASC`)
    .all()
    .map((row) => ({ project: row.project, count: Number(row.count) }));
}

// Id of the lowest numbered job running under a live lease, or null when none is: the job the install guard names.
export function firstActiveJobId(env = process.env) {
  const id = openDb(env).prepare(`SELECT MIN(slot.id) AS id FROM jobs AS slot WHERE ${ACTIVE_JOB_PREDICATE}`).get().id;
  return Number.isInteger(id) ? id : null;
}

// Tells whether this job is running under a live lease: the liveness predicate the ceiling counts, never the raw status.
export function isJobActive(id, env = process.env, db = openDb(env)) {
  const row = db.prepare(`SELECT COUNT(*) AS total FROM jobs AS slot WHERE slot.id = ? AND ${ACTIVE_JOB_PREDICATE}`).get(requireId(id));
  return row.total > 0;
}

// A retry writes `retriedFrom` in the same statement that flips the row back to pending, so a row carrying it was reopened after its witness was written and no witness speaks for it any more.
const NEVER_REOPENED_BY_RETRY = `json_extract(${RESULT_OBJECT_BASE}, '$.retriedFrom') IS NULL`;

// Restores a job from the witness its runner left on disk; it writes the row only, never the file, and never touches a job that already ended or that an operator just retried.
export function repairJobFromWitness(id, terminal, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET result = json_set(${RESULT_OBJECT_BASE}, '$.repairedFrom', 'state.json'),
            status = ?,
            pr_url = COALESCE(?, pr_url),
            finished_at = COALESCE(?, finished_at),
            worker = NULL,
            lease_until = NULL
      WHERE id = ? AND (status = 'running' OR (status = 'pending' AND ${NEVER_REOPENED_BY_RETRY}))`,
  );
  const values = [
    requireStatus(terminal?.status),
    optionalText(terminal?.prUrl),
    isoToSqlite(terminal?.finishedAt),
    requireId(id),
  ];
  return withWriteRetry(() => statement.run(...values)).changes === 1;
}

// Rewrites the outcome of a job re-derived from its own log; only a gated or failed row moves, and a refusal writes nothing.
export function reclassifyJob(id, { status, prUrl, noticeMd } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET result = json_set(${RESULT_OBJECT_BASE}, '$.reclassifiedFrom', status),
            status = ?,
            pr_url = COALESCE(?, pr_url),
            notice_md = COALESCE(?, notice_md)
      WHERE id = ? AND status IN ('gate', 'failed')`,
  );
  const values = [requireStatus(status), optionalText(prUrl), optionalText(noticeMd), requireId(id)];
  return withWriteRetry(() => statement.run(...values)).changes === 1;
}

// Tells whether some pending job is waiting to be claimed, which is what tells an empty queue from a full ceiling.
export function hasClaimablePending(env = process.env) {
  return Boolean(openDb(env).prepare(`${CANDIDATE_QUERY}`).get());
}

// Returns the job the next claim would pick, for the read-only report of `queue run --dry`.
export function peekNextJob(env = process.env) {
  return (
    openDb(env)
      .prepare(
        `SELECT candidate.* FROM jobs AS candidate
          WHERE candidate.status = 'pending' AND ${DUE_NOW}
          ORDER BY candidate.priority ASC, candidate.created_at ASC, candidate.id ASC
          LIMIT 1`,
      )
      .get() ?? null
  );
}
