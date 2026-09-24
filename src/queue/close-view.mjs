import { parseCloseColumn } from "../memory/jobs.mjs";
import { sqliteToIso } from "../memory/schema.mjs";

export const CLOSE_STEP_NAMES = ["preflight", "conflict", "merge", "settle"];
export const CLOSED_PREFIX = "Closed: ";

const PASSED_STEP_STATUSES = new Set(["done", "skipped"]);
const STEP_ICONS = { done: "✓", skipped: "-", failed: "✗" };
const STATUS_SUFFIXES = { closing: " · closing", stalled: " · close stalled" };

// The line a settled close appends to the job's notice: `Closed: PR #N merged as <sha7> on <YYYY-MM-DD>`.
export function closedLine({ number, sha, at }) {
  const day = new Date(Date.parse(String(at ?? "")) || Date.now()).toISOString().slice(0, 10);
  return `${CLOSED_PREFIX}PR #${number} merged as ${String(sha ?? "").slice(0, 7)} on ${day}`;
}

// A close checklist as an object, from the parsed view or the raw column text; anything else is null.
export function parseCloseChecklist(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return parseCloseColumn(value);
}

// Milliseconds of a lease instant written either as ISO or as SQLite's own timestamp; NaN when unusable.
function leaseMs(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return Number.NaN;
  return Date.parse(text.includes("T") ? text : sqliteToIso(text));
}

// Whether a closing row still holds a live lease: the SQL liveness a listing carries when it has one, the lease instant otherwise.
function hasLiveLease(row, nowMs) {
  if (row.close_lease_live === 1 || row.close_lease_live === 0) return row.close_lease_live === 1;
  const until = leaseMs(row.close_lease_until);
  return Number.isFinite(until) && Number.isFinite(nowMs) && until >= nowMs;
}

// The close state of a job: null when never closed, `closing` only under a live lease, `stalled` once that lease is dead, `closed` once closed with a checklist.
export function closeState(row, nowMs = Date.now()) {
  const status = row?.close_status ?? null;
  if (status === "closing") return hasLiveLease(row, nowMs) ? "closing" : "stalled";
  if (status === "failed") return "failed";
  return row?.status === "closed" && parseCloseChecklist(row.close) ? "closed" : null;
}

// The step a close is at: the failed one when it stopped, otherwise the first step not passed yet.
export function currentCloseStep(checklist) {
  const close = parseCloseChecklist(checklist);
  if (close?.failed?.step) return String(close.failed.step);
  const steps = close?.steps ?? {};
  return CLOSE_STEP_NAMES.find((name) => !PASSED_STEP_STATUSES.has(steps[name]?.status)) ?? "settle";
}

// The reason a failed close stopped, as recorded on its checklist.
function failedReason(checklist) {
  return String(parseCloseChecklist(checklist)?.failed?.reason ?? "unknown");
}

// The suffix the STATUS cell adds for a close under way or stopped: ` · closing`, ` · close stalled` or ` · close failed at <step>`.
function closeSuffix(job, state) {
  if (state === "failed") return ` · close failed at ${currentCloseStep(job.close)}`;
  return STATUS_SUFFIXES[state] ?? "";
}

// What the STATUS cell says of a job: its status, plus the state of a close that holds it or stopped on it.
export function statusLabel(job, nowMs = Date.now()) {
  return `${job?.status ?? ""}${closeSuffix(job, closeState(job, nowMs))}`;
}

// The line that tells the operator a close stopped and how to resume it, or null when the job's close did not fail.
export function closeStoppedLine(job) {
  if (job?.close_status !== "failed") return null;
  return `⛔ close stopped at ${currentCloseStep(job.close)}: ${failedReason(job.close)} - run again with: nightqueue queue close ${job.id}`;
}

// What SLUG/LAST says about a job's close, or null when the close has nothing to say there.
export function closeLastCell(job, nowMs = Date.now()) {
  const state = closeState(job, nowMs);
  if (state === "failed") return `⛔ close stopped at ${currentCloseStep(job.close)}: ${failedReason(job.close)}`;
  if (state === "closing") return `closing: ${currentCloseStep(job.close)}`;
  if (state === "stalled") return `close lease expired at ${leaseIso(job.close_lease_until)} - run again with: nightqueue queue close ${job.id}`;
  return null;
}

// A lease instant as ISO, whichever form it was stored in.
function leaseIso(value) {
  const ms = leaseMs(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value ?? "unknown");
}

// One checklist line of the detail view: icon, step name and what the step recorded, or `not reached`.
function checklistLine(name, entry) {
  if (!entry) return `  · ${name.padEnd(10)} not reached`;
  const icon = STEP_ICONS[entry.status] ?? "·";
  const note = entry.status === "skipped" ? `skipped: ${entry.note ?? ""}` : String(entry.note ?? "");
  const at = entry.at ? `  (${entry.at})` : "";
  return `  ${icon} ${name.padEnd(10)} ${note}${at}`;
}

// The close block of the detail view: state and attempt, one line per step, and the resume line when it stopped.
export function closeChecklistLines(job, nowMs = Date.now()) {
  const state = closeState(job, nowMs);
  if (state === null) return [];
  const close = parseCloseChecklist(job.close) ?? {};
  const header = `${"close".padEnd(16)}${state}, attempt ${close.attempts ?? 0}`;
  const steps = CLOSE_STEP_NAMES.map((name) => checklistLine(name, close.steps?.[name]));
  const stopped = closeStoppedLine(job);
  return [header, ...steps, ...(stopped ? [stopped] : [])];
}

// Whether a registered runner is a close rather than a worker of the queue.
export function isCloseRunner(runner) {
  return runner?.mode === "close";
}

// The runners that work the queue: every registration but a close, which claims nothing.
export function queueWorkers(runners) {
  return (Array.isArray(runners) ? runners : []).filter((runner) => !isCloseRunner(runner));
}

// The pid of the close runner registered for a job, or null.
function closeRunnerPid(runners, id) {
  return (Array.isArray(runners) ? runners : []).find((runner) => isCloseRunner(runner) && runner.jobId === id)?.pid ?? null;
}

// The closes of a listing grouped for the hints: in flight under a live lease, failed, and stalled on a dead lease.
export function closesSummary(rows, runners = [], nowMs = Date.now()) {
  const summary = { inFlight: [], failed: [], stalled: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    const state = closeState(row, nowMs);
    if (state === "closing") summary.inFlight.push({ id: row.id, step: currentCloseStep(row.close), pid: closeRunnerPid(runners, row.id) });
    if (state === "failed") summary.failed.push({ id: row.id, step: currentCloseStep(row.close), reason: failedReason(row.close) });
    if (state === "stalled") summary.stalled.push({ id: row.id, leaseUntil: leaseIso(row.close_lease_until) });
  }
  return summary;
}

// The hint lines of the closes of a summary: one per close in flight, stopped or stalled.
export function closeLines(summary) {
  const inFlight = (summary?.inFlight ?? []).map(({ id, step, pid }) => {
    const owner = pid === null ? "" : ` (pid ${pid})`;
    return `close in flight: #${id} at ${step}${owner} - follow with: nightqueue queue status ${id}`;
  });
  const failed = (summary?.failed ?? []).map(({ id, step, reason }) => `⛔ close stopped at ${step}: ${reason} - run again with: nightqueue queue close ${id}`);
  const stalled = (summary?.stalled ?? []).map(
    ({ id, leaseUntil }) => `close of #${id} stalled: its lease expired at ${leaseUntil} - run again with: nightqueue queue close ${id}`,
  );
  return [...inFlight, ...failed, ...stalled];
}
