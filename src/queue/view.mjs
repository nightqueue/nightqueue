import { readFileSync } from "node:fs";
import { JOB_STATUSES, VIEW_TEXT_LIMIT, jobView } from "../memory/jobs.mjs";
import { advisoryLinesFor } from "./advisory.mjs";
import { isQueueIdle } from "./hints.mjs";
import { prStateKey } from "./pr-state.mjs";
import { liveRunnersReport } from "./registry.mjs";
import { extractNoticeFromStream } from "./stream.mjs";

// The state of the pull request of a job as the cache holds it right now: null without a GitHub pull request, `unknown` on a miss.
function prStateOf(url, prStates) {
  if (prStateKey(url) === null) return null;
  return prStates?.stateOf(url) ?? "unknown";
}

// A public job view decorated with the state of its pull request; the state is derived here and never stored.
function withPrState(job, prStates) {
  return { ...job, pr_state: prStateOf(job.pr_url, prStates) };
}

const CLOSEABLE_STATUSES = new Set(["done", "failed", "gate", "cancelled"]);
const SUGGESTION_ID_LIMIT = 5;

// Whether a job qualifies for a close suggestion: a terminal status whose cached pull request state is merged.
function qualifiesForClose(job) {
  return CLOSEABLE_STATUSES.has(job?.status) && job?.pr_state === "merged";
}

// The ids a suggestion line names, at most five, with the rest folded into a count.
function suggestionIdList(ids) {
  const shown = ids.slice(0, SUGGESTION_ID_LIMIT).map((id) => `#${id}`).join(", ");
  const extra = ids.length - SUGGESTION_ID_LIMIT;
  return extra > 0 ? `${shown} and ${extra} more` : shown;
}

// One aggregated line suggesting the close of every terminal job whose pull request is merged, or null when none qualifies.
export function closeSuggestion(jobs) {
  const ids = (Array.isArray(jobs) ? jobs : []).filter(qualifiesForClose).map((job) => job.id);
  if (ids.length === 0) return null;
  if (ids.length === 1) return `#${ids[0]} PR merged - close it with nightshift queue close ${ids[0]}`;
  return `${ids.length} jobs have a merged PR (${suggestionIdList(ids)}) - close them with nightshift queue close --merged`;
}

// Whether the listing cut the notice or the result of a job.
function wasTruncated(job) {
  return job?.notice_truncated === true || job?.result_truncated === true;
}

// One aggregated line pointing at the whole text of every listed job whose free text was cut, or null when none was.
export function truncationSuggestion(jobs) {
  const ids = (Array.isArray(jobs) ? jobs : []).filter(wasTruncated).map((job) => job.id);
  if (ids.length === 0) return null;
  if (ids.length === 1) return `#${ids[0]} text cut at ${VIEW_TEXT_LIMIT} characters - read it whole with nightshift queue status ${ids[0]}`;
  return `${ids.length} jobs have text cut at ${VIEW_TEXT_LIMIT} characters (${suggestionIdList(ids)}) - read each whole with nightshift queue status <id>`;
}

// One advisory line per distinct status outside the job status enum, naming it and how many rows carry it.
function unknownStatusAdvisories(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    if (JOB_STATUSES.includes(job.status)) continue;
    counts.set(job.status, (counts.get(job.status) ?? 0) + 1);
  }
  return [...counts.entries()].map(
    ([status, count]) => `${count} job${count === 1 ? "" : "s"} carr${count === 1 ? "ies" : "y"} the unknown status '${status}'; run nightshift doctor`,
  );
}

// The pull request URLs of a list of jobs or rows, the keys a refresh of the cache is asked about.
export function prUrlsOf(jobs) {
  return (Array.isArray(jobs) ? jobs : []).map((job) => job?.pr_url).filter((url) => typeof url === "string" && url);
}

// Whether a follow with `--until-idle` may stop: every part read and, when anything is listed, nothing running and nothing pending.
function isViewIdle({ jobs, counts, activeJobs, runners, registryError, readable }) {
  if (!readable || registryError !== null) return false;
  return jobs.length === 0 || (isQueueIdle({ activeJobs, runners }) && counts.pending === 0);
}

// First line of a failure, the way a section reports it.
function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

