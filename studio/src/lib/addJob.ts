import { announceRunner, errorText, type RunnerStart } from "./actions";
import { callTool } from "./mcp";
import { showToast } from "./toast";

export const TIERS = ["auto", "trivial", "simple", "complex"] as const;

export type Tier = (typeof TIERS)[number];

export const PRIORITIES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const DEFAULT_PRIORITY = 5;

export interface AddJobForm {
  project: string;
  issueRef: string | null;
  text: string;
  tier: Tier;
  priority: number;
}

export const EMPTY_ADD_FORM: AddJobForm = { project: "", issueRef: null, text: "", tier: "auto", priority: DEFAULT_PRIORITY };

interface QueuedAnswer {
  ref?: unknown;
  project?: unknown;
}

// The exact arguments `queue_add` gets from the form: the issue with the text as its note, or the text as a free brief; `auto` sends no tier.
export function buildAddArgs(form: AddJobForm): Record<string, unknown> {
  const text = form.text.trim();
  const tier = form.tier === "auto" ? {} : { tier: form.tier };
  if (form.issueRef) return { project: form.project, issue_id: form.issueRef, ...(text ? { prompt: text } : {}), ...tier, priority: form.priority };
  return { project: form.project, prompt: text, ...tier, priority: form.priority };
}

// What still keeps the form from being queued, or null when it is complete.
export function addFormProblem(form: AddJobForm): string | null {
  if (!form.project) return "choose a project";
  if (!form.issueRef && form.text.trim() === "") return "choose an issue or write the brief";
  if (!Number.isInteger(form.priority) || !PRIORITIES.includes(form.priority)) return "choose a priority from 1 to 9";
  return null;
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
