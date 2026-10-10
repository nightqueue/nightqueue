import type { AttemptOutcome, AttemptRow, Job, JobDetail } from "./types";

// Milliseconds of an ISO instant, null when it is missing or not a date.
export function isoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// A duration as the runtime's formatDuration prints it: `9s`, `52m10s`, `1h02m`; `-` when unknown.
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// The track's active time: always to the second — `9s`, `4m09s`, `1h28m32s`; `-` when unknown. Unlike formatDurationMs it keeps seconds past an hour.
export function formatActiveMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "-";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const ss = String(seconds % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}m${ss}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m${ss}s`;
}

// The milliseconds a job ran: start to finish, or start to now while it runs; null before it started.
export function spanMs(startedAt: string | null, finishedAt: string | null, nowMs: number): number | null {
  const started = isoMs(startedAt);
  if (started === null) return null;
  return (isoMs(finishedAt) ?? nowMs) - started;
}

// How long a job ran: since its start while it runs, start to finish once it stopped, `-` before it started.
export function durationLabel(startedAt: string | null, finishedAt: string | null, nowMs: number): string {
  const span = spanMs(startedAt, finishedAt, nowMs);
  return span === null ? "-" : formatDurationMs(span);
}

type AttemptTiming = Pick<Job, "started_at" | "attempt_started_at" | "attempts_log" | "active_s">;

// The attempt rows of a job, none when the view carried no history.
function attemptRows(job: AttemptTiming): AttemptRow[] {
  return Array.isArray(job.attempts_log) ? job.attempts_log : [];
}

// How long one attempt ran: its own duration once closed, up to now while it is open.
function attemptMs(row: AttemptRow, nowMs: number, attemptStartedAt: string | null | undefined): number {
  if (row.finished_at !== null && typeof row.duration_s === "number" && Number.isFinite(row.duration_s)) return Math.max(0, row.duration_s * 1000);
  const started = isoMs(row.started_at) ?? isoMs(attemptStartedAt);
  return started === null ? 0 : Math.max(0, nowMs - started);
}

// The active time of a job: every attempt's duration summed, the open one up to now; null before the first attempt.
export function activeMs(job: AttemptTiming, nowMs: number): number | null {
  const rows = attemptRows(job);
  if (rows.length === 0) return typeof job.active_s === "number" && Number.isFinite(job.active_s) ? job.active_s * 1000 : null;
  return rows.reduce((sum, row) => sum + attemptMs(row, nowMs, job.attempt_started_at), 0);
}

// The wall time of a job: from its first start to the end of its last attempt, the open one ending now; null before the first attempt.
export function wallMs(job: AttemptTiming, nowMs: number): number | null {
  const rows = attemptRows(job);
  if (rows.length === 0) return null;
  const starts = rows.map((row) => isoMs(row.started_at)).filter((ms): ms is number => ms !== null);
  const start = isoMs(job.started_at) ?? (starts.length ? Math.min(...starts) : null);
  const ends = rows.map((row) => (row.finished_at === null ? nowMs : isoMs(row.finished_at))).filter((ms): ms is number => ms !== null);
  if (start === null || ends.length === 0) return null;
  return Math.max(0, Math.max(...ends) - start);
}

// The number of attempts a job's history lists, one per claim.
export function attemptCount(job: Pick<Job, "attempts_log">): number {
  return Array.isArray(job.attempts_log) ? job.attempts_log.length : 0;
}

const FAILED_OUTCOMES: ReadonlySet<AttemptOutcome> = new Set<AttemptOutcome>(["failed", "timed_out", "lost"]);

export interface AttemptsSummary {
  count: number;
  gates: number | null;
  failed: number | null;
}

// The attempts cell's figures: the history's count, gates and failures, or the job's counter alone when no history came.
export function attemptsSummary(job: Pick<Job, "attempts" | "attempts_log">): AttemptsSummary {
  const rows = Array.isArray(job.attempts_log) ? job.attempts_log : [];
  const fallback = Number.isFinite(job.attempts) ? job.attempts : 0;
  if (rows.length === 0) return { count: fallback, gates: null, failed: null };
  const gates = rows.filter((row) => row?.outcome === "gate").length;
  const failed = rows.filter((row) => row?.outcome != null && FAILED_OUTCOMES.has(row.outcome)).length;
  return { count: rows.length, gates, failed };
}

// `N attempts`, singular for one.
export function attemptsLabel(count: number): string {
  return `${count} attempt${count === 1 ? "" : "s"}`;
}

// The UTC wall clock of an instant as `hh:mm`.
export function utcClock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
}

// The UTC wall clock of an ISO instant as `hh:mm`, `-` when it is not a date.
export function hhmmUtc(iso: string | null | undefined): string {
  const ms = isoMs(iso);
  return ms === null ? "-" : utcClock(ms);
}

// The UTC wall clock of an ISO instant as `hh:mm:ss`, `-` when it is not a date.
export function hhmmssUtc(iso: string | null | undefined): string {
  const ms = isoMs(iso);
  return ms === null ? "-" : new Date(ms).toISOString().slice(11, 19);
}

// An offset inside a run as `mm:ss`, or `h:mm:ss` past an hour; `—` when unknown.
export function elapsedClock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.floor(ms / 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(seconds / 3600);
  const clock = `${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

// A job timeout in its plainest unit: `4h`, `90m`, else the duration format.
export function timeoutLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "-";
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return formatDurationMs(seconds * 1000);
}

