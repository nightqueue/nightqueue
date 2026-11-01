import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isStoreOutage } from "../config/errors.mjs";
import { callerClaim } from "../config/job-home.mjs";
import { runsDir } from "../config/paths.mjs";
import { parseOriginsColumn } from "../integrations/origin.mjs";
import { openStore } from "../store/open.mjs";
import { claimStamp, isStateObject, readRunState, rowClaimOrdinal } from "./resume.mjs";

// The names of the subdirectories of a directory, or none when it cannot be listed.
export function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Every run on disk whose runtime job block names the job, with the time its state.json was last written.
function runsOfJob(jobId, env) {
  const root = runsDir(env);
  return subdirectories(root).flatMap((projectId) =>
    subdirectories(join(root, projectId))
      .filter((slug) => existsSync(join(root, projectId, slug, "state.json")))
      .map((slug) => ({ projectId, slug, state: readRunState({ projectId, slug, env }) }))
      .filter(({ state }) => isStateObject(state) && isStateObject(state.job) && state.job.id === jobId),
  );
}

// The run of a job found on disk from its job block, the newest one when a retry opened several, or null; it never throws.
export function diskJobRun(jobId, env = process.env) {
  try {
    const [newest] = runsOfJob(Number(jobId), env).sort((a, b) => String(b.state.updatedAt ?? "").localeCompare(String(a.state.updatedAt ?? "")));
    if (!newest) return null;
    return { project: newest.state.job.projectKey ?? null, projectId: newest.projectId, slug: newest.slug, origins: [], source: "disk" };
  } catch {
    return null;
  }
}

// Tells whether the row no longer holds the claim the runner pinned on this process: another attempt, another runner, a later claim at the same numbers, or a claim that ended.
function claimIsOver(row, held) {
  if (row.status !== "running" || row.attempts !== held.attempt) return true;
  if (held.worker !== null && row.worker !== held.worker) return true;
  const last = rowClaimOrdinal(row);
  return Number.isInteger(held.ordinal) && last !== null && last !== held.ordinal;
}

// The claim a write of this process speaks for: what the runner pinned on it, else what the row says; `over` only when both exist and disagree, so an outage never calls a live session over.
export function claimOfCaller(row, env) {
  const held = callerClaim(env);
  const attempt = held?.attempt ?? row?.attempts ?? null;
  if (attempt === null) return null;
  const over = held !== null && Boolean(row) && claimIsOver(row, held);
  return { ...claimStamp({ attempt, session: row?.last_session_id ?? null, ordinal: held === null ? rowClaimOrdinal(row) : held.ordinal }), ...(over ? { over: true } : {}) };
}

// The run of a job: its row first, as always, and its job block on disk only when the database is unavailable.
export async function resolveJobRun(jobId, env = process.env) {
  try {
    const row = await openStore(env).jobs.getJob(jobId);
    return { project: row?.project ?? null, projectId: row?.project_id ?? null, slug: row?.slug ?? null, origins: parseOriginsColumn(row?.origin), claim: claimOfCaller(row, env), ...(row?.start_branch ? { startBranch: row.start_branch } : {}), source: "db" };
  } catch (err) {
    if (!isStoreOutage(err)) throw err;
    const found = diskJobRun(jobId, env);
    if (found === null) throw err;
    return { ...found, claim: claimOfCaller(null, env) };
  }
}
