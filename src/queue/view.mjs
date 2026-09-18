import { JOB_STATUSES, jobView } from "../memory/jobs.mjs";
import { advisoryLinesFor } from "./advisory.mjs";
import { isQueueIdle } from "./hints.mjs";
import { prStateKey } from "./pr-state.mjs";
import { liveRunnersReport } from "./registry.mjs";

// The state of the pull request of a job as the cache holds it right now: null without a GitHub pull request, `unknown` on a miss.
function prStateOf(url, prStates) {
  if (prStateKey(url) === null) return null;
  return prStates?.stateOf(url) ?? "unknown";
}

// A public job view decorated with the state of its pull request; the state is derived here and never stored.
function withPrState(job, prStates) {
  return { ...job, pr_state: prStateOf(job.pr_url, prStates) };
}

// The line suggesting to close a delivered job whose pull request is merged, or null when there is nothing to suggest.
export function closeSuggestion(job) {
  if (job?.status !== "done" || job?.pr_state !== "merged") return null;
  return `#${job.id} PR merged - close it with nightshift queue close ${job.id}`;
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
  const suggestions = jobs.map(closeSuggestion).filter(Boolean);
  const idle = isViewIdle({ jobs, counts, activeJobs, runners, registryError, readable: jobsPart.ok && countsPart.ok });
  return { jobs, counts, blockedPending, activeJobs, runners, registryError, advisories, suggestions, idle, sections };
}

// The first failed section among the ones a listing cannot do without (jobs, counts), or null when both were read.
export function failedCoreSection(view) {
  return view.sections.find((section) => (section.name === "jobs" || section.name === "counts") && !section.ok) ?? null;
}

// One job in full with the state of its pull request, or null when the row is gone.
export async function jobDetailView(readStore, id, { prStates = null } = {}) {
  const job = jobView(await readStore.jobs.getJob(id), { full: true });
  return job ? withPrState(job, prStates) : null;
}
