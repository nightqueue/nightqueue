import { UserError } from "../config/errors.mjs";
import { ownerLabel } from "../memory/scope.mjs";

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
