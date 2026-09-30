import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { jobLogPath, jobWorktreePath, logsDir, runDir, runsDir } from "../config/paths.mjs";
import { jobRef } from "../memory/refs.mjs";
import { brokenGateNotice, classifyJobResult } from "./classify.mjs";
import { subdirectories } from "./job-run.mjs";
import { liveRunners } from "./registry.mjs";
import { isStateObject, readRunState } from "./resume.mjs";
import { extractNoticeFromStream, extractPrUrlFromStream, isPrUrl, lastAttemptStream } from "./stream.mjs";

const RECOVERABLE_STATUSES = ["done", "gate", "failed", "cancelled"];
const LOG_NAME = /^job-(\d+)\.log$/;
export const NO_OUTCOME_NOTICE = "recovered from disk: the run left no outcome";

// A positive integer job id, or null.
function jobIdOrNull(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

// The object under a key of the state, or null when it is not one.
function section(state, key) {
  return isStateObject(state[key]) ? state[key] : null;
}

// The job a run belongs to: its job block, then the witness of runs older than the block.
function jobIdOfState(state) {
  return jobIdOrNull(section(state, "job")?.id) ?? jobIdOrNull(section(state, "terminal")?.jobId);
}

// One run directory as a disk entry of its job, or null when its state.json names no job.
function runEntry(projectId, slug, env) {
  const state = readRunState({ projectId, slug, env });
  if (!isStateObject(state)) return null;
  const jobId = jobIdOfState(state);
  if (jobId === null) return null;
  const terminal = section(state, "terminal");
  return {
    jobId,
    projectId,
    slug,
    job: section(state, "job"),
    terminal: terminal && jobIdOrNull(terminal.jobId) !== null && terminal.jobId !== jobId ? null : terminal,
    outcome: section(state, "outcome"),
    branch: typeof state.branch === "string" ? state.branch : null,
    worktree: typeof state.worktree === "string" ? state.worktree : null,
    updatedAt: String(state.updatedAt ?? ""),
    state,
  };
}

const MERGED_KEYS = ["job", "terminal", "outcome", "branch", "worktree"];

// Orders the runs of one job: the one holding its witness first (the run its row named at the finish), then the newest.
function byWitnessThenNewest(a, b) {
  if ((a.terminal === null) !== (b.terminal === null)) return a.terminal === null ? 1 : -1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

// One entry for a job that left several runs: the first run in order, each missing section taken from the others.
function mergeRuns(entries) {
  const [primary, ...rest] = [...entries].sort(byWitnessThenNewest);
  const merged = { ...primary };
  for (const key of MERGED_KEYS) merged[key] = primary[key] ?? rest.find((entry) => entry[key] !== null)?.[key] ?? null;
  return merged;
}

// Every run entry on disk, one per job id; a job whose slug was rebound after its run was created leaves two runs, merged into one.
function runEntries(env) {
  const root = runsDir(env);
  const byJob = new Map();
  for (const projectId of subdirectories(root)) {
    for (const slug of subdirectories(join(root, projectId))) {
      const entry = runEntry(projectId, slug, env);
      if (entry) byJob.set(entry.jobId, [...(byJob.get(entry.jobId) ?? []), entry]);
    }
  }
  return [...byJob.values()].map(mergeRuns).sort((a, b) => a.jobId - b.jobId);
}

// Tells whether the job's worktree is on disk: the one its run recorded, or the one its slug names.
function hasWorktreeOnDisk(entry, env) {
  return (entry.worktree !== null && existsSync(entry.worktree)) || existsSync(jobWorktreePath(entry.projectId, entry.slug, env));
}

// The ids of every job log on disk.
function logIds(env) {
  try {
    return readdirSync(logsDir(env))
      .map((name) => LOG_NAME.exec(name))
      .filter(Boolean)
      .map((match) => Number(match[1]))
      .filter((id) => jobIdOrNull(id) !== null)
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

// Reads the three disk sources a lost row can be told from: the run entries, the job logs and the job worktrees; it never throws.
export function scanDisk(env = process.env) {
  try {
    const logs = new Set(logIds(env));
    const runs = runEntries(env).map((entry) => ({
      ...entry,
      hasLog: logs.has(entry.jobId),
      hasWorktree: hasWorktreeOnDisk(entry, env),
    }));
    return { runs, logIds: [...logs] };
  } catch {
    return { runs: [], logIds: [] };
  }
}

// The last attempt of a job's log, or null when there is no readable log.
function lastAttemptOf(entry, env) {
  if (!entry.hasLog) return null;
  try {
    return lastAttemptStream(readFileSync(jobLogPath(entry.jobId, env), "utf8"));
  } catch {
    return null;
  }
}

// A status a recovered row may take, or null.
function recoverableStatus(value) {
  return RECOVERABLE_STATUSES.includes(value) ? value : null;
}

// The plan of the run, the path the broken-gate notice names.
function planPathOf(entry, env) {
  return join(runDir(entry.projectId, entry.slug, env), "03-plan.md");
}

// The outcome the log's last attempt classifies to; the exit code is unknown, so it never reads as a clean ending.
function classifiedFromLog(entry, stream, env) {
  return classifyJobResult({ log: stream, exitCode: null, state: entry.state, planPath: planPathOf(entry, env) });
}

// The pull request of a run: the pipeline's record, the witness, then the stream.
function prUrlOf(entry, stream) {
  const recorded = [entry.outcome?.prUrl, entry.terminal?.prUrl].find(isPrUrl);
  return recorded ?? (stream ? extractPrUrlFromStream(stream) : null) ?? null;
}

// The status the disk last recorded for a job, for the report.
function lastStatusOf(entry, stream, env) {
  const recorded = recoverableStatus(entry.terminal?.status) ?? recoverableStatus(entry.outcome?.status);
  if (recorded) return recorded;
  return stream ? classifiedFromLog(entry, stream, env).status ?? "unknown" : "unknown";
}

// The notice of a run: the stream's own `## Notice`, then the one the pipeline recorded.
function noticeOf(entry, stream) {
  const recorded = typeof entry.outcome?.notice === "string" && entry.outcome.notice.trim() ? entry.outcome.notice.trim() : null;
  return (stream ? extractNoticeFromStream(stream) : null) ?? recorded;
}

// Re-derives the row a lost job recovers as: the witness, the pipeline's outcome, the log, or a failure that says the run left none.
export function deriveRecovered(entry, env = process.env) {
  const stream = lastAttemptOf(entry, env);
  const prUrl = prUrlOf(entry, stream);
  const recorded = recoverableStatus(entry.terminal?.status) ?? recoverableStatus(entry.outcome?.status);
  if (recorded) {
    const noticeMd = noticeOf(entry, stream);
    if (recorded === "gate" && !noticeMd) return { status: "failed", noticeMd: brokenGateNotice(planPathOf(entry, env)), prUrl };
    return { status: recorded, noticeMd, prUrl };
  }
  if (!stream) return { status: "failed", noticeMd: NO_OUTCOME_NOTICE, prUrl };
  const classified = classifiedFromLog(entry, stream, env);
  return { status: classified.status, noticeMd: classified.noticeMd || NO_OUTCOME_NOTICE, prUrl: classified.prUrl ?? prUrl };
}

// The report line of one lost job, read from its disk entry.
function describeLost(entry, env) {
  const stream = lastAttemptOf(entry, env);
  return {
    jobId: entry.jobId,
    project: entry.job?.projectKey ?? entry.projectId,
    projectId: entry.projectId,
    slug: entry.slug,
    lastStatus: lastStatusOf(entry, stream, env),
    prUrl: prUrlOf(entry, stream),
    hasLog: entry.hasLog,
    hasWorktree: entry.hasWorktree,
  };
}

// Splits the disk into the jobs whose row is gone and the logs no run and no row explain; a store that cannot be read throws.
export async function findLostJobs(env, store, disk = scanDisk(env)) {
  const ids = [...new Set([...disk.runs.map((entry) => entry.jobId), ...disk.logIds])];
  const existing = new Set(await store.jobs.existingJobIds(ids));
  const runIds = new Set(disk.runs.map((entry) => entry.jobId));
  const lostEntries = disk.runs.filter((entry) => !existing.has(entry.jobId));
  return {
    lost: lostEntries.map((entry) => describeLost(entry, env)),
    lostEntries,
    logOnly: disk.logIds.filter((id) => !runIds.has(id) && !existing.has(id)),
  };
}

// The tail naming the job logs no run and no row explain, or null when there are none.
export function logOnlyTail(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return null;
  return `and ${ids.length} job log${ids.length === 1 ? "" : "s"} with no run and no row (${ids.map(jobRef).join(", ")})`;
}

// Tells, from the live registered runners, whether a lost job may still be running: a runner names it, or a runner that names no job is live while the run has no witness yet.
export function stillRunningCheck(env = process.env) {
  const runners = liveRunners(env);
  const named = new Set(runners.map((runner) => jobIdOrNull(runner.jobId)).filter((id) => id !== null));
  const unnamed = runners.some((runner) => jobIdOrNull(runner.jobId) === null);
  return (entry) => named.has(entry.jobId) || (unnamed && entry.terminal === null);
}
