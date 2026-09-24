import { appendFileSync, mkdirSync } from "node:fs";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, logsDir, runDir } from "../config/paths.mjs";
import {
  finishVerificationReport,
  isoToSqlite,
  openDb,
  openDbReadOnly,
  sqliteToIso,
  withFullSync,
  withWriteRetry,
} from "./db.mjs";
import { RESULT_OBJECT_BASE } from "./schema.mjs";
import { isSafeSegment } from "../queue/resume.mjs";
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
  "worker",
  "operator_note",
  "blocked_code",
  "tokens_in",
  "tokens_out",
  "cache_read",
  "cache_creation",
  "cost_usd",
  "bash_timeouts",
  "tasks_backgrounded",
  "tasks_killed",
  "baseline_ctx",
  "orch_turns",
  "orch_reads",
  "orch_bash",
  "orch_bash_explore",
  "orch_ctx_last",
  "close_status",
  "close_worker",
];
const JOB_VIEW_TIMESTAMPS = ["created_at", "started_at", "finished_at", "lease_until", "not_before", "close_lease_until"];
const JOB_VIEW_TRUNCATED = ["notice_md", "result"];
const TRUNCATION_FLAGS = { notice_md: "notice_truncated", result: "result_truncated" };
// Host-command counters the view omits at zero, the same way a null one is left out: a regression shows only once there is one to show.
const JOB_VIEW_ZERO_OMITTED = ["bash_timeouts", "tasks_backgrounded", "tasks_killed"];
export const VIEW_TEXT_LIMIT = 500;
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

