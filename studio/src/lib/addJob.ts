import { announceRunner, errorText, type RunnerStart } from "./actions";
import { callTool } from "./mcp";
import { showToast } from "./toast";

export {
  type AddJobForm,
  addFormProblem,
  buildAddArgs,
  clearOrigin,
  DEFAULT_PRIORITY,
  EMPTY_ADD_FORM,
  effectiveProject,
  PRIORITIES,
  TIERS,
  type Tier,
} from "./addJobForm";

interface QueuedAnswer {
  ref?: unknown;
  project?: unknown;
}

// Starts a once runner for a job just queued; a failure is an error toast, never a reason to queue the job again.
async function startRunnerFor(ref: string): Promise<void> {
  try {
    announceRunner(await callTool<RunnerStart>("queue_run", { job_id: ref }), ref);
  } catch (err) {
    showToast(`${ref} is queued, but no runner started: ${errorText(err)}`, "error");
  }
}

// Queues one job with `queue_add`, then, when asked, starts a once runner for it with `queue_run`.
export async function queueJob({ args, start }: { args: Record<string, unknown>; start: boolean }): Promise<void> {
  const answer = await callTool<QueuedAnswer>("queue_add", args);
  const ref = typeof answer?.ref === "string" ? answer.ref : null;
  showToast(ref ? `Queued ${ref} for ${String(answer.project ?? args.project)}` : "Queued the job", "success");
  if (!start) return;
  if (ref === null) {
    showToast("queue_add answered no job ref — start a runner from the banner", "error");
    return;
  }
  await startRunnerFor(ref);
}
