import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, logsDir, runDir } from "../config/paths.mjs";
import { packageRoot } from "../host/paths.mjs";
import { sqliteToIso } from "../memory/schema.mjs";
import { openStore } from "../store/open.mjs";
import { classifyJobResult } from "./classify.mjs";
import { deriveRecovered, findLostJobs, scanDisk, stillRunningCheck } from "./lost-rows.mjs";
import { replayAllPendingWrites } from "./pending-writes.mjs";
import { isRunPath, ownRunState, readRunState, writeRunTerminal } from "./resume.mjs";
import { lastAttemptStream } from "./stream.mjs";
import { jobRef } from "../memory/refs.mjs";

// Statuses a re-classification may correct: a row that ended badly, never one the queue still owes work for.
const REPAIRABLE_STATUSES = new Set(["gate", "failed"]);

// The `result` the finish recorded, as an object; anything else is no ending to re-derive from.
function parseResult(value) {
  try {
    const parsed = JSON.parse(String(value ?? ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// How the process of the last attempt ended, taken from the row: the repair re-reads the stream, never the ending.
function endingFromRow(id, row) {
  const result = parseResult(row.result);
  if (!Number.isInteger(result?.exitCode)) {
    throw new UserError(`job \`${id}\` recorded no exit code; there is no ending to re-classify it against`);
  }
  return { exitCode: result.exitCode, timedOut: result.timedOut === true, idleTimedOut: result.idleTimedOut === true, stopped: false };
}

// The persisted stream of a job, the raw evidence the re-classification reads.
function readJobLog(id, env) {
  const path = jobLogPath(id, env);
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw new UserError(`the log of job \`${id}\` is not on disk (${path}); there is nothing to re-classify`);
  }
}

// Refuses, by name, every row a re-classification must never rewrite.
function refuseRow(id, row, active) {
  if (active) throw new UserError(`job \`${id}\` is running with a live lease on worker \`${row.worker}\`; stop that runner first`);
  if (!REPAIRABLE_STATUSES.has(row.status)) {
    throw new UserError(`job \`${id}\` is \`${row.status}\`; only a \`gate\` or a \`failed\` job is re-classified`);
  }
}

// Tells whether the re-derived outcome says anything the witness next to the run does not already say.
function differsFromWitness(row, outcome) {
  if (outcome.status !== row.status) return true;
  return Boolean(outcome.prUrl) && outcome.prUrl !== row.pr_url;
}

// Tells whether the re-derived notice corrects the one the row carries; an outcome with no notice never erases one.
function noticeDiffers(row, outcome) {
  return Boolean(outcome.noticeMd) && outcome.noticeMd !== row.notice_md;
}

// Rewrites the witness next to the run, so the file and the row agree once the repair has written both.
function mirrorWitness(row, outcome, env) {
  return writeRunTerminal({
    projectId: row.project_id,
    slug: row.slug,
    terminal: {
      status: outcome.status,
      prUrl: outcome.prUrl ?? null,
      finishedAt: sqliteToIso(row.finished_at) ?? new Date().toISOString(),
      writtenBy: packageRoot(),
      pid: process.pid,
      jobId: row.id,
    },
    env,
  });
}

// The state and plan of the job's own run; a run whose witness another job stamped is foreign and lends the repair nothing.
function ownRun(row, env) {
  const state = ownRunState({ projectId: row.project_id, slug: row.slug, jobId: row.id, env });
  const foreign = state === null && readRunState({ projectId: row.project_id, slug: row.slug, env }) !== null;
  const planPath = isRunPath(row.project_id, row.slug) && !foreign ? join(runDir(row.project_id, row.slug, env), "03-plan.md") : null;
  return { state, planPath, foreign };
}

// Re-derives the outcome of a gated or failed job from its own log and state.json, writing the row and the witness when it changed.
export async function reclassifyFromLog({ id, env = process.env } = {}) {
  const jobs = openStore(env).jobs;
  const row = await jobs.getJob(id);
  if (!row) throw new UserError(`unknown job \`${id}\``);
  refuseRow(id, row, await jobs.isJobActive(id));
  const log = lastAttemptStream(readJobLog(id, env));
  const ending = endingFromRow(id, row);
  const { state, planPath, foreign } = ownRun(row, env);
  const outcome = classifyJobResult({ log, ...ending, state, planPath });
  const witness = differsFromWitness(row, outcome);
  const notice = noticeDiffers(row, outcome);
  if (!witness && !notice) return { id, from: row.status, to: row.status, prUrl: row.pr_url ?? null, changed: false, noticeOnly: false };
  const written = await jobs.reclassifyJob(id, { status: outcome.status, prUrl: outcome.prUrl, noticeMd: outcome.noticeMd });
  if (!written) throw new UserError(`job \`${id}\` changed while it was being re-classified; read it again with \`nightqueue queue status ${jobRef(id)}\``);
  if (witness && !foreign) mirrorWitness(row, outcome, env);
  return { id, from: row.status, to: outcome.status, prUrl: outcome.prUrl ?? row.pr_url ?? null, changed: true, noticeOnly: !witness };
}

// The disk entries a recovery works on: every lost job, or the run of the one id asked for, whatever its row says.
async function recoveryTargets(id, store, env) {
  const disk = scanDisk(env);
  if (id === null) {
    const found = await findLostJobs(env, store, disk);
    return { entries: found.lostEntries, logOnly: found.logOnly };
  }
  const entry = disk.runs.find((run) => run.jobId === id);
  if (!entry) throw new UserError(`no run on disk names ${jobRef(id)}; there is nothing to recover it from`);
  return { entries: [entry], logOnly: [] };
}

// Appends the recovery to the job's own log; the line is a trace, so a failure to write it never undoes the row.
function logRecovery(jobId, outcome, env) {
  try {
    mkdirSync(logsDir(env), { recursive: true });
    appendFileSync(jobLogPath(jobId, env), `recovered from disk: status=${outcome.status} prUrl=${outcome.prUrl ?? "-"}\n`);
    return true;
  } catch {
    return false;
  }
}

// Recreates the row of one lost job from its run on disk and answers what happened to it.
async function recoverEntry(entry, { store, env, isRunning }) {
  const base = { jobId: entry.jobId, project: entry.job?.projectKey ?? entry.projectId, projectId: entry.projectId, slug: entry.slug };
  if (isRunning(entry)) return { ...base, result: "skipped: still running" };
  const outcome = deriveRecovered(entry, env);
  const answer = await store.jobs.recoverJob({
    id: entry.jobId,
    projectId: entry.projectId,
    slug: entry.slug,
    branch: entry.branch,
    ...outcome,
    recovered: { from: "disk", at: new Date().toISOString(), runDir: runDir(entry.projectId, entry.slug, env) },
    createdAt: entry.job?.createdAt ?? null,
    finishedAt: entry.terminal?.finishedAt ?? null,
  });
  if (answer !== "recovered") return { ...base, result: answer };
  return { ...base, result: `recovered as ${outcome.status}`, status: outcome.status, prUrl: outcome.prUrl ?? null, logged: logRecovery(entry.jobId, outcome, env) };
}

// Recreates every job whose row the table lost, or only `id`, from the runs on disk; issue rows are never rebuilt, and log-only ids are reported, not recovered.
export async function recoverFromDisk({ id = null, env = process.env } = {}) {
  const store = openStore(env);
  const { entries, logOnly } = await recoveryTargets(id, store, env);
  const isRunning = stillRunningCheck(env);
  const results = [];
  for (const entry of entries) results.push(await recoverEntry(entry, { store, env, isRunning }));
  return { results, logOnly };
}

// Replays every run's pending writes for the operator, one result per run directory; an unavailable database is raised as the one-line error it is.
export async function replayPending({ env = process.env } = {}) {
  const replayed = await replayAllPendingWrites({ env, store: openStore(env) });
  if (replayed.error) throw replayed.error;
  return replayed.runs;
}
