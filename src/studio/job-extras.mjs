import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jobLogPath, runDir } from "../config/paths.mjs";
import { recordedFiles } from "../queue/file-list.mjs";
import { isSafeSegment, readRunState } from "../queue/resume.mjs";

const IMPLEMENTATION_ARTIFACT = "04-implementation.md";

// The run directory of a job, or null while it has no slug, or a slug that is not a safe path segment.
export function runDirOf(job, env) {
  if (!isSafeSegment(job?.project_id) || !isSafeSegment(job?.slug)) return null;
  return runDir(job.project_id, job.slug, env);
}

// The artifact names of a run directory (every `*.md` plus `state.json`), sorted; an unreadable directory has none.
function artifactNames(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md") || name === "state.json")
      .sort();
  } catch {
    return [];
  }
}

// The files the implementation artifact recorded, or null when the run has no readable one yet.
function recordedFilesOf(dir) {
  const path = join(dir, IMPLEMENTATION_ARTIFACT);
  try {
    return existsSync(path) ? recordedFiles(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

// The baseline of a tier, or null when the store cannot answer it; a failed read never fails the stream.
async function baselineOf(tier, store) {
  if (!tier) return null;
  try {
    return await store.jobs.tierBaseline(tier);
  } catch {
    return null;
  }
}

// The tier a read run state records, else the row's; null while neither knows it.
function tierFrom(state, job) {
  const recorded = state?.tier;
  if (typeof recorded === "string" && recorded.trim()) return recorded.trim();
  return job?.tier ?? null;
}

// The tier the run executed: the one its state.json records, else the row's; null while neither knows it.
export function runTierOf(job, env) {
  return tierFrom(readRunState({ projectId: job?.project_id, slug: job?.slug, env }), job);
}

// The run facts the track reads on every send, from one state.json read: its tier, its skip records and its task type.
export function runTrackFacts(job, env) {
  const state = readRunState({ projectId: job?.project_id, slug: job?.slug, env });
  const skips = state?.skips;
  const validSkips = skips && typeof skips === "object" && !Array.isArray(skips) ? skips : {};
  return { tier: tierFrom(state, job), skips: validSkips, type: typeof state?.type === "string" ? state.type : null };
}

// What the job screen shows beside the row: the run paths, its artifact names, the recorded files, the run tier and its baseline; pure reads only.
export async function jobExtras(job, { env, store }) {
  const dir = runDirOf(job, env);
  const tier = runTierOf(job, env);
  return {
    run_dir: dir,
    state_json: dir ? join(dir, "state.json") : null,
    log_path: jobLogPath(job.id, env),
    artifacts: dir ? artifactNames(dir) : [],
    files: dir ? recordedFilesOf(dir) : null,
    tier,
    baseline: await baselineOf(tier, store),
  };
}
