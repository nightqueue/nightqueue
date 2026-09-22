import { parseShipColumn } from "../memory/jobs.mjs";
import { sqliteToIso } from "../memory/schema.mjs";

export const SHIP_STEP_NAMES = ["preflight", "conflict", "merge", "settle"];
export const SHIPPED_PREFIX = "Shipped: ";

const PASSED_STEP_STATUSES = new Set(["done", "skipped"]);
const STEP_ICONS = { done: "✓", skipped: "-", failed: "✗" };
const STATUS_SUFFIXES = { shipping: " · shipping", stalled: " · ship stalled", shipped: " · shipped", failed: " · ship failed" };

// The line a settled ship appends to the job's notice: `Shipped: PR #N merged as <sha7> on <YYYY-MM-DD>`.
export function shippedLine({ number, sha, at }) {
  const day = new Date(Date.parse(String(at ?? "")) || Date.now()).toISOString().slice(0, 10);
  return `${SHIPPED_PREFIX}PR #${number} merged as ${String(sha ?? "").slice(0, 7)} on ${day}`;
}

// A ship checklist as an object, from the parsed view or the raw column text; anything else is null.
export function parseShipChecklist(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return parseShipColumn(value);
}

// Milliseconds of a lease instant written either as ISO or as SQLite's own timestamp; NaN when unusable.
function leaseMs(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return Number.NaN;
  return Date.parse(text.includes("T") ? text : sqliteToIso(text));
}

// Whether a shipping row still holds a live lease: the SQL liveness a listing carries when it has one, the lease instant otherwise.
function hasLiveLease(row, nowMs) {
  if (row.ship_lease_live === 1 || row.ship_lease_live === 0) return row.ship_lease_live === 1;
  const until = leaseMs(row.ship_lease_until);
  return Number.isFinite(until) && Number.isFinite(nowMs) && until >= nowMs;
}

// The ship state of a job: null when never shipped, `shipping` only under a live lease, `stalled` once that lease is dead.
export function shipState(row, nowMs = Date.now()) {
  const status = row?.ship_status ?? null;
  if (status === "shipping") return hasLiveLease(row, nowMs) ? "shipping" : "stalled";
  return status === "shipped" || status === "failed" ? status : null;
}

// The step a ship is at: the failed one when it stopped, otherwise the first step not passed yet.
export function currentShipStep(checklist) {
  const ship = parseShipChecklist(checklist);
  if (ship?.failed?.step) return String(ship.failed.step);
  const steps = ship?.steps ?? {};
  return SHIP_STEP_NAMES.find((name) => !PASSED_STEP_STATUSES.has(steps[name]?.status)) ?? "settle";
}

// The reason a failed ship stopped, as recorded on its checklist.
function failedReason(checklist) {
  return String(parseShipChecklist(checklist)?.failed?.reason ?? "unknown");
}

// What the STATUS cell appends for a job with a ship: ` · shipping`, ` · ship stalled`, ` · shipped`, ` · ship failed`, or nothing.
export function shipStatusSuffix(job, nowMs = Date.now()) {
  return STATUS_SUFFIXES[shipState(job, nowMs)] ?? "";
}

// The line that tells the operator a ship stopped and how to resume it, or null when the job's ship did not fail.
export function shipStoppedLine(job) {
  if (job?.ship_status !== "failed") return null;
  return `⛔ ship stopped at ${currentShipStep(job.ship)}: ${failedReason(job.ship)} - run again with: nightshift queue ship ${job.id}`;
}

// What SLUG/LAST says about a job's ship, or null when the ship has nothing to say there.
export function shipLastCell(job, nowMs = Date.now()) {
  const state = shipState(job, nowMs);
  if (state === "failed") return `⛔ ship stopped at ${currentShipStep(job.ship)}: ${failedReason(job.ship)}`;
  if (state === "shipping") return `shipping: ${currentShipStep(job.ship)}`;
  if (state === "stalled") return `ship lease expired at ${leaseIso(job.ship_lease_until)} - run again with: nightshift queue ship ${job.id}`;
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

// The ship block of the detail view: state and attempt, one line per step, and the resume line when it stopped.
export function shipChecklistLines(job, nowMs = Date.now()) {
  const state = shipState(job, nowMs);
  if (state === null) return [];
  const ship = parseShipChecklist(job.ship) ?? {};
  const header = `${"ship".padEnd(16)}${state}, attempt ${ship.attempts ?? 0}`;
  const steps = SHIP_STEP_NAMES.map((name) => checklistLine(name, ship.steps?.[name]));
  const stopped = shipStoppedLine(job);
  return [header, ...steps, ...(stopped ? [stopped] : [])];
}

// Whether a registered runner is a ship rather than a worker of the queue.
export function isShipRunner(runner) {
  return runner?.mode === "ship";
}

// The runners that work the queue: every registration but a ship, which claims nothing.
export function queueWorkers(runners) {
  return (Array.isArray(runners) ? runners : []).filter((runner) => !isShipRunner(runner));
}

// The pid of the ship runner registered for a job, or null.
function shipRunnerPid(runners, id) {
  return (Array.isArray(runners) ? runners : []).find((runner) => isShipRunner(runner) && runner.jobId === id)?.pid ?? null;
}

// The ships of a listing grouped for the hints: in flight under a live lease, failed, and stalled on a dead lease.
export function shipsSummary(rows, runners = [], nowMs = Date.now()) {
  const summary = { inFlight: [], failed: [], stalled: [] };
  for (const row of Array.isArray(rows) ? rows : []) {
    const state = shipState(row, nowMs);
    if (state === "shipping") summary.inFlight.push({ id: row.id, step: currentShipStep(row.ship), pid: shipRunnerPid(runners, row.id) });
    if (state === "failed") summary.failed.push({ id: row.id, step: currentShipStep(row.ship), reason: failedReason(row.ship) });
    if (state === "stalled") summary.stalled.push({ id: row.id, leaseUntil: leaseIso(row.ship_lease_until) });
  }
  return summary;
}

// The hint lines of the ships of a summary: one per ship in flight, stopped or stalled.
export function shipLines(summary) {
  const inFlight = (summary?.inFlight ?? []).map(({ id, step, pid }) => {
    const owner = pid === null ? "" : ` (pid ${pid})`;
    return `ship in flight: #${id} at ${step}${owner} - follow with: nightshift queue status ${id}`;
  });
  const failed = (summary?.failed ?? []).map(({ id, step, reason }) => `⛔ ship stopped at ${step}: ${reason} - run again with: nightshift queue ship ${id}`);
  const stalled = (summary?.stalled ?? []).map(
    ({ id, leaseUntil }) => `ship of #${id} stalled: its lease expired at ${leaseUntil} - run again with: nightshift queue ship ${id}`,
  );
  return [...inFlight, ...failed, ...stalled];
}
