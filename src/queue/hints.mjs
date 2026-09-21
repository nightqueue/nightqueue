import { CROWDED_WINDOW_UTILIZATION, pauseUntilMs } from "./rate-limit.mjs";

// How each window of the provider reads in a line the operator sees; a limit the event did not name is simply a rate limit.
const WINDOW_LABELS = new Map([
  ["five_hour", "5h limit"],
  ["seven_day", "7d limit"],
]);

// Whether nobody is working the queue right now - no job under a live lease and no registered runner.
export function isQueueIdle({ activeJobs, runners }) {
  return activeJobs === 0 && (runners?.length ?? 0) === 0;
}

// The number of pending jobs, written the way the reader of the hint sees it.
export function pendingJobs(pending) {
  return `${pending} pending job${pending === 1 ? "" : "s"}`;
}

// The number of live runners, written the way every hint leads with it.
export function runnersOnline(count) {
  return `${count} runner${count === 1 ? "" : "s"} online`;
}

// The sentence every hint closes with when no runner is live: pending jobs wait for a drain.
export function noRunnerWait() {
  return `${runnersOnline(0)} - pending jobs will wait until \`nightshift queue run\` starts one`;
}

// The warning for a five-hour window close to its limit while runners are live, or null when it does not apply.
function crowdedWindowLine(fiveHourUtilization, runnerCount) {
  if (!Number.isFinite(fiveHourUtilization) || fiveHourUtilization < CROWDED_WINDOW_UTILIZATION || runnerCount < 1) return null;
  const runners = `${runnerCount} runner${runnerCount === 1 ? "" : "s"} active`;
  return `5h window at ${Math.round(fiveHourUtilization * 100)}% · ${runners} — another runner will likely hit the limit before finishing`;
}

// The warning for every repository two or more runners are working at once, in the order given.
function crowdedProjectLines(activeByProject) {
  return (Array.isArray(activeByProject) ? activeByProject : [])
    .filter((entry) => Number.isInteger(entry?.count) && entry.count >= 2)
    .map(
      ({ project, count }) =>
        `${count} runners on \`${project}\` — parallel jobs on one repository fight over the checkout; a job the preflight releases retries with backoff and burns tokens for no output`,
    );
}

// The advisory lines of the queue right now: a five-hour window close to its limit while runners are live, and every repository two or more runners are working at once.
export function advisoryLines({ runners, fiveHourUtilization = null, activeByProject = [] } = {}) {
  const runnerCount = Array.isArray(runners) ? runners.length : 0;
  const windowLine = crowdedWindowLine(fiveHourUtilization, runnerCount);
  return [...(windowLine === null ? [] : [windowLine]), ...crowdedProjectLines(activeByProject)];
}

// Two digits of a clock component, so `3:7` never reaches a line.
function pad(value) {
  return String(value).padStart(2, "0");
}

// The clock of an instant as the operator reads it: the time of day, plus the date when it is not today's.
export function clockLabel(untilMs, nowMs = Date.now()) {
  const until = new Date(untilMs);
  const time = `${pad(until.getHours())}:${pad(until.getMinutes())}`;
  if (until.toDateString() === new Date(nowMs).toDateString()) return time;
  return `${until.getFullYear()}-${pad(until.getMonth() + 1)}-${pad(until.getDate())} ${time}`;
}

