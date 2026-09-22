import { UserError } from "../config/errors.mjs";
import { ownerLabel } from "../memory/scope.mjs";
import { releaseJobWorktree } from "./worktree.mjs";

export const PROPOSAL_CHOICES = ["accept", "reject", "keep"];
const SETTLED_STATUS = { accept: "accepted", reject: "rejected" };
const REPORTED_ACTION = { accept: "accepted", reject: "rejected", keep: "kept" };

// Requires one of the ways a proposal can be settled, naming the three in the error.
export function requireProposalChoice(choice) {
  if (PROPOSAL_CHOICES.includes(choice)) return choice;
  throw new UserError(`invalid decisions choice \`${String(choice)}\`; expected one of ${PROPOSAL_CHOICES.join("|")}`);
}

// Settles every open proposal a job stamped as the chooser answers for each: accepted, rejected or kept proposed.
export async function settleJobProposals({ store, jobId, choose }) {
  const proposals = await store.decisions.proposalsOfJob(jobId);
  const settled = [];
  for (const row of proposals) {
    const choice = requireProposalChoice(await choose(row));
    if (SETTLED_STATUS[choice]) await store.decisions.updateDecision(row.id, { status: SETTLED_STATUS[choice] });
    settled.push({ job_id: jobId, id: row.id, number: row.number, label: ownerLabel(row), title: row.title, action: REPORTED_ACTION[choice] });
  }
  return settled;
}

// Closes one job and only then releases its worktree; a refused close throws before anything on disk is touched, and a kept worktree never fails the close.
export async function closeJobAndWorktree({ store, id, env = process.env, killImpl } = {}) {
  const job = await store.jobs.closeJob(id);
  const worktree = await releaseJobWorktree({ job, env, killImpl });
  return { job, worktree };
}

// Closes a shipped job in the ship's one settling write and only then releases its worktree; a refused settle touches nothing on disk.
export async function closeShippedJob({ store, id, worker, ship, noticeLine, env = process.env, killImpl } = {}) {
  const job = await store.jobs.settleShip(id, { worker, ship, noticeLine });
  if (!job) return { job: null, worktree: null };
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
