import { postJson } from "./api";
import { callTool } from "./mcp";
import { jobRef } from "./queue";
import { showToast } from "./toast";
import type { Job, Runner, RunnerChoice } from "./types";

export interface RunnerStart {
  started?: boolean;
  pid?: number | null;
  waiting?: unknown;
  message?: string | null;
}

interface StopAnswer {
  ok?: boolean;
  runners?: { outcome?: string; pid?: number | null; message?: string }[];
}

export const APPROVE_NOTE = "Approved as recommended.";

const RETRYABLE: Job["status"][] = ["gate", "failed", "cancelled"];

const CANCELLABLE: Job["status"][] = ["pending", "running", "gate", "done", "failed"];

// The readable message of a failed action.
export function errorText(err: unknown): string {
  return err instanceof Error && err.message ? err.message : String(err);
}

// Says how a runner start went: started in green, `waiting` (nothing started) as a fact, never an error.
export function announceRunner(answer: RunnerStart | null | undefined, subject: string) {
  if (answer?.started === true) {
    showToast(`Runner ${answer.pid ?? "?"} started — ${subject}`, "success");
    return;
  }
  const why = typeof answer?.message === "string" && answer.message ? answer.message : "it cannot be claimed right now";
  showToast(`Nothing started, ${subject} is waiting — ${why}`, "info");
}

// The terminal command that resumes a job's last session.
export function sessionCommand(job: Pick<Job, "id">): string {
  return `nightqueue queue session ${jobRef(job.id)}`;
}

// The studio route serving the last mebibyte of a job's log.
export function rawLogUrl(job: Pick<Job, "id">): string {
  return `/api/jobs/${jobRef(job.id)}/log`;
}

// Tells whether `queue_retry` accepts the job: gated, failed or cancelled.
export function canRetry(job: Job): boolean {
  return RETRYABLE.includes(job.status);
}

// Tells whether `queue_cancel` may take the job: anything not already closed or cancelled.
export function canCancel(job: Pick<Job, "status">): boolean {
  return CANCELLABLE.includes(job.status);
}

// Tells whether `queue_close` takes the job: done, with a pull request, and no close already running.
export function canClose(job: Job): boolean {
  return job.status === "done" && Boolean(job.pr_url) && !job.studio.closing;
}

// Tells whether the job has a session to resume: it ran, and no runner owns it now.
export function hasSession(job: Pick<Job, "status">): boolean {
  return job.status !== "pending" && job.status !== "running";
}

// Tells whether the job has a log to read: it is past pending, or it already ran once.
export function hasLog(job: Pick<Job, "status" | "attempts">): boolean {
  return job.status !== "pending" || job.attempts > 0;
}

// Tells whether a retry of the job must carry a note: a gate the preflight did not block.
export function retryNeedsNote(job: Pick<Job, "status" | "blocked_code">): boolean {
  return job.status === "gate" && !job.blocked_code;
}

// Starts a once runner for one job with `queue_run {job_id}`.
export async function runJob(job: Pick<Job, "id">): Promise<void> {
  const ref = jobRef(job.id);
  announceRunner(await callTool<RunnerStart>("queue_run", { job_id: ref }), ref);
}

// Starts the close pipeline of a done job with `queue_close`.
export async function closeJob(job: Pick<Job, "id">): Promise<void> {
  const ref = jobRef(job.id);
  await callTool("queue_close", { job_id: ref });
  showToast(`Closing ${ref} — its row follows the close`, "success");
}

// Cancels a job with `queue_cancel`; a running one also stops its runner (`stop: true`).
export async function cancelJob(job: Pick<Job, "id" | "status">): Promise<void> {
  const ref = jobRef(job.id);
  const stop = job.status === "running";
  await callTool("queue_cancel", stop ? { job_id: ref, stop: true } : { job_id: ref });
  showToast(`Cancelled ${ref}${stop ? " and stopped its runner" : ""}`, "success");
}

// Sends a job back to the queue with `queue_retry`; with no runner online it also starts one for it.
export async function retryJob({ job, note, runnersOnline }: { job: Pick<Job, "id">; note: string; runnersOnline: number }): Promise<void> {
  const ref = jobRef(job.id);
  const text = note.trim();
  const startRunner = runnersOnline === 0;
  const answer = await callTool<RunnerStart>("queue_retry", { job_id: ref, ...(text ? { note: text } : {}), ...(startRunner ? { run: true } : {}) });
  if (startRunner) announceRunner(answer, ref);
  else showToast(`Retried ${ref} — a live runner claims it`, "success");
}

// The body `/api/runners/start` takes for a loop or window runner.
function watchBody(choice: Extract<RunnerChoice, { mode: "loop" | "window" }>): Record<string, unknown> {
  if (choice.mode === "loop") return { mode: "watch", interval_s: choice.intervalS };
  return { mode: "watch", until: choice.until, ...(choice.from ? { from: choice.from } : {}) };
}

// Starts a runner of the chosen mode: drain and once through `queue_run`, loop and window through the studio API.
export async function startRunner(choice: RunnerChoice): Promise<void> {
  if (choice.mode === "drain") return announceRunner(await callTool<RunnerStart>("queue_run", {}), "drain");
  if (choice.mode === "once") return runJob({ id: choice.jobId });
  announceRunner(await postJson<RunnerStart>("/api/runners/start", watchBody(choice)), choice.mode);
}

// Stops one runner with `queue_stop {pid}`, saying what happened to it.
export async function stopRunner(runner: Pick<Runner, "pid">): Promise<void> {
  const answer = await callTool<StopAnswer>("queue_stop", { pid: runner.pid });
  const report = Array.isArray(answer?.runners) ? answer.runners[0] : undefined;
  showToast(report?.message || `Runner ${runner.pid}: stop sent`, answer?.ok === true ? "success" : "info");
}

// Pauses or resumes claims queue-wide through the studio API.
export async function setQueuePaused(pause: boolean): Promise<void> {
  await postJson(pause ? "/api/queue/pause" : "/api/queue/resume");
  showToast(pause ? "Queue paused — running jobs finish, nothing new is claimed" : "Queue resumed — runners claim again", "success");
}
