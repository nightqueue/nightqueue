import { appendFileSync, mkdirSync } from "node:fs";
import { jobLogPath, logsDir } from "../config/paths.mjs";
import { openDb } from "../memory/db.mjs";
import { isJobActive, JOB_STATUSES, repairJobFromWitness } from "../memory/jobs.mjs";
import { readRunState } from "./resume.mjs";

export const REPAIR_FAILED_PREFIX = "could not repair a job from state.json";

// Statuses a witness may restore: a job that ended, never one the queue still owes work for.
const WITNESS_STATUSES = new Set(JOB_STATUSES.filter((status) => status !== "pending" && status !== "running"));

// Unfinished jobs that already have a run directory; a job with no slug never ran, so no witness can speak for it.
function candidateJobs(env) {
  return openDb(env)
    .prepare("SELECT id, project, slug FROM jobs WHERE status IN ('running', 'pending') AND slug IS NOT NULL")
    .all();
}

// The terminal section a runner wrote next to the run, or null when there is none worth trusting.
function readWitness(row, env) {
  const terminal = readRunState({ project: row.project, slug: row.slug, env })?.terminal;
  if (!terminal || typeof terminal !== "object" || Array.isArray(terminal)) return null;
  return WITNESS_STATUSES.has(terminal.status) ? terminal : null;
}

// Records in the log of the job that its row was rebuilt from the file the runner wrote.
function logRepair(id, terminal, env) {
  const detail = `status=${terminal.status} prUrl=${terminal.prUrl ?? "null"} finishedAt=${terminal.finishedAt ?? "null"}`;
  try {
    mkdirSync(logsDir(env), { recursive: true });
    appendFileSync(jobLogPath(id, env), `repaired from state.json: ${detail} writtenBy=${terminal.writtenBy ?? "null"} pid=${terminal.pid ?? "null"}\n`);
  } catch {
    return;
  }
}

// Restores one job from its witness; a job under a live lease is left alone and a failure of its own is reported, never raised.
function repairOne(row, env) {
  try {
    if (isJobActive(row.id, env)) return { repaired: false, error: null };
    const terminal = readWitness(row, env);
    if (!terminal || !repairJobFromWitness(row.id, terminal, env)) return { repaired: false, error: null };
    logRepair(row.id, terminal, env);
    return { repaired: true, error: null };
  } catch (err) {
    return { repaired: false, error: `job #${row.id}: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}

// Restores every unfinished job whose run directory already says how it ended; the file is the witness and the row never writes back to it.
export function reconcileFromWitness(env = process.env) {
  let rows = [];
  try {
    rows = candidateJobs(env);
  } catch (err) {
    return { repaired: [], error: String(err?.message ?? err).split("\n")[0] };
  }
  const repaired = [];
  let error = null;
  for (const row of rows) {
    const outcome = repairOne(row, env);
    if (outcome.repaired) repaired.push(row.id);
    if (outcome.error && !error) error = outcome.error;
  }
  return { repaired, error };
}

// Reconciles and phrases the one line every surface says when a repair could not be written, or null when nothing failed.
export function repairWarningLine(env = process.env) {
  const outcome = reconcileFromWitness(env);
  return outcome.error ? `${REPAIR_FAILED_PREFIX}: ${outcome.error}` : null;
}
