import { existsSync } from "node:fs";
import { queuePausedPath } from "../config/paths.mjs";
import { localWorkerPid } from "../queue/claim.mjs";
import { CLOSING_LABEL, statusLabel } from "../queue/close-view.mjs";
import { formatTokens, stoppedReason } from "../queue/last-cell.mjs";
import { agentGlyph } from "../queue/routing.mjs";

// The ref of the issue a job was queued from, read once per job and remembered: it never changes for the life of the job.
async function itemRefOf(job, { store, itemRefs }) {
  if (itemRefs.has(job.id)) return itemRefs.get(job.id);
  let ref = null;
  try {
    ref = (await store.issues.issueRefOfJob(job.id)) ?? null;
  } catch {
    return null;
  }
  itemRefs.set(job.id, ref);
  return ref;
}

// The cells the studio renders for one job, each computed by the same runtime function the CLI table uses.
async function studioCells(job, context, nowMs) {
  const label = statusLabel(job, nowMs);
  return {
    status_label: label,
    closing: label === CLOSING_LABEL,
    reason: job.status === "running" ? null : stoppedReason(job),
    tokens_label: formatTokens(job),
    glyph: job.status === "running" ? (agentGlyph(job.live?.agent) ?? "»") : null,
    item_ref: await itemRefOf(job, context),
  };
}

// The job a runner is holding: the running job its worker pid names, else the job it was started for, else null.
function runnerJobId(runner, jobs) {
  const held = jobs.find((job) => job.status === "running" && localWorkerPid(job.worker)?.pid === runner.pid);
  if (held) return held.id;
  return Number.isInteger(runner.jobId) ? runner.jobId : null;
}

// Tells whether the pause sentinel is on disk, read without ever touching it.
function queuePaused(env) {
  try {
    return existsSync(queuePausedPath(env));
  } catch {
    return false;
  }
}

// The `queue_status` answer with the studio's derived cells on each job, the held job on each runner and the queue pause; pure reads only.
export async function decorateSnapshot(answer, { env, store, itemRefs, nowMs = Date.now() }) {
  const context = { store, itemRefs };
  const jobs = [];
  for (const job of answer.jobs ?? []) jobs.push({ ...job, studio: await studioCells(job, context, nowMs) });
  const runners = (answer.runners ?? []).map((runner) => ({ ...runner, job_id: runnerJobId(runner, jobs) }));
  return { ...answer, jobs, runners, queue_paused: queuePaused(env) };
}