// How long is left until an instant, in the two coarsest units that still say something: `12m`, `1h48`, `5d22h`.
function remainingLabel(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${pad(minutes % 60)}`;
  return `${Math.floor(hours / 24)}d${pad(hours % 24)}h`;
}

// The rate limit pause a runner is waiting out right now: only a live runner has one, and only until it runs out.
function runnerPause(runner, nowMs) {
  if (runner?.running !== true) return null;
  const untilMs = pauseUntilMs({ pausedUntil: runner.pausedUntil }, nowMs);
  if (untilMs === null) return null;
  const resetsAtMs = Date.parse(String(runner.rateLimit?.resetsAt ?? ""));
  return { untilMs, resetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : untilMs, type: runner.rateLimit?.type ?? null };
}

// How one pause reads: the instant the provider announced, which budget ran out and how long is left of it.
// Both halves of the line speak about that same instant; the slack the runner adds on top of it is its own business.
function pauseLabel(pause, nowMs) {
  const window = WINDOW_LABELS.get(pause.type) ?? "rate limit";
  return `paused until ${clockLabel(pause.resetsAtMs, nowMs)} (${window}, resets in ${remainingLabel(pause.resetsAtMs - nowMs)})`;
}

// How the pause of ONE runner reads on its own line, or null when that runner is not waiting out a limit.
export function runnerPauseLabel(runner, nowMs = Date.now()) {
  const pause = runnerPause(runner, nowMs);
  return pause === null ? null : pauseLabel(pause, nowMs);
}

// What every surface says instead of telling the operator to start a batch: the furthest-future pause of the
// runners of this home, or null when none of them is waiting out a limit and a new runner would really work.
export function pausedRunnerLine(runners, nowMs = Date.now()) {
  const pauses = (Array.isArray(runners) ? runners : []).map((runner) => runnerPause(runner, nowMs)).filter(Boolean);
  if (!pauses.length) return null;
  const furthest = pauses.reduce((left, right) => (right.untilMs > left.untilMs ? right : left));
  return `the runner is ${pauseLabel(furthest, nowMs)}`;
}

// The instant a job cannot be claimed before, or null when nothing holds it: a pending job the runner parked on a rate
// limit is due at the reset, and every reader of a job answers that question from the row itself, never from a live runner.
export function parkedUntilMs(job, nowMs = Date.now()) {
  if (job?.status !== "pending") return null;
  const until = Date.parse(String(job?.not_before ?? ""));
  return Number.isFinite(until) && until > nowMs ? until : null;
}

// How a job waiting for a reset reads where a reader looks for what it is doing, or null when it is not waiting for one.
export function parkedJobLabel(job, nowMs = Date.now()) {
  const untilMs = parkedUntilMs(job, nowMs);
  return untilMs === null ? null : `⏸ rate limit until ${clockLabel(untilMs, nowMs)} (in ${remainingLabel(untilMs - nowMs)})`;
}

// What every surface says instead of telling the operator to start a batch nobody registered a runner for: the reset the
// backlog is parked until. A single pending job that could be claimed right now makes starting a batch worth it again, so
// only a backlog that is entirely parked - and entirely visible in the listing - answers with the wait.
export function parkedBacklogLine({ jobs, pending }, nowMs = Date.now()) {
  const parked = (Array.isArray(jobs) ? jobs : []).map((job) => parkedUntilMs(job, nowMs)).filter(Boolean);
  if (!parked.length || parked.length < pending) return null;
  const furthest = Math.max(...parked);
  return `the rate limit resets at ${clockLabel(furthest, nowMs)} (in ${remainingLabel(furthest - nowMs)}); a batch started now claims nothing before that`;
}

// The local wall clock of an instant, `HH:MM`, with no date - the pair a stored window's `from`/`until` read as.
function wallClockLabel(ms) {
  const at = new Date(ms);
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

// The `HH:MM-HH:MM` pair a stored window reads as, the local wall clock of each stored instant - never a date, even
// when the window crosses midnight.
function windowRangeLabel(window) {
  return `${wallClockLabel(Date.parse(window.from))}-${wallClockLabel(Date.parse(window.until))}`;
}

// What a watch runner's window adds to its cadence line: the wall-clock pair it runs between, and whether it is
// still waiting to open or already counting down to close - or null when the runner carries no window at all.
export function windowCadenceLabel(window, nowMs = Date.now()) {
  if (!window) return null;
  const fromMs = Date.parse(window.from);
  const untilMs = Date.parse(window.until);
  const range = windowRangeLabel(window);
  if (nowMs < fromMs) return `window ${range} · opens in ${remainingLabel(fromMs - nowMs)}`;
  return `window ${range} · closes in ${remainingLabel(untilMs - nowMs)}`;
}

// The window a live runner is still waiting to open right now, or null when it carries none or it already opened.
function runnerWindowWait(runner, nowMs) {
  if (runner?.running !== true || !runner.window) return null;
  const fromMs = Date.parse(String(runner.window.from ?? ""));
  return Number.isFinite(fromMs) && nowMs < fromMs ? fromMs : null;
}

// What every surface says instead of promising a pending job gets picked up: the runners of this home still waiting
// for their window to open, at the earliest of them, or null when none is - a runner already inside its window still
// promises pickup as today.
export function windowWaitingLine(runners, nowMs = Date.now()) {
  const waits = (Array.isArray(runners) ? runners : []).map((runner) => runnerWindowWait(runner, nowMs)).filter((ms) => ms !== null);
  if (!waits.length) return null;
  const earliest = Math.min(...waits);
  if (waits.length === 1) return `1 runner waiting for its window (opens ${clockLabel(earliest, nowMs)})`;
  return `${waits.length} runners waiting for their window (opens ${clockLabel(earliest, nowMs)})`;
}

// The last line of a `queue run --watch --until` that closed its window: the wall clock the operator wrote on the
// command line - never a date, a window that crosses midnight closes at the `04:00` it was asked for - and how many
// jobs it leaves pending, nothing when it leaves none.
export function windowClosedLine({ windowClosedAt, pending }) {
  const closed = new Date(windowClosedAt);
  const at = `${pad(closed.getHours())}:${pad(closed.getMinutes())}`;
  if (!pending) return `window closed at ${at}`;
  return `window closed at ${at} - ${pending} job${pending === 1 ? "" : "s"} still pending`;
}