// Requires a status a generic writer may set: `closed` belongs to the closing pipeline alone.
function requireWritableStatus(status) {
  if (status === "closed") throw new UserError("status `closed` is written only by the closing pipeline; run nightshift queue close <id>");
  return requireStatus(status);
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

// The public view of a job: never the prompt, ISO timestamps, and free text cut for listings unless `full`, a cut field flagged `notice_truncated`/`result_truncated`.
export function jobView(row, { full = false } = {}) {
  if (!row) return null;
  const view = {};
  for (const column of JOB_VIEW_COLUMNS) view[column] = row[column] ?? null;
  for (const column of JOB_VIEW_ZERO_OMITTED) if (view[column] === 0) view[column] = null;
  for (const column of JOB_VIEW_TIMESTAMPS) view[column] = sqliteToIso(row[column]);
  for (const column of JOB_VIEW_TRUNCATED) {
    const whole = row[column] ?? null;
    view[column] = full ? whole : truncateByCodePoint(whole, VIEW_TEXT_LIMIT);
    if (view[column] !== whole) view[TRUNCATION_FLAGS[column]] = true;
  }
  view.close = parseCloseColumn(row.close);
  return view;
}

// The close checklist of a row as an object, or null when there is none or it is not a JSON object.
export function parseCloseColumn(text) {
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Requires the run slug a job starts bound to, when one was informed, as one safe path segment.
function optionalRunSlug(value) {
  if (value === undefined || value === null) return null;
  if (isSafeSegment(value)) return value;
  throw new UserError(`invalid \`slug\`: \`${String(value)}\`; expected one safe path segment`);
}

const INSERT_JOB = "INSERT INTO jobs (project, prompt, priority, max_attempts, timeout_s, tier, slug) VALUES (?, ?, ?, ?, ?, ?, ?)";

// Inserts one job row from its validated column values.
function insertJob(db, values) {
  const statement = db.prepare(INSERT_JOB);
  return withWriteRetry(() => statement.run(...values));
}

// Inserts a job bound to a run in the same transaction that proves no open job is bound to it already.
function insertRunJob(db, values, env) {
  const [project, , , , , , slug] = values;
  return inTransaction(db, () => {
    const bound = openJobForRun({ project, slug }, env, db);
    if (bound) throw new UserError(`job #${bound.id} already runs from ${runDir(project, slug, env)}`);
    return db.prepare(INSERT_JOB).run(...values);
  });
}

// Enqueues a job for a project, validating every range before the write; a run slug is refused while an open job is bound to it.
export function addJob({ project, prompt, priority, maxAttempts, timeoutS, tier, slug } = {}, env = process.env) {
  const values = [
    requireText("project", project),
    requireText("prompt", prompt),
    optionalRangedInt("priority", priority, PRIORITY_RANGE),
    optionalRangedInt("max_attempts", maxAttempts, MAX_ATTEMPTS_RANGE),
    optionalRangedInt("timeout_s", timeoutS, TIMEOUT_RANGE),
    optionalTier(tier),
    optionalRunSlug(slug),
  ];
  const inserted = values[6] === null ? insertJob(openDb(env), values) : insertRunJob(openDb(env), values, env);
  return {
    id: Number(inserted.lastInsertRowid),
    project: values[0],
    priority: values[2],
    maxAttempts: values[3],
    timeoutS: values[4],
    tier: values[5],
  };
}

// The job not yet closed that is bound to the run of a project and slug, or null when none is.
function openJobForRun({ project, slug } = {}, env = process.env, db = openDb(env)) {
  const row = db
    .prepare("SELECT id, status FROM jobs WHERE project = ? AND slug = ? AND status <> 'closed' ORDER BY id DESC LIMIT 1")
    .get(project, slug);
  return row ? { id: Number(row.id), status: row.status } : null;
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

// Records a fact discovered while the job runs (slug, first session or branch, each written only once) or the session and
// attempt of the run's latest attempt (`lastSessionId`/`lastSessionAttempt`), overwritten every time a new one opens.
export function persistRunFacts(id, { worker, slug, sessionId, branch, lastSessionId, lastSessionAttempt } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET slug = COALESCE(?, slug),
            session_id = COALESCE(?, session_id),
            branch = COALESCE(?, branch),
            last_session_id = COALESCE(?, last_session_id),
            last_session_attempt = COALESCE(?, last_session_attempt)
      WHERE id = ? AND worker = ?`,
  );
  const changed = withWriteRetry(() =>
    statement.run(
      optionalText(slug),
      optionalText(sessionId),
      optionalText(branch),
      optionalText(lastSessionId),
      optionalNumber(lastSessionAttempt),
      requireId(id),
      requireText("worker", worker),
    ),
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

// The witnessed columns of a write, in the fixed order the verification message prints them.
function describeColumns(columns, row) {
  return columns.map((column) => `${column}=${row?.[column] ?? "null"}`).join(" ");
}

// Reads the witnessed columns of a job through a connection of its own, so no cached snapshot answers for the file.
function readWitnessedColumns(id, columns, env) {
  const db = openDbReadOnly(env);
  try {
    return db.prepare(`SELECT ${columns.join(", ")} FROM jobs WHERE id = ?`).get(id) ?? null;
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
function verifyWitnessed(id, written, witness, env) {
  const read = readWitnessedColumns(id, witness.columns, env);
  if (read && witness.columns.every((column) => (read[column] ?? null) === (written[column] ?? null))) return true;
  reportFinishMismatch(id, `expected ${describeColumns(witness.columns, written)}; read ${describeColumns(witness.columns, read)}`, env);
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

const FINISH_WITNESS = { columns: FINISH_COLUMNS, reapply: reapplyFinish };

// Confirms on disk what a write committed and repairs it once through the witness's own re-apply; a failure that survives is logged, never a lost job.
function ensureDurable(id, written, witness, env) {
  try {
    if (verifyWitnessed(id, written, witness, env)) return true;
    witness.reapply(id, written, env);
    return verifyWitnessed(id, written, witness, env);
  } catch (err) {
    reportFinishMismatch(id, `expected ${describeColumns(witness.columns, written)}; read failed: ${err?.message ?? String(err)}`, env);
    return false;
  }
}

// Closes a job with its outcome and links the pipeline run, in one transaction; false means the job was lost.
export function finishJob(id, { worker, status, result, prUrl, noticeMd, usage, hostCommands, baselineCtx, orchestrator } = {}, env = process.env) {
  const db = openDb(env);
  const tokens = usage ?? {};
  const commands = hostCommands ?? {};
  const orch = orchestrator ?? {};
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
            cost_usd = COALESCE(?, cost_usd),
            bash_timeouts = COALESCE(?, bash_timeouts),
            tasks_backgrounded = COALESCE(?, tasks_backgrounded),
            tasks_killed = COALESCE(?, tasks_killed),
            baseline_ctx = COALESCE(?, baseline_ctx),
            orch_turns = COALESCE(?, orch_turns),
            orch_reads = COALESCE(?, orch_reads),
            orch_bash = COALESCE(?, orch_bash),
            orch_bash_explore = COALESCE(?, orch_bash_explore),
            orch_ctx_last = COALESCE(?, orch_ctx_last)
      WHERE id = ? AND status = 'running' AND worker = ?
      RETURNING project, slug, status, pr_url, finished_at`,
  );
  const values = [
    requireWritableStatus(status),
    toJsonText(result),
    optionalText(prUrl),
    optionalText(noticeMd),
    optionalNumber(tokens.tokensIn),
    optionalNumber(tokens.tokensOut),
    optionalNumber(tokens.cacheRead),
    optionalNumber(tokens.cacheCreation),
    optionalNumber(tokens.costUsd),
    optionalNumber(commands.bashTimeouts),
    optionalNumber(commands.tasksBackgrounded),
    optionalNumber(commands.tasksKilled),
    optionalNumber(baselineCtx),
    optionalNumber(orch.turns),
    optionalNumber(orch.reads),
    optionalNumber(orch.bash),
    optionalNumber(orch.bashExplore),
    optionalNumber(orch.ctxLast),
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
  ensureDurable(requireId(id), written, FINISH_WITNESS, env);
  return true;
}

// Explains, from the current row, why a cancel was refused; it never decides anything, only phrases it.
function cancelRefusal(id, row) {
  if (!row) return `unknown job \`${id}\``;
  if (row.status === "running") return `job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`;
  if (row.close_status === "closing" && closeLeaseLooksLive(row, Date.now())) {
    return `job \`${id}\` is being closed by \`${row.close_worker}\` until ${sqliteToIso(row.close_lease_until)}; wait for it or follow it with nightshift queue status ${id}`;
  }
  if (row.close_status === "closing") {
    return `job \`${id}\` has an interrupted close whose merge may already have happened; resume it with nightshift queue close ${id} - a merged pull request is recorded as closed, and one closed without merge cancels the job, so to cancel it close the pull request first`;
  }
  return `job \`${id}\` is already finished with status \`${row.status}\``;
}

// Cancels a pending, gated, done, failed or orphaned job, never one whose recorded close is in flight or interrupted; the decision is in the WHERE and a refusal writes nothing.
export function cancelJob(id, { reason } = {}, env = process.env) {
  const db = openDb(env);
  const statement = db.prepare(
    `UPDATE jobs
        SET result = json_set(${RESULT_OBJECT_BASE}, '$.cancelledFrom', status),
            status = 'cancelled',
            finished_at = COALESCE(finished_at, datetime('now')),
            operator_note = COALESCE(?, operator_note),
            worker = NULL,
            lease_until = NULL,
            close_status = NULL,
            close_worker = NULL,
            close_lease_until = NULL
      WHERE id = ? AND (status IN ('pending', 'gate', 'done', 'failed') OR (${ORPHAN_PREDICATE}))
        AND close_status IS NOT 'closing'
      RETURNING *, json_extract(result, '$.cancelledFrom') AS cancelled_from`,
  );
  const jobId = requireId(id);
  const row = withWriteRetry(() => statement.get(optionalText(reason), jobId));
  if (row) return { ...jobView(row), cancelled_from: row.cancelled_from ?? null };
  throw new UserError(cancelRefusal(jobId, getJob(jobId, env)));
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
const RETRY_FRESH_COLUMNS = ", slug = NULL, branch = NULL, session_id = NULL, last_session_id = NULL, last_session_attempt = NULL";

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

// A close lease is live while its close is `closing` and the lease has not passed yet, both sides compared on SQLite's own clock.
const CLOSE_LEASE_LIVE = `close_status = 'closing' AND close_lease_until IS NOT NULL AND datetime(close_lease_until) >= datetime('now')`;
const CLOSE_LEASE_EXPRESSION = `datetime('now', '+' || ? || ' seconds')`;
// The checklist a new close attempt re-arms: the JSON object already there, so the steps and data of an earlier attempt survive, or a fresh one.
const CLOSE_OBJECT_BASE = `CASE
              WHEN close IS NOT NULL AND json_valid(close) AND json_type(close) = 'object' THEN close
              ELSE '{"attempts":0,"steps":{},"data":{}}' END`;
const CLOSE_WITNESS_COLUMNS = ["close_status", "close", "close_worker", "close_lease_until"];
const TERMINAL_CLOSE_WITNESS_COLUMNS = [...CLOSE_WITNESS_COLUMNS, "status"];
const CLOSE_LEASE_RANGE = { min: 60, max: 7200 };

// Requires a lease length in seconds inside the accepted range, so a lease can never be written already expired or endless.
function requireLeaseSeconds(value) {
  if (Number.isInteger(value) && value >= CLOSE_LEASE_RANGE.min && value <= CLOSE_LEASE_RANGE.max) return value;
  throw new UserError(`invalid close lease \`${String(value)}\`; expected an integer between ${CLOSE_LEASE_RANGE.min} and ${CLOSE_LEASE_RANGE.max} seconds`);
}

// Serializes a close checklist, refusing anything that is not a plain object so a broken checklist is never stored.
function requireCloseText(close) {
  if (!close || typeof close !== "object" || Array.isArray(close)) throw new UserError("a close checklist must be a JSON object");
  return JSON.stringify(close);
}

// Tells whether a stored close lease is still in the future, for phrasing a refusal only; the lease decision itself is always the WHERE of a write.
function closeLeaseLooksLive(row, nowMs) {
  if (row?.close_status !== "closing" || !row.close_lease_until) return false;
  const until = Date.parse(sqliteToIso(row.close_lease_until));
  return Number.isFinite(until) && Number.isFinite(nowMs) && until >= nowMs;
}

// The refusal of a job whose status is not `done`, or null for a done one; only a done job with a pull request is closed.
function statusRefusal(id, row) {
  if (row.status === "done") return null;
  if (row.status === "closed") return `job \`${id}\` is already closed`;
  if (row.status === "running") return `job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`;
  if (row.status === "pending") return `job \`${id}\` is pending; it has not produced a pull request yet`;
  if (row.status === "gate") return `job \`${id}\` is waiting at a gate; answer it with nightshift queue retry ${id} --note "…", or cancel it`;
  if (row.status === "failed") return `job \`${id}\` failed; retry it or cancel it - only a done job is closed`;
  if (row.status === "cancelled") return `job \`${id}\` is cancelled; retry it before closing`;
  return `job \`${id}\` cannot be closed from status \`${row.status}\``;
}

// Explains, from the current row, why a close would be refused, or null when nothing refuses it; the lease itself is decided by `acquireClose`.
export function closeRefusal(id, row, { nowMs = Date.now() } = {}) {
  if (!row) return `unknown job \`${id}\``;
  const refusal = statusRefusal(id, row);
  if (refusal) return refusal;
  if (!row.pr_url) return "nothing to close: the job has no pull request";
  if (closeLeaseLooksLive(row, nowMs)) {
    return `job \`${id}\` is already being closed by \`${row.close_worker}\` until ${sqliteToIso(row.close_lease_until)}; follow it with nightshift queue status ${id}`;
  }
  return null;
}

// The checklist of a new close attempt: the stored one with its attempt counted and its last ending cleared.
const CLOSE_REARMED = `json_set(${CLOSE_OBJECT_BASE},
              '$.attempts', COALESCE(json_extract(${CLOSE_OBJECT_BASE}, '$.attempts'), 0) + 1,
              '$.startedAt', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
              '$.finishedAt', json('null'),
              '$.failed', json('null'))`;

// Takes the close lease of a done job in one compare-and-swap and re-arms its checklist for a new attempt, marking it `forced` for good once `--force` was passed; null means the WHERE refused and nothing was written.
export function acquireClose(id, { worker, leaseS, force = false } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET close_status = 'closing',
            close_worker = ?,
            close_lease_until = ${CLOSE_LEASE_EXPRESSION},
            close = CASE WHEN ? = 1 THEN json_set(${CLOSE_REARMED}, '$.forced', json('true')) ELSE ${CLOSE_REARMED} END
      WHERE id = ?
        AND pr_url IS NOT NULL
        AND status = 'done'
        AND (close_status IS NULL OR close_status = 'failed' OR (close_status = 'closing' AND NOT (${CLOSE_LEASE_LIVE})))
      RETURNING *`,
  );
  const values = [requireText("worker", worker), requireLeaseSeconds(leaseS), force === true ? 1 : 0, requireId(id)];
  return withWriteRetry(() => statement.get(...values)) ?? null;
}

// Confirms that the close lease of a job is held by this worker and renews it; false means the lease is not this worker's any more.
export function adoptClose(id, { worker, leaseS } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs SET close_lease_until = ${CLOSE_LEASE_EXPRESSION} WHERE id = ? AND close_status = 'closing' AND close_worker = ?`,
  );
  const values = [requireLeaseSeconds(leaseS), requireId(id), requireText("worker", worker)];
  return withWriteRetry(() => statement.run(...values)).changes === 1;
}

// Writes the witnessed close columns again, by id, only while no other worker took the close over in between.
function reapplyCloseColumns(id, written, columns, worker, env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs SET ${columns.map((column) => `${column} = ?`).join(", ")}
      WHERE id = ? AND (close_worker IS NULL OR close_worker = ?)`,
  );
  withWriteRetry(() => statement.run(...columns.map((column) => written[column] ?? null), id, worker));
}

// The witness of a close write: the columns a fresh connection must read back and the re-apply that repairs them once.
function closeWitness(columns, worker) {
  return { columns, reapply: (id, written, env) => reapplyCloseColumns(id, written, columns, worker, env) };
}

// Runs one close write fully synced inside a transaction and confirms it on disk; null means the WHERE refused it.
function writeCloseDurably({ id, statement, values, witness, env }) {
  const db = openDb(env);
  const written = withFullSync(db, () => inTransaction(db, () => statement.get(...values) ?? null));
  if (written) ensureDurable(id, written, witness, env);
  return written;
}

// Records the checklist after a step and renews the close lease, in one statement; false means the lease is not this worker's any more.
export function recordCloseStep(id, { worker, close, leaseS } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs SET close = ?, close_lease_until = ${CLOSE_LEASE_EXPRESSION}
      WHERE id = ? AND close_status = 'closing' AND close_worker = ?
      RETURNING ${CLOSE_WITNESS_COLUMNS.join(", ")}`,
  );
  const owner = requireText("worker", worker);
  const values = [requireCloseText(close), requireLeaseSeconds(leaseS), requireId(id), owner];
  return writeCloseDurably({ id, statement, values, witness: closeWitness(CLOSE_WITNESS_COLUMNS, owner), env }) !== null;
}

// Stops a close as failed, keeping its checklist and releasing the lease; false means the lease is not this worker's any more.
export function failClose(id, { worker, close } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs SET close_status = 'failed', close = ?, close_worker = NULL, close_lease_until = NULL
      WHERE id = ? AND close_status = 'closing' AND close_worker = ?
      RETURNING ${CLOSE_WITNESS_COLUMNS.join(", ")}`,
  );
  const owner = requireText("worker", worker);
  const values = [requireCloseText(close), requireId(id), owner];
  return writeCloseDurably({ id, statement, values, witness: closeWitness(CLOSE_WITNESS_COLUMNS, owner), env }) !== null;
}

// Closes a done job whose merge its checklist records, releases the lease and appends the settled line to its notice, in one statement; null means the WHERE refused it, and the schema refuses a checklist with no merge.
export function settleClose(id, { worker, close, noticeLine } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET status = 'closed',
            close_status = NULL,
            close = ?,
            close_worker = NULL,
            close_lease_until = NULL,
            notice_md = CASE
              WHEN notice_md IS NULL OR trim(notice_md) = '' THEN ?
              ELSE rtrim(notice_md, ' ' || char(10)) || char(10) || char(10) || ? END
      WHERE id = ? AND close_status = 'closing' AND close_worker = ? AND status = 'done'
      RETURNING *`,
  );
  const owner = requireText("worker", worker);
  const line = requireText("noticeLine", noticeLine);
  const values = [requireCloseText(close), line, line, requireId(id), owner];
  const row = writeCloseDurably({ id, statement, values, witness: closeWitness(TERMINAL_CLOSE_WITNESS_COLUMNS, owner), env });
  return row ? jobView(row, { full: true }) : null;
}

// Cancels a done job whose pull request a close step read closed without merge, keeping the checklist and releasing the lease, in one statement; null means the lease is not this worker's any more.
export function cancelOnClosedPr(id, { worker, close, note } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET result = json_set(${RESULT_OBJECT_BASE}, '$.cancelledFrom', status),
            status = 'cancelled',
            operator_note = ?,
            finished_at = COALESCE(finished_at, datetime('now')),
            close = ?,
            close_status = NULL,
            close_worker = NULL,
            close_lease_until = NULL
      WHERE id = ? AND status = 'done' AND close_status = 'closing' AND close_worker = ?
      RETURNING *`,
  );
  const owner = requireText("worker", worker);
  const values = [requireText("note", note), requireCloseText(close), requireId(id), owner];
  const row = writeCloseDurably({ id, statement, values, witness: closeWitness(TERMINAL_CLOSE_WITNESS_COLUMNS, owner), env });
  return row ? jobView(row, { full: true }) : null;
}

// Records where the settled close left the job's worktree; best effort, a failure never costs the close that already happened.
export function noteCloseWorktree(id, { worktree } = {}, env = process.env) {
  try {
    const statement = openDb(env).prepare(
      `UPDATE jobs SET close = json_set(close, '$.steps.settle.worktree', json(?))
        WHERE id = ? AND status = 'closed' AND json_valid(close) AND json_type(close, '$.steps.settle') = 'object'`,
    );
    return withWriteRetry(() => statement.run(JSON.stringify(worktree ?? null), requireId(id))).changes === 1;
  } catch {
    return false;
  }
}

// The closes in flight, failed or stalled, newest first, with the liveness of each lease read on SQLite's own clock.
export function listCloses(env = process.env, db = openDb(env)) {
  return db
    .prepare(
      `SELECT id, project, status, pr_url, close_status, close_worker, close_lease_until, close,
              CASE WHEN ${CLOSE_LEASE_LIVE} THEN 1 ELSE 0 END AS close_lease_live
         FROM jobs
        WHERE close_status IN ('closing', 'failed')
        ORDER BY id DESC LIMIT 50`,
    )
    .all();
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

// Done jobs that carry a pull request url, the candidates `queue close --merged` may confirm and close.
export function listCloseCandidates(env = process.env, db = openDb(env)) {
  return db.prepare("SELECT * FROM jobs WHERE status = 'done' AND pr_url IS NOT NULL ORDER BY id DESC").all();
}

// Unfinished jobs that already have a run directory; a job with no slug never ran, so no witness can speak for it.
export function listJobsWithSlug(env = process.env, db = openDb(env)) {
  return db.prepare("SELECT id, project, slug FROM jobs WHERE status IN ('running', 'pending') AND slug IS NOT NULL").all();
}

// Every job that is not closed and already named its run, the owners `nightshift doctor` checks a worktree against.
export function listOpenJobs(env = process.env, db = openDb(env)) {
  return db.prepare("SELECT id, project, slug, status FROM jobs WHERE status <> 'closed' AND slug IS NOT NULL").all();
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

// The terminal statuses `nightshift doctor` samples the host-command counters from; a job still `pending` or `running` has none to report yet.
const TERMINAL_STATUSES = JOB_STATUSES.filter((status) => status !== "pending" && status !== "running");
const TERMINAL_PLACEHOLDERS = TERMINAL_STATUSES.map(() => "?").join(", ");
export const HOST_COMMANDS_SAMPLE_SIZE = 20;

// The host-command counters of the most recently finished jobs, the sample `nightshift doctor` sums; a diagnosis never creates nor migrates the database it inspects.
export function recentHostCommandCounts(env = process.env, db = openDb(env)) {
  return db
    .prepare(
      `SELECT bash_timeouts, tasks_backgrounded, tasks_killed FROM jobs
        WHERE status IN (${TERMINAL_PLACEHOLDERS})
        ORDER BY id DESC LIMIT ${HOST_COMMANDS_SAMPLE_SIZE}`,
    )
    .all(...TERMINAL_STATUSES);
}

// The orchestrator counters of the most recently finished jobs, the sample `nightshift doctor` sums; a diagnosis never creates nor migrates the database it inspects.
export function recentOrchestratorCounts(env = process.env, db = openDb(env)) {
  return db
    .prepare(
      `SELECT orch_turns, orch_reads, orch_bash, orch_bash_explore, orch_ctx_last FROM jobs
        WHERE status IN (${TERMINAL_PLACEHOLDERS})
        ORDER BY id DESC LIMIT ${HOST_COMMANDS_SAMPLE_SIZE}`,
    )
    .all(...TERMINAL_STATUSES);
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
    requireWritableStatus(terminal?.status),
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
  const values = [requireWritableStatus(status), optionalText(prUrl), optionalText(noticeMd), requireId(id)];
  return withWriteRetry(() => statement.run(...values)).changes === 1;
}

// Moves a job's pull request attribution from one URL to another and swaps its one notice line, in a single compare-and-swap: a row whose URL differs or whose notice does not hold the line exactly once is refused and nothing is written.
export function correctJobPrAttribution(id, { fromUrl, toUrl, fromLine, toLine } = {}, env = process.env) {
  const statement = openDb(env).prepare(
    `UPDATE jobs
        SET pr_url = ?,
            notice_md = replace(notice_md, ?, ?)
      WHERE id = ? AND pr_url = ? AND instr(notice_md, ?) > 0
        AND instr(substr(notice_md, instr(notice_md, ?) + length(?)), ?) = 0`,
  );
  const from = requireText("fromLine", fromLine);
  const values = [
    requireText("toUrl", toUrl),
    from,
    requireText("toLine", toLine),
    requireId(id),
    requireText("fromUrl", fromUrl),
    from,
    from,
    from,
    from,
  ];
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
