import { readRunState } from "./resume.mjs";
import { recordTermination, terminationRefusal } from "./run-state.mjs";
import { commitWip, WIP_SKIP_REASONS, wipNoticeLine } from "./wip-commit.mjs";

// A trimmed text field of the state, or null.
function stateText(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// The job the run state says it belongs to, or null when it names none.
function stateJobId(state) {
  const id = state?.job?.id;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// The wip commit of the run's recorded worktree, or a skip when the run recorded none.
function wipOfRun({ state, slug, phase, reason, env }) {
  const worktree = stateText(state?.worktree);
  if (worktree === null) return { status: "skipped", branch: null, reason: WIP_SKIP_REASONS.noWorktree };
  return commitWip({ cwd: worktree, slug, phase, reason, prior: state?.wip ?? null, state, env });
}

// Stops a run on purpose: commits its worktree's changes as the wip commit, records the termination with it, and answers the notice the operator reads.
export function terminateRun({ projectId, slug, phase, reason, jobId = null, env = process.env } = {}) {
  const refused = terminationRefusal(phase, reason);
  if (refused) return refused;
  const state = readRunState({ projectId, slug, env });
  const wip = { ...wipOfRun({ state, slug, phase, reason, env }), phase };
  const written = recordTermination({ projectId, slug, phase, reason, wip, env });
  const notice = wipNoticeLine({
    wip,
    jobId: jobId ?? stateJobId(state),
    branch: wip.branch ?? stateText(state?.branch),
    worktree: stateText(state?.worktree),
  });
  return { ...written, wip, notice };
}
