import { UserError } from "../config/errors.mjs";
import {
  finishVerificationReport,
  isoToSqlite,
  openDb,
  openDbReadOnly,
  withFullSync,
  withWriteRetry,
} from "./db.mjs";
import { projectIdOrNull } from "./registry.mjs";

export const PIPELINE_TIERS = ["trivial", "simple", "complex"];
export const PIPELINE_TASK_TYPES = ["bug/error", "feature/refactor"];
export const OPERATOR_PIPELINE_OUTCOMES = ["investigated", "queued"];
export const PIPELINE_OUTCOMES = ["pr_opened", "local_commit", "no_commit", ...OPERATOR_PIPELINE_OUTCOMES];
export const PIPELINE_GATE_STOPS = ["critique", "triage", "architect", "qa", "verification", "runtime", "user"];
export const PIPELINE_PHASE_STATUSES = ["ok", "failed", "skipped"];

// Requires a value of an enum, naming the accepted values in the error.
function requireEnum(field, value, allowed) {
  if (allowed.includes(value)) return value;
  throw new UserError(`invalid \`${field}\`: \`${String(value)}\`; expected one of ${allowed.join("|")}`);
}

// Requires a value of an enum only when it was informed; absent stays null.
function optionalEnum(field, value, allowed) {
  if (value === undefined || value === null || value === "") return null;
  return requireEnum(field, value, allowed);
}

// Returns the integer as given, or null when the value is not a usable duration.
function optionalSeconds(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

// Returns the trimmed string, or null when there is nothing to store.
function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text : null;
}

// Validates every field of a run before any write, so an invalid enum never leaves an orphan row.
function validateRun({ slug, tier, tierOperator, taskType, outcome, gateStop, phases }) {
  const cleanSlug = optionalText(slug);
  if (!cleanSlug) throw new UserError("`slug` is required and cannot be empty");
  const list = Array.isArray(phases) ? phases : [];
  for (const phase of list) {
    if (!optionalText(phase?.phase)) throw new UserError("every phase needs a non-empty `phase` name");
    optionalEnum("status", phase?.status, PIPELINE_PHASE_STATUSES);
  }
  return {
    slug: cleanSlug,
    tier: requireEnum("tier", tier, PIPELINE_TIERS),
    tierOperator: optionalEnum("tier_operator", tierOperator, PIPELINE_TIERS),
    taskType: optionalEnum("task_type", taskType, PIPELINE_TASK_TYPES),
    outcome: requireEnum("outcome", outcome, PIPELINE_OUTCOMES),
    gateStop: optionalEnum("gate_stop", gateStop, PIPELINE_GATE_STOPS),
    phases: list,
  };
}

// Undoes a failed transaction without ever masking the error that caused it.
function rollbackQuietly(db) {
  try {
    db.exec("ROLLBACK");
  } catch {
    return;
  }
}