// A count in short form: `812`, `79.5k`, `148k`, `9.8M`; `-` when unknown.
export function compactCount(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  const short = (scaled: number, unit: string) => `${scaled < 100 ? Number(scaled.toFixed(1)) : Math.round(scaled)}${unit}`;
  if (Math.abs(value) >= 1_000_000) return short(value / 1_000_000, "M");
  if (Math.abs(value) >= 1000) return short(value / 1000, "k");
  return String(Math.round(value));
}

// A dollar amount with cents, `-` when unknown.
export function usdLabel(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `$${value.toFixed(2)}` : "-";
}

// A count with the thousands separator: `1,204`; `-` when unknown.
export function thousands(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "-";
}

export interface TokenCounters {
  in: number | null;
  out: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

type TokenSource = Pick<JobDetail, "status" | "live" | "tokens_in" | "tokens_out" | "cache_read" | "cache_creation">;

// The four token counters of a job: the live estimate while it runs and has one, the recorded columns otherwise.
export function tokenCounters(job: TokenSource): TokenCounters {
  const live = job.status === "running" ? job.live?.tokens : null;
  if (live) return { in: live.in, out: live.out, cacheRead: live.cache_read, cacheWrite: live.cache_creation };
  return { in: job.tokens_in, out: job.tokens_out, cacheRead: job.cache_read, cacheWrite: job.cache_creation };
}

// The finite part of a counter, zero when it is unknown.
function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// Tokens the job spent, cache included, as the queue's TOKENS cell prints them: `374k`, `1.2M`, `~` while estimated, `-` before any.
export function tokensTotalLabel(job: TokenSource): string {
  const counters = tokenCounters(job);
  const total = finiteOrZero(counters.in) + finiteOrZero(counters.out) + finiteOrZero(counters.cacheRead) + finiteOrZero(counters.cacheWrite);
  if (total <= 0) return "-";
  const mark = job.status === "running" && Boolean(job.live?.tokens) && job.live?.tokens_estimated === true ? "~" : "";
  if (total < 1000) return `${mark}${total}`;
  if (total < 1_000_000) return `${mark}${Math.round(total / 1000)}k`;
  return `${mark}${(total / 1_000_000).toFixed(1)}M`;
}

// The number of a GitHub pull request URL, null when the URL carries none.
export function prNumber(url: string | null | undefined): number | null {
  const match = /\/pull\/(\d+)/.exec(url ?? "");
  return match ? Number(match[1]) : null;
}
