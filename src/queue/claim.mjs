import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { UserError } from "../config/errors.mjs";
import { queuePausedPath } from "../config/paths.mjs";
import { LEASE_HEARTBEAT_DEFAULT_S } from "../config/schema.mjs";
import { loadConfig } from "../config/store.mjs";
import { openStore } from "../store/open.mjs";
import { liveRunnersReport } from "./registry.mjs";

// Identity of this runner process, the value the ownership predicate of every write compares against.
export function workerId() {
  return `${hostname()}:${process.pid}`;
}

// Tells whether the operator paused the queue; an explicit `--job` ignores the sentinel on purpose.
export function isPaused(env = process.env) {
  return existsSync(queuePausedPath(env));
}

// Ceiling of jobs running at the same time across every runner of this home, or null when the operator set none.
export function concurrencyCap(env = process.env) {
  const configured = loadConfig(env, { warn: () => {} }).queue?.maxConcurrent;
  return Number.isInteger(configured) && configured > 0 ? configured : null;
}

// Tells whether the operator turned session resuming on; anything but a literal true stays off.
export function resumeSessionEnabled(env = process.env) {
  return loadConfig(env, { warn: () => {} }).queue?.resumeSession === true;
}

// Interval of the ownership heartbeat that re-arms the lease, the only knob the operator has over the poll.
export function leaseHeartbeatMs(env = process.env) {
  const configured = loadConfig(env, { warn: () => {} }).queue?.leaseHeartbeatS;
  const seconds = Number.isInteger(configured) && configured > 0 ? configured : LEASE_HEARTBEAT_DEFAULT_S;
  return seconds * 1000;
}

// Tells whether a `<host>:<pid>` worker of THIS host still has a live process; anything unexpected is not alive.
export function liveLocalWorker(worker) {
  const text = typeof worker === "string" ? worker : "";
  const cut = text.lastIndexOf(":");
  if (cut <= 0) return false;
  if (text.slice(0, cut) !== hostname()) return false;
  const pid = Number(text.slice(cut + 1));
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

// Explains why nothing was claimed; it reads the database only to phrase the reason, never to decide.
async function refusalReason({ jobId, cap, env }) {
  const store = openStore(env);
  if (cap !== null && (await store.jobs.countActiveJobs()) >= cap) return "cap-reached";
  if (jobId === null) return cap !== null && (await store.jobs.hasClaimablePending()) ? "cap-reached" : "empty-queue";
  const job = await store.jobs.getJob(jobId);
  if (!job) return "unknown-job";
  if (job.status !== "pending") return "not-pending";
  return cap !== null ? "cap-reached" : "claim-raced";
}

// Takes ownership of one job: sweeps the orphans first, then claims atomically inside the database.
export async function acquire({ jobId = null, cap, env = process.env } = {}) {
  const store = openStore(env);
  await store.jobs.sweepOrphans({ liveWorkerImpl: liveLocalWorker });
  if (jobId === null && isPaused(env)) return { job: null, reason: "paused" };
  const worker = workerId();
  const job = jobId === null ? await store.jobs.claimNextJob({ worker, cap }) : await store.jobs.claimJobById(jobId, { worker, cap });
  if (job) return { job, reason: "claimed" };
  return { job: null, reason: await refusalReason({ jobId, cap, env }) };
}

// Gives a claimed job back to the queue without spending the attempt, recording why it came back; `blockedCode` is the
// preflight block code of a job the runner refused to spawn, and null clears whatever a prior attempt left there.
export async function release(job, result, env = process.env, blockedCode = null) {
  return await openStore(env).jobs.releaseJob(job.id, { worker: job.worker, result, blockedCode });
}

// Re-arms the lease of a job; false means this runner no longer owns it and must stop working on it.
export async function renew(job, env = process.env) {
  return await openStore(env).jobs.renewLease(job.id, { worker: job.worker });
}

// Ownership check of the running job, which is the same write that keeps its lease alive.
export async function stillOwned(job, env = process.env) {
  return await renew(job, env);
}

// What each start shape must refuse to spawn for: a single job buys nothing when it cannot be claimed, a drain dies at once on a paused queue, and a watcher waits for the condition to clear on purpose.
const START_BLOCKERS = {
  once: new Set(["unknown-job", "not-pending", "cap-reached"]),
  drain: new Set(["paused"]),
  watch: new Set(),
};

// The ceiling standing in the way of a start right now, or null while there is a free slot.
async function capBlocker({ jobId, env }) {
  const cap = concurrencyCap(env);
  if (cap === null) return null;
  const active = await openStore(env).jobs.countActiveJobs();
  return active >= cap ? { reason: "cap-reached", jobId, active, cap } : null;
}

// The reason a start of this shape would claim nothing, with the facts its message needs.
// The orphans are swept first, exactly as `acquire` does: a job whose dead owner is about to be reclaimed is claimable, not `not-pending`.
async function previewRefusal({ jobId, env }) {
  if (jobId === null) return isPaused(env) ? { reason: "paused", jobId } : await capBlocker({ jobId, env });
  const store = openStore(env);
  await store.jobs.sweepOrphans({ liveWorkerImpl: liveLocalWorker });
  const job = await store.jobs.getJob(jobId);
  if (!job) return { reason: "unknown-job", jobId };
  if (job.status !== "pending") return { reason: "not-pending", jobId, status: job.status };
  return await capBlocker({ jobId, env });
}

// The blocker this start shape cares about, or null when a read of the queue itself failed: a broken read must never stop a start.
async function safePreview({ jobId, mode, env }) {
  const wanted = START_BLOCKERS[mode] ?? START_BLOCKERS.watch;
  if (!wanted.size) return null;
  try {
    const blocker = await previewRefusal({ jobId, env });
    return blocker && wanted.has(blocker.reason) ? blocker : null;
  } catch {
    return null;
  }
}

// The honest preview of `acquire` every start renders instead of reporting a runner that would claim nothing.
export async function claimBlocker({ jobId = null, mode = "drain", env = process.env } = {}) {
  const blocker = await safePreview({ jobId, mode, env });
  if (blocker?.reason === "unknown-job") throw new UserError(`unknown job \`${blocker.jobId}\``);
  return blocker;
}

// The live runner that will pick the waiting job up, when one is registered to do it; a registry nobody could list answers that instead of promising nobody is there.
function pickupLine(env) {
  const { runners, error } = liveRunnersReport(env);
  if (error !== null) return [`the runner registry cannot be listed (${error}), so whether a runner will pick it up is unknown`];
  const runner = runners.find((entry) => entry.mode === "drain" || entry.mode === "watch");
  return runner ? [`a live runner (pid ${runner.pid}, ${runner.mode}) will pick it up`] : [];
}

// What the operator reads instead of a start that never happened: the blocker, and what clears it.
export function blockerLines(blocker, env = process.env) {
  if (blocker.reason === "paused") return ["the queue is paused - nothing will be claimed; resume with: nightshift queue resume"];
  if (blocker.reason === "not-pending") return [`job #${blocker.jobId} is ${blocker.status}, not pending - it will not be picked up`];
  return [
    `job #${blocker.jobId} waiting: concurrency cap reached`,
    `${blocker.active} of ${blocker.cap} jobs already running`,
    ...pickupLine(env),
  ];
}
