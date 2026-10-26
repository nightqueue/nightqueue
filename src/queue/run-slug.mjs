import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { isStoreOutage } from "../config/errors.mjs";
import { runDir } from "../config/paths.mjs";
import { jobRef } from "../memory/refs.mjs";
import { subdirectories } from "./job-run.mjs";
import { slugText } from "./job-title.mjs";
import { isRunPath, isSafeSegment, isStateObject, readRunState, renameRunDir } from "./resume.mjs";

// How many words of the prompt a provisional slug is built from, enough to tell two jobs apart while staying one readable path segment.
const PROVISIONAL_SLUG_WORDS = 6;

// How many suffixed variants of a provisional slug are tried before the job falls back to its own id.
const SLUG_SUFFIXES = 9;
// Longest run slug a path segment accepts.
const MAX_SLUG_CHARS = 80;

// The slugs a job may bind its run to, in order: the base, its numbered variants, then one derived from the job id.
export function slugCandidates(base, id) {
  const variants = [base];
  for (let n = 2; n <= SLUG_SUFFIXES; n += 1) {
    const suffix = `-${n}`;
    variants.push(`${String(base ?? "").slice(0, MAX_SLUG_CHARS - suffix.length)}${suffix}`);
  }
  variants.push(`job-${id}`);
  return variants.filter(isSafeSegment);
}

// A run slug derived from the brief of a job, so the run directory exists from the first attempt even if the pipeline never names itself.
export function provisionalSlug(job) {
  const words = slugText(job)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .slice(0, PROVISIONAL_SLUG_WORDS);
  const derived = words.join("-");
  if (isSafeSegment(derived)) return derived;
  const fallback = `job-${job?.id}`;
  return isSafeSegment(fallback) ? fallback : "job";
}

// Whether a run slug is still the provisional one the runtime derived for this job row.
export function isProvisionalSlug(row, slug) {
  if (!row || typeof slug !== "string") return false;
  return slugCandidates(provisionalSlug(row), row.id).includes(slug);
}

// Whether the run dir of a slug carries the job block of this job in its state.json.
function carriesJobBlock({ projectId, slug, jobId, env }) {
  const state = readRunState({ projectId, slug, env });
  return isStateObject(state) && isStateObject(state.job) && state.job.id === jobId;
}

// The slug a job's run lives under now, found on disk alone: the same slug while its dir exists, else the one real dir carrying the job's block; never throws.
export function followRunSlug({ projectId, slug, jobId, env = process.env }) {
  try {
    if (!isRunPath(projectId, slug) || existsSync(runDir(projectId, slug, env))) return slug;
    const id = Number(jobId);
    const matches = subdirectories(dirname(runDir(projectId, slug, env))).filter(
      (name) => isSafeSegment(name) && carriesJobBlock({ projectId, slug: name, jobId: id, env }),
    );
    return matches.length === 1 ? matches[0] : slug;
  } catch {
    return slug;
  }
}

// Why a slug claim was refused, phrased for a log line: a database outage (null), a row no longer ours, or a holder of the name.
export function slugRefusal(bound) {
  if (!bound) return "the database is unavailable";
  if (bound.status !== "taken") return "the job is no longer ours";
  return Number.isInteger(bound.heldBy) ? `${jobRef(bound.heldBy)} holds it` : "every candidate is already on disk";
}

// Claims one slug for the job row; an unavailable database is noted on the outage (when one is given) and answers null.
async function bindOrNull({ job, slug, store, outage }) {
  try {
    return await store.jobs.bindRunSlug(job.id, { worker: job.worker, candidates: [slug] });
  } catch (err) {
    if (!isStoreOutage(err)) throw err;
    outage?.note(err);
    return null;
  }
}

// Moves a job's run from one slug to another: binds the row, renames the run directory, and binds the row back when the rename is refused.
export async function adoptRunSlug({ job, from, to, store, env, outage = null }) {
  const claimed = await bindOrNull({ job, slug: to, store, outage });
  if (claimed?.status !== "bound") return { status: "kept", reason: slugRefusal(claimed), dir: null, warning: null };
  const renamed = renameRunDir({ projectId: job.project_id, from, to, env });
  if (renamed.status !== "kept") return { status: "renamed", reason: null, dir: renamed.dir, warning: null };
  const reverted = await bindOrNull({ job, slug: from, store, outage });
  const warning = reverted?.status === "bound" ? null : `the row could not be bound back to \`${from}\` (${slugRefusal(reverted)})`;
  return { status: "kept", reason: renamed.reason, dir: null, warning };
}
