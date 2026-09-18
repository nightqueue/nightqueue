import { dbPath } from "../config/paths.mjs";
import { REPAIR_FAILED_PREFIX, repairWarningLine } from "./reconcile.mjs";
import { pruneDeadRunners } from "./registry.mjs";
import { callerJobId } from "./retry.mjs";

export const MAINTENANCE_INTERVAL_MS = 60_000;

const timers = new Map();

// First line of a failure, the way every warning of the queue quotes one.
function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

// Drops the registrations no live process answers for; a prune that fails removes nothing and never fails the upkeep.
function pruneQuietly(env, killImpl) {
  try {
    return pruneDeadRunners(env, killImpl);
  } catch {
    return [];
  }
}

// Repairs the jobs whose run directory already says how they ended, turning even an unexpected throw into the warning line.
async function repairQuietly(env) {
  try {
    return await repairWarningLine(env);
  } catch (err) {
    return `${REPAIR_FAILED_PREFIX}: ${firstLine(err)}`;
  }
}

// The upkeep a view never does, owned by the runner cycle, the one-shot status and the MCP server: prune, then repair; it never throws.
export async function runMaintenance({ env = process.env, killImpl } = {}) {
  const startedAt = performance.now();
  const pruned = pruneQuietly(env, killImpl);
  const warning = await repairQuietly(env);
  return { warning, pruned, ms: Math.round(performance.now() - startedAt) };
}

// Runs one pass of a timer, skipping it while the previous one is still going, and keeps what it found for the readers.
async function tick(slot, env, run) {
  if (slot.running) return;
  slot.running = true;
  try {
    slot.last = { ...(await run({ env })), at: new Date().toISOString() };
  } catch (err) {
    slot.last = { warning: `${REPAIR_FAILED_PREFIX}: ${firstLine(err)}`, pruned: [], ms: 0, at: new Date().toISOString() };
  } finally {
    slot.running = false;
  }
}

// Starts the maintenance timer a long-lived server owns for one home: once right away, then on an unref'd interval; a second start is a no-op, and inside a job the runner owns it.
export function startMaintenance(env = process.env, { intervalMs = MAINTENANCE_INTERVAL_MS, run = runMaintenance } = {}) {
  if (callerJobId(env) !== null) return false;
  const key = dbPath(env);
  if (timers.has(key)) return false;
  const slot = { running: false, last: null, immediate: null, interval: null };
  slot.immediate = setImmediate(() => tick(slot, env, run));
  slot.interval = setInterval(() => tick(slot, env, run), intervalMs);
  slot.immediate.unref();
  slot.interval.unref();
  timers.set(key, slot);
  return true;
}

// What the last pass of the timer of a home found, or null when none ran yet or no timer runs here.
export function lastMaintenance(env = process.env) {
  return timers.get(dbPath(env))?.last ?? null;
}

// Stops the timer of a home, for the tests and for a server that shuts down.
export function stopMaintenance(env = process.env) {
  const key = dbPath(env);
  const slot = timers.get(key);
  if (!slot) return;
  clearImmediate(slot.immediate);
  clearInterval(slot.interval);
  timers.delete(key);
}
