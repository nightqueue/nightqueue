import { UserError } from "../config/errors.mjs";
import {
  finishVerificationReport,
  openDb,
  openDbReadOnly,
  resolveProjectName,
  withFullSync,
  withWriteRetry,
} from "./db.mjs";

export const PIPELINE_TIERS = ["trivial", "simple", "complex"];
export const PIPELINE_TASK_TYPES = ["bug/error", "feature/refactor"];
export const PIPELINE_OUTCOMES = ["pr_opened", "local_commit", "no_commit"];
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

// Writes the run and its phases inside one immediate transaction, so no reader is ever promoted to writer.
function insertRun(db, { run, projectName, values }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const inserted = db
      .prepare(
        `INSERT INTO pipeline_runs (project, slug, tier, tier_operator, tier_raise_reason, task_type, outcome, gate_stop, duration_s, model, session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(...values);
    const runId = Number(inserted.lastInsertRowid);
    insertPhases(db, runId, run.phases);
    db.exec("COMMIT");
    return { runId, project: projectName, phases: run.phases.length };
  } catch (err) {
    rollbackQuietly(db);
    throw err;
  }
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

// The run a measured telemetry belongs to: the LAST one recorded for that project and slug, since a retried job records a run of its own.
function lastRunId(db, project, slug) {
  const row = db.prepare("SELECT id FROM pipeline_runs WHERE project = ? AND slug = ? ORDER BY id DESC LIMIT 1").get(project, slug);
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
export function updateRunTelemetry({ project, slug, durationS, phases = [] }, env = process.env) {
  const cleanSlug = optionalText(slug);
  if (!cleanSlug) throw new UserError("`slug` is required and cannot be empty");
  const projectName = resolveProjectName(project, env);
  const db = openDb(env);
  const runId = lastRunId(db, projectName, cleanSlug);
  if (runId === null) return { runId: null, project: projectName, phases: 0 };
  const stored = db.prepare("SELECT id, phase FROM pipeline_phases WHERE run_id = ? ORDER BY seq").all(runId);
  const matched = matchPhases(stored, Array.isArray(phases) ? phases : []);
  const written = withFullSync(db, () => withWriteRetry(() => updateTelemetry(db, { runId, durationS: optionalSeconds(durationS), phases: matched })));
  return { ...written, project: projectName };
}

// Persists the telemetry of one pipeline run: the run and its phases in a single transaction.
export function logPipelineRun(
  { project, slug, tier, tierOperator, tierRaiseReason, taskType, outcome, gateStop, durationS, phases = [] },
  env = process.env,
) {
  const run = validateRun({ slug, tier, tierOperator, taskType, outcome, gateStop, phases });
  const projectName = resolveProjectName(project, env);
  const values = [
    projectName,
    run.slug,
    run.tier,
    run.tierOperator,
    optionalText(tierRaiseReason),
    run.taskType,
    run.outcome,
    run.gateStop,
    optionalSeconds(durationS),
    optionalText(env?.NIGHTSHIFT_MODEL),
    optionalText(env?.NIGHTSHIFT_SESSION_ID),
  ];
  const db = openDb(env);
  const write = { db, run, projectName, values };
  return ensureRunDurable(withFullSync(db, () => withWriteRetry(() => insertRun(db, write))), write, env);
}
