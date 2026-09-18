import { releaseJobWorktree } from "./worktree.mjs";

// Closes one job and only then releases its worktree; a refused close throws before anything on disk is touched, and a kept worktree never fails the close.
export async function closeJobAndWorktree({ store, id, env = process.env, killImpl } = {}) {
  const job = await store.jobs.closeJob(id);
  const worktree = await releaseJobWorktree({ job, env, killImpl });
  return { job, worktree };
}

// The entry a close reports for the worktree of one closed job, or null when the job had none.
export function worktreeEntry(job, worktree) {
  return worktree ? { id: job.id, ...worktree } : null;
}

// The text line a close prints for the worktree of a job it closed.
export function worktreeLine(entry) {
  return entry.status === "removed" ? `worktree removed: ${entry.path}` : `worktree kept: ${entry.path} - ${entry.reason}`;
}