// Inserts the phases of a run that is already inside the transaction.
function insertPhases(db, runId, phases) {
  const statement = db.prepare(
    `INSERT INTO pipeline_phases (run_id, seq, phase, model, status, retry, duration_s, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  phases.forEach((phase, i) => {
    statement.run(
      runId,
      i + 1,
      String(phase.phase).trim(),
      optionalText(phase.model),
      optionalEnum("status", phase.status, PIPELINE_PHASE_STATUSES) ?? "ok",
      phase.retry === true || phase.retry === "true" ? 1 : 0,
      optionalSeconds(phase.duration_s ?? phase.durationS),
      optionalText(phase.note),
    );
  });
}

// Runs the steps inside one immediate transaction, so no reader is ever promoted to writer.
function inImmediateTransaction(db, steps) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = steps();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

// Inserts the run and its phases into a transaction that is already open.
function insertRunRows(db, { run, projectId, values }) {
  const inserted = db
    .prepare(
      `INSERT INTO pipeline_runs (project_id, slug, tier, tier_operator, tier_raise_reason, task_type, outcome, gate_stop, duration_s, model, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...values);
  const runId = Number(inserted.lastInsertRowid);
  insertPhases(db, runId, run.phases);
  return { runId, projectId, phases: run.phases.length };
}

// Writes the run and its phases inside one immediate transaction.
function insertRun(db, write) {
  return inImmediateTransaction(db, () => insertRunRows(db, write));
}

// Writes the run unless one was already recorded for its project and slug at or after `from`, the check and the insert in one transaction.
function insertRunOnce(db, write, from) {
  return inImmediateTransaction(db, () => {
    const seen = db
      .prepare("SELECT 1 FROM pipeline_runs WHERE project_id IS ? AND slug = ? AND datetime(created_at) >= datetime(?) LIMIT 1")
      .get(write.projectId, write.run.slug, from);
    return seen ? { skipped: true, projectId: write.projectId } : insertRunRows(db, write);
  });
}

// The column values of one pipeline run, in the order `insertRunRows` writes them; `origin` names the model and the session that ran it.
function runValues(run, owner, { tierRaiseReason, durationS }, origin) {
  return [
    owner,
    run.slug,
    run.tier,
    run.tierOperator,
    optionalText(tierRaiseReason),
    run.taskType,
    run.outcome,
    run.gateStop,
    optionalSeconds(durationS),
    optionalText(origin.model),
    optionalText(origin.sessionId),
  ];
}

// Reads a pipeline run back through a connection of its own, so no cached snapshot answers for the file.
function readRunRow(runId, env) {
  const db = openDbReadOnly(env);
  try {
    return db.prepare("SELECT slug, outcome FROM pipeline_runs WHERE id = ?").get(runId) ?? null;
  } finally {
    db.close();
  }
}

// Compares a committed run with what a fresh connection reads back; a read that fails is "unknown", never "absent".
function verifyRun(runId, expected, env) {
  let read = null;
  try {
    read = readRunRow(runId, env);
  } catch (err) {
    return { ok: false, absent: false, read: `read failed: ${err?.message ?? String(err)}` };
  }
  if (read && read.slug === expected.slug && read.outcome === expected.outcome) return { ok: true, absent: false, read: null };
  return { ok: false, absent: read === null, read: read ? `slug=${read.slug} outcome=${read.outcome}` : "no row" };
}

// Announces on stderr that a committed run did not read back, with the same literal a lost finish uses.
function reportRunMismatch(runId, expected, verified) {
  const detail = `expected run #${runId} slug=${expected.slug} outcome=${expected.outcome}; read ${verified.read}`;
  try {
    process.stderr.write(finishVerificationReport(detail));
  } catch {
    return;
  }
}

// Confirms the run landed on disk; only a row that is genuinely absent is inserted once more.
function ensureRunDurable(inserted, write, env) {
  const expected = { slug: write.run.slug, outcome: write.run.outcome };
  const verified = verifyRun(inserted.runId, expected, env);
  if (verified.ok) return inserted;
  reportRunMismatch(inserted.runId, expected, verified);
  if (!verified.absent) return inserted;
  const again = withFullSync(write.db, () => withWriteRetry(() => insertRun(write.db, write)));
  const reverified = verifyRun(again.runId, expected, env);
  if (!reverified.ok) reportRunMismatch(again.runId, expected, reverified);
  return again;
}

// The run a measured telemetry belongs to: the LAST one recorded for that project id and slug, since a retried job records a run of its own.
function lastRunId(db, projectId, slug) {
  const row = db.prepare("SELECT id FROM pipeline_runs WHERE project_id = ? AND slug = ? ORDER BY id DESC LIMIT 1").get(projectId, slug);
  return row ? Number(row.id) : null;
}

// Pairs each phase the runtime observed with the row the agent recorded under the same name, in `seq` order, so a phase that ran twice takes its two rows in order.
// A phase the runtime did not observe keeps what it holds, and a phase the agent never recorded has no row to write into and is dropped.
function matchPhases(stored, observed) {
  const pending = new Map();
  for (const row of stored) pending.set(row.phase, [...(pending.get(row.phase) ?? []), Number(row.id)]);
  const matched = [];
  for (const phase of observed) {
    const id = pending.get(String(phase?.phase ?? ""))?.shift();
    if (id === undefined) continue;
    matched.push({ id, durationS: optionalSeconds(phase.durationS), model: optionalText(phase.model) });
  }
  return matched;
}

// Writes the measured telemetry over the row the agent recorded: the runtime's value wins and the agent's survives only where the runtime measured none.
function updateTelemetry(db, { runId, durationS, phases }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE pipeline_runs SET duration_s = COALESCE(?, duration_s) WHERE id = ?").run(durationS, runId);
    const statement = db.prepare("UPDATE pipeline_phases SET duration_s = COALESCE(?, duration_s), model = COALESCE(?, model) WHERE id = ?");
    for (const phase of phases) statement.run(phase.durationS, phase.model, phase.id);
    db.exec("COMMIT");
    return { runId, phases: phases.length };
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
}

// Fills the telemetry of a run with what the runtime measured in the stream; a run the agent never recorded is left alone and never inserted.
export function updateRunTelemetry({ projectId, slug, durationS, phases = [] }, env = process.env) {
  const cleanSlug = optionalText(slug);
  if (!cleanSlug) throw new UserError("`slug` is required and cannot be empty");
  const owner = projectIdOrNull(projectId);
  const db = openDb(env);
  const runId = lastRunId(db, owner, cleanSlug);
  if (runId === null) return { runId: null, projectId: owner, phases: 0 };
  const stored = db.prepare("SELECT id, phase FROM pipeline_phases WHERE run_id = ? ORDER BY seq").all(runId);
  const matched = matchPhases(stored, Array.isArray(phases) ? phases : []);
  const written = withFullSync(db, () => withWriteRetry(() => updateTelemetry(db, { runId, durationS: optionalSeconds(durationS), phases: matched })));
  return { ...written, projectId: owner };
}

// The outcome of the latest run recorded for a project id and slug at or after an instant, or null when no run was recorded since then.
export function latestRunOutcome({ projectId, slug, since } = {}, env = process.env, db = openDb(env)) {
  const owner = projectIdOrNull(projectId);
  const cleanSlug = optionalText(slug);
  const from = isoToSqlite(since);
  if (!owner || !cleanSlug || !from) throw new UserError("latestRunOutcome needs a project id, a slug and a valid `since` instant");
  const row = db
    .prepare("SELECT outcome FROM pipeline_runs WHERE project_id = ? AND slug = ? AND datetime(created_at) >= datetime(?) ORDER BY id DESC LIMIT 1")
    .get(owner, cleanSlug, from);
  return row?.outcome ?? null;
}

// Persists the telemetry of one pipeline run of a project id (null for a global one): the run and its phases in a single transaction.
export function logPipelineRun(
  { projectId, slug, tier, tierOperator, tierRaiseReason, taskType, outcome, gateStop, durationS, phases = [] },
  env = process.env,
) {
  const run = validateRun({ slug, tier, tierOperator, taskType, outcome, gateStop, phases });
  const owner = projectIdOrNull(projectId);
  const values = runValues(run, owner, { tierRaiseReason, durationS }, { model: env?.NIGHTQUEUE_MODEL, sessionId: env?.NIGHTQUEUE_SESSION_ID });
  const db = openDb(env);
  const write = { db, run, projectId: owner, values };
  return ensureRunDurable(withFullSync(db, () => withWriteRetry(() => insertRun(db, write))), write, env);
}

// Persists a pipeline run queued while the database was unavailable, unless a run of the same project and slug was recorded since
// it was queued; `model` and `sessionId` travel in the spec, because the process replaying it is not the one that ran it.
export function logPipelineRunOnce(spec = {}, { since } = {}, env = process.env) {
  const run = validateRun(spec);
  const owner = projectIdOrNull(spec.projectId);
  const from = isoToSqlite(since);
  if (!from) throw new UserError(`logPipelineRunOnce needs the instant the run was queued at; got \`${String(since)}\``);
  const values = runValues(run, owner, spec, { model: spec.model, sessionId: spec.sessionId });
  const db = openDb(env);
  return withFullSync(db, () => withWriteRetry(() => insertRunOnce(db, { run, projectId: owner, values }, from)));
}
