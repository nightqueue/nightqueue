import { appendFileSync, mkdirSync } from "node:fs";
import { jobLogPath, logsDir } from "../config/paths.mjs";
import { openStore } from "../store/open.mjs";
import { ownRunState } from "./resume.mjs";

export const REPAIR_FAILED_PREFIX = "could not repair a job from state.json";

// Statuses a witness may restore: a job a run ended, never one the queue still owes work for nor one only the operator closes.
const WITNESS_STATUSES = new Set(["done", "gate", "failed", "cancelled"]);

// The terminal section a runner wrote next to the run, or null when there is none worth trusting.
function readWitness(row, env) {
  const terminal = ownRunState({ project: row.project, slug: row.slug, jobId: row.id, env })?.terminal;
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
async function repairOne(row, { readStore, writeStore, env }) {
  try {
    if (await readStore.jobs.isJobActive(row.id)) return { repaired: false, error: null };
    const terminal = readWitness(row, env);
    if (!terminal || !(await writeStore.jobs.repairJobFromWitness(row.id, terminal))) return { repaired: false, error: null };
    logRepair(row.id, terminal, env);
    return { repaired: true, error: null };
  } catch (err) {
    return { repaired: false, error: `job #${row.id}: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}

// Restores every unfinished job whose run directory already says how it ended; the file is the witness and the row never writes back to it.
export async function reconcileFromWitness(env = process.env, { readStore = null, writeStore = null } = {}) {
  let stores = null;
  let rows = [];
  try {
    stores = { readStore: readStore ?? openStore(env), writeStore: writeStore ?? openStore(env), env };
    rows = await stores.readStore.jobs.listWithSlug();
  } catch (err) {
    return { repaired: [], error: String(err?.message ?? err).split("\n")[0] };
  }
  const repaired = [];
  let error = null;
  for (const row of rows) {
    const outcome = await repairOne(row, stores);
    if (outcome.repaired) repaired.push(row.id);
    if (outcome.error && !error) error = outcome.error;
  }
  return { repaired, error };
}

// Reconciles and phrases the one line every surface says when a repair could not be written, or null when nothing failed.
export async function repairWarningLine(env = process.env, stores = {}) {
  const outcome = await reconcileFromWitness(env, stores);
  return outcome.error ? `${REPAIR_FAILED_PREFIX}: ${outcome.error}` : null;
}
