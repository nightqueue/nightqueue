import { hhmmUtc, prNumber } from "./format";
import type { Job, JobStatus, QueueFilters, QueueSnapshot, Runner } from "./types";

export const STATUS_ORDER: JobStatus[] = ["pending", "running", "gate", "done", "failed", "closed", "cancelled"];

export const WATCH_INTERVAL_DEFAULT_S = 30;

export const ALL_PROJECTS = "all";

// The ref a job is shown by, `J-<id>`.
export function jobRef(id: number): string {
  return `J-${id}`;
}

// The numeric id of a job ref (`J-12` or `12`), null when the text is no job ref.
export function jobIdOfRef(ref: string): number | null {
  const match = /^(?:J-)?(\d+)$/i.exec(ref.trim());
  return match ? Number(match[1]) : null;
}

// The first line of a job: its title, else its slug, else `-`.
export function jobTitle(job: Pick<Job, "title" | "slug">): string {
  return job.title?.trim() || job.slug?.trim() || "-";
}

// The snapshot with its lists guaranteed to be arrays and its counts an object, whatever the stream delivered.
export function normalizeSnapshot(snapshot: QueueSnapshot): QueueSnapshot {
  return {
    ...snapshot,
    jobs: Array.isArray(snapshot.jobs) ? snapshot.jobs : [],
    runners: Array.isArray(snapshot.runners) ? snapshot.runners : [],
    advisories: Array.isArray(snapshot.advisories) ? snapshot.advisories : [],
    counts: snapshot.counts && typeof snapshot.counts === "object" ? snapshot.counts : ({} as QueueSnapshot["counts"]),
    runnersOnline: Number.isFinite(snapshot.runnersOnline) ? snapshot.runnersOnline : 0,
    queue_paused: snapshot.queue_paused === true,
  };
}

// The total of every status count, the size of the whole queue.
export function totalCount(counts: Partial<Record<JobStatus, number>> | undefined): number {
  return Object.values(counts ?? {}).reduce<number>((sum, count) => sum + (Number.isFinite(count) ? Number(count) : 0), 0);
}

// The searchable words of one job: ref, plain id, title, slug, branch and PR number.
function searchableText(job: Job): string {
  const pr = prNumber(job.pr_url);
  return [jobRef(job.id), String(job.id), job.title, job.slug, job.branch, pr === null ? null : `#${pr}`].filter(Boolean).join(" ").toLowerCase();
}

// Tells whether one job passes the status, project and search filters of the toolbar.
function matchesFilters(job: Job, filters: QueueFilters): boolean {
  if (filters.status !== "all" && job.status !== filters.status) return false;
  if (filters.projectId !== ALL_PROJECTS && job.project_id !== filters.projectId) return false;
  const query = filters.search.trim().toLowerCase();
  return query === "" || searchableText(job).includes(query);
}

// The loaded jobs that pass the toolbar filters, in the order the stream sent them.
export function filterJobs(jobs: Job[], filters: QueueFilters): Job[] {
  return jobs.filter((job) => matchesFilters(job, filters));
}

// The oldest pending job of the loaded rows, the one a once runner would be offered for; null when none waits.
export function oldestPendingJob(jobs: Job[]): Job | null {
  const pending = jobs.filter((job) => job.status === "pending");
  if (pending.length === 0) return null;
  return pending.reduce((oldest, job) => (job.id < oldest.id ? job : oldest));
}

// The mode chip of one runner: drain, once, close, `loop` for a watch with no window and `window` for one with a window.
export function runnerModeLabel(runner: Runner): string {
  if (runner.mode === "watch") return runner.window ? "window" : "loop";
  return runner.mode ?? "runner";
}

// When one runner exits, in the words of its mode.
export function runnerExitRule(runner: Runner): string {
  if (runner.mode === "drain") return "exits when the queue is empty";
  if (runner.mode === "once") return "exits after this job";
  if (runner.mode === "close") return "exits after this close";
  if (runner.mode === "watch" && runner.window) return `until ${hhmmUtc(runner.window.until)} UTC`;
  if (runner.mode === "watch") return `every ${runner.intervalS ?? WATCH_INTERVAL_DEFAULT_S}s`;
  return "exit rule unknown";
}

// `N runners online`, singular for one.
export function runnersOnlineLabel(count: number): string {
  return `${count} runner${count === 1 ? "" : "s"} online`;
}

// `N pending jobs wait`, singular for one.
export function pendingWaitLabel(count: number): string {
  return count === 1 ? "1 pending job waits" : `${count} pending jobs wait`;
}
