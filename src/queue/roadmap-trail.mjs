import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ROADMAP_BODY_FILE = "pr-body.roadmap.md";

// Whether the body already carries the exact trailer line of this job's item.
function namesRef(body, ref) {
  const trailer = `Roadmap: ${ref}`;
  return body.split(/\r?\n/).some((line) => line.trim() === trailer);
}

// The roadmap reference of the job's item, or null outside a job, without a link, or when the store cannot answer.
async function refOfJob(store, jobId) {
  if (jobId === null || jobId === undefined) return null;
  try {
    return await store.roadmap.roadmapRefOfJob(jobId);
  } catch {
    return null;
  }
}

// The body file `run pr` publishes: the agent's own, or a copy in the run directory ending with `Roadmap: <ref>` when the
// job comes from a roadmap item and the body does not name it yet; the agent's file is never edited, and a trail that
// cannot be written costs the line, never the pull request.
export async function roadmapBodyFile({ bodyFile, runDir, jobId, store }) {
  const ref = await refOfJob(store, jobId);
  if (ref === null) return bodyFile;
  try {
    const body = readFileSync(bodyFile, "utf8");
    if (namesRef(body, ref)) return bodyFile;
    const published = join(runDir, ROADMAP_BODY_FILE);
    writeFileSync(published, `${body.replace(/\s+$/, "")}\n\nRoadmap: ${ref}\n`);
    return published;
  } catch {
    return bodyFile;
  }
}
