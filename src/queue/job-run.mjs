import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isStoreOutage } from "../config/errors.mjs";
import { runsDir } from "../config/paths.mjs";
import { parseOriginColumn } from "../integrations/origin.mjs";
import { openStore } from "../store/open.mjs";
import { isStateObject, readRunState } from "./resume.mjs";

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
    return { project: newest.state.job.projectKey ?? null, projectId: newest.projectId, slug: newest.slug, origin: null, source: "disk" };
  } catch {
    return null;
  }
}

// The run of a job: its row first, as always, and its job block on disk only when the database is unavailable.
export async function resolveJobRun(jobId, env = process.env) {
  try {
    const row = await openStore(env).jobs.getJob(jobId);
    return { project: row?.project ?? null, projectId: row?.project_id ?? null, slug: row?.slug ?? null, origin: parseOriginColumn(row?.origin), source: "db" };
  } catch (err) {
    if (!isStoreOutage(err)) throw err;
    const found = diskJobRun(jobId, env);
    if (found === null) throw err;
    return found;
  }
}
