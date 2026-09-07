import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { queuePausedPath } from "../config/paths.mjs";
import { LEASE_HEARTBEAT_DEFAULT_S } from "../config/schema.mjs";
import { loadConfig } from "../config/store.mjs";
import {
  claimJobById,
  claimNextJob,
  countActiveJobs,
  countsByStatus,
  getJob,
  hasClaimablePending,
  isProjectBusy,
  releaseJob,
  renewLease,
  sweepOrphans,
} from "../memory/jobs.mjs";

// Identity of this runner process, the value the ownership predicate of every write compares against.
export function workerId() {
  return `${hostname()}:${process.pid}`;
}

// Tells whether the operator paused the queue; an explicit `--job` ignores the sentinel on purpose.
export function isPaused(env = process.env) {
  return existsSync(queuePausedPath(env));
}

// Global ceiling of jobs running at the same time, shared by every runner process of this home.
export function concurrencyCap(env = process.env) {
  const configured = loadConfig(env, { warn: () => {} }).queue?.maxConcurrent;
  return Number.isInteger(configured) && configured > 0 ? configured : 1;
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
function refusalReason({ jobId, cap, env }) {
  if (countActiveJobs(env) >= cap) return "cap-reached";
  if (jobId === null) {
    if (countsByStatus(env).pending === 0) return "empty-queue";
    return hasClaimablePending(env) ? "cap-reached" : "project-busy";
  }
  const job = getJob(jobId, env);
  if (!job) return "unknown-job";
  if (job.status !== "pending") return "not-pending";
  return isProjectBusy(job.project, env) ? "project-busy" : "cap-reached";
}

// Takes ownership of one job: sweeps the orphans first, then claims atomically inside the database.
export function acquire({ jobId = null, cap, env = process.env } = {}) {
  sweepOrphans(env, { liveWorkerImpl: liveLocalWorker });
  if (jobId === null && isPaused(env)) return { job: null, reason: "paused" };
  const worker = workerId();
  const job = jobId === null ? claimNextJob({ worker, cap }, env) : claimJobById(jobId, { worker, cap }, env);
  if (job) return { job, reason: "claimed" };
  return { job: null, reason: refusalReason({ jobId, cap, env }) };
}

// Gives a claimed job back to the queue without spending the attempt, recording why it came back.
export function release(job, result, env = process.env) {
  return releaseJob(job.id, { worker: job.worker, result }, env);
}

// Re-arms the lease of a job; false means this runner no longer owns it and must stop working on it.
export function renew(job, env = process.env) {
  return renewLease(job.id, { worker: job.worker }, env);
}

// Ownership check of the running job, which is the same write that keeps its lease alive.
export function stillOwned(job, env = process.env) {
  return renew(job, env);
}
