import { killProcess } from "./registry.mjs";
import { releaseJobWorktree } from "./worktree.mjs";

const RELEASED_FROM = new Set(["done", "failed"]);

// Cancels a job in one store write and only then, for a job cancelled from `done` or `failed`, releases its worktree; a refused cancel touches nothing on disk.
export async function cancelJobAndWorktree({ store, id, reason, env = process.env, killImpl = killProcess } = {}) {
  const job = await store.jobs.cancelJob(id, { reason });
  const worktree = RELEASED_FROM.has(job?.cancelled_from) ? await releaseJobWorktree({ job, env, killImpl }) : null;
  return { job, worktree };
}
