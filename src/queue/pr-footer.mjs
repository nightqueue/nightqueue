import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobRef } from "../memory/refs.mjs";

export const PUBLISHED_BODY_FILE = "pr-body.published.md";

// The traceability footer `run pr` appends: the item's `Refs` line and ref for a roadmap job, the bare signature otherwise.
export function footerOf(itemRef) {
  if (itemRef === null || itemRef === undefined) return "Opened by nightqueue";
  return `Refs ${itemRef}\n\nOpened by nightqueue · ${itemRef}`;
}

// The ref of the roadmap item the job was queued from, or null outside a job or for a free-prompt job; a store failure is thrown.
export async function itemRefOfJob(store, jobId) {
  if (jobId === null || jobId === undefined) return null;
  return (await store.roadmap.roadmapRefOfJob(jobId)) ?? null;
}

// The body file `run pr` publishes: a copy of the agent's body in the run directory ending with the footer of the item ref the caller resolves.
export async function publishedBodyFile({ bodyFile, runDir, jobId, resolveItemRef }) {
  try {
    const footer = footerOf(await resolveItemRef());
    const body = readFileSync(bodyFile, "utf8");
    mkdirSync(runDir, { recursive: true });
    const published = join(runDir, PUBLISHED_BODY_FILE);
    writeFileSync(published, `${body.replace(/\s+$/, "")}\n\n${footer}\n`);
    return published;
  } catch (error) {
    const source = jobId === null || jobId === undefined ? "outside a job" : `from ${jobRef(jobId)}`;
    throw new UserError(`could not build the pull request footer ${source}: ${error?.message ?? String(error)}; nothing was pushed`);
  }
}