// Runs one part of the read and times it; a failure is the section's answer, never a throw.
async function timedSection(name, read, now) {
  const startedAt = now();
  try {
    const value = await read();
    return { name, ok: true, ms: Math.max(0, Math.round(now() - startedAt)), error: null, value };
  } catch (err) {
    return { name, ok: false, ms: Math.max(0, Math.round(now() - startedAt)), error: firstLine(err), value: null };
  }
}

// Every status at zero, what a view says about counts it could not read.
function zeroCounts() {
  return Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
}

// The counts section: jobs per status, the pending ones a block holds back and the ones running under a live lease.
async function readCounts(readStore) {
  const counts = await readStore.jobs.countsByStatus();
  return { counts, blockedPending: await readStore.jobs.countPendingBlocked(), activeJobs: await readStore.jobs.countActiveJobs() };
}

// The runners section: a registry that cannot be listed is a failed section carrying the reason.
function readRunners(env, killImpl) {
  const report = liveRunnersReport(env, killImpl);
  if (report.error !== null) throw new Error(report.error);
  return report.runners;
}

// The data of the queue view in timed sections, read from SELECTs and pure file reads alone; a failed section never fails the view.
export async function queueView(readStore, { env = process.env, limit, blockedOnly = false, prStates = null, killImpl, now = () => performance.now() } = {}) {
  const jobsPart = await timedSection("jobs", async () => (await readStore.jobs.listJobs({ limit, blockedOnly })).map(jobView), now);
  const countsPart = await timedSection("counts", () => readCounts(readStore), now);
  const runnersPart = await timedSection("runners", () => readRunners(env, killImpl), now);
  const runners = runnersPart.value ?? [];
  const registryError = runnersPart.ok ? null : runnersPart.error;
  const advisoriesPart = await timedSection("advisories", async () => (runnersPart.ok ? await advisoryLinesFor({ store: readStore, runners, env, killImpl }) : []), now);
  const jobs = (jobsPart.value ?? []).map((job) => withPrState(job, prStates));
  const { counts, blockedPending, activeJobs } = countsPart.value ?? { counts: zeroCounts(), blockedPending: 0, activeJobs: 0 };
  const sections = [jobsPart, countsPart, runnersPart, advisoriesPart].map(({ name, ok, ms, error }) => ({ name, ok, ms, error }));
  const advisories = advisoriesPart.value ?? [];
  const suggestions = [closeSuggestion(jobs), truncationSuggestion(jobs), ...unknownStatusAdvisories(jobs)].filter(Boolean);
  const idle = isViewIdle({ jobs, counts, activeJobs, runners, registryError, readable: jobsPart.ok && countsPart.ok });
  return { jobs, counts, blockedPending, activeJobs, runners, registryError, advisories, suggestions, idle, sections };
}

// The first failed section among the ones a listing cannot do without (jobs, counts), or null when both were read.
export function failedCoreSection(view) {
  return view.sections.find((section) => (section.name === "jobs" || section.name === "counts") && !section.ok) ?? null;
}

// The log path a job's own `result` column names, or null when it is missing, malformed or carries none.
function resultLogPath(job) {
  try {
    const parsed = typeof job.result === "string" ? JSON.parse(job.result) : job.result;
    return typeof parsed?.logPath === "string" && parsed.logPath ? parsed.logPath : null;
  } catch {
    return null;
  }
}

// The run's own whole notice, read straight from its log; absent when the log is missing, unreadable or carries none - a pure read, never a write and never an error.
function runNoticeOf(job) {
  const logPath = resultLogPath(job);
  if (!logPath) return null;
  try {
    return extractNoticeFromStream(readFileSync(logPath, "utf8"));
  } catch {
    return null;
  }
}

// One job in full with the state of its pull request, or null when the row is gone. When the run's own notice (read fresh
// from its log) differs from the row's `notice_md`, both are carried: `notice` is the row's, `run_notice` the run's whole own.
export async function jobDetailView(readStore, id, { prStates = null } = {}) {
  const job = jobView(await readStore.jobs.getJob(id), { full: true });
  if (!job) return null;
  const withState = withPrState(job, prStates);
  const runNotice = runNoticeOf(job);
  return runNotice && runNotice !== job.notice_md ? { ...withState, run_notice: runNotice } : withState;
}
