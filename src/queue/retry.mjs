import { UserError } from "../config/errors.mjs";
import { callerJobId } from "../config/job-home.mjs";
import { ghPrViewAsync } from "../host/gh.mjs";
import { openStore } from "../store/open.mjs";
import { flattenPrState } from "./pr-state.mjs";
import { clearRunTerminal, discardRunDir, PRE_RENUMBERING_REFUSAL, preRenumberingArtifact } from "./resume.mjs";
import { clearTermination } from "./run-state.mjs";
import { jobRef } from "../memory/refs.mjs";
import { OPERATOR_NOTE_LIMIT } from "../memory/jobs.mjs";

export { callerJobId };

const FINISHED_JOB_TAIL = "a finished job does not resume; queue a new one";

// Refuses a retry aimed at another job from inside an unattended run: the note becomes a human answer in the next prompt of that job, and the run directory of that job would be deleted.
function requireOwnJob(id, env) {
  const own = callerJobId(env);
  if (own === null || own === Number(id)) return;
  throw new UserError(
    `refusing to retry job \`${id}\` from inside job \`${own}\`: an unattended run may only retry itself; ` +
      `ask the operator to run \`nightqueue queue retry ${jobRef(id)}\` outside the queue`,
  );
}

// Whether GitHub answers that a pull request is merged; a disabled check or a failed read is never proof.
async function isMergedPr(url, { env, prStateImpl }) {
  if (env?.NIGHTQUEUE_NO_PR_CHECK === "1") return false;
  try {
    return flattenPrState(await prStateImpl(url, { env })) === "merged";
  } catch {
    return false;
  }
}

// Refuses a retry of a finished job, a closed one or a done one whose pull request merged, before anything is written.
async function refuseFinishedJob(id, job, { env, prStateImpl }) {
  if (job?.status === "closed") throw new UserError(`${jobRef(id)} is closed: ${FINISHED_JOB_TAIL}`);
  const prUrl = typeof job?.pr_url === "string" ? job.pr_url.trim() : "";
  if (job?.status !== "done" || prUrl === "") return;
  if (await isMergedPr(prUrl, { env, prStateImpl })) {
    throw new UserError(`${jobRef(id)} is done and its pull request is merged: ${FINISHED_JOB_TAIL}`);
  }
}

// Refuses to resume a run directory written under the old phase numbering, before anything is written; only a fresh retry starts it over.
function refusePreRenumberingRun(job, env) {
  if (preRenumberingArtifact({ projectId: job?.project_id, slug: job?.slug, env }) !== null) throw new UserError(PRE_RENUMBERING_REFUSAL);
}

// Refuses an operator answer longer than the resumed prompt carries, before anything is written, so it is never cut silently.
function refuseOverlongNote(note) {
  if (typeof note !== "string") return;
  const length = Array.from(note.trim()).length;
  if (length <= OPERATOR_NOTE_LIMIT) return;
  throw new UserError(
    `the answer is ${length} characters long and the resumed run reads at most ${OPERATOR_NOTE_LIMIT}: shorten it and retry; nothing was written`,
  );
}

// Retries one job (a gate's answer also lifts the runtime's termination of that attempt) and, only with `fresh`, drops the run directory of the previous attempt; the order is fixed, so a refused retry never deletes anything.
export async function applyRetry({ id, note, fresh = false, env = process.env, prStateImpl = ghPrViewAsync } = {}) {
  requireOwnJob(id, env);
  refuseOverlongNote(note);
  const store = openStore(env);
  const before = await store.jobs.getJob(id);
  await refuseFinishedJob(id, before, { env, prStateImpl });
  if (fresh !== true) refusePreRenumberingRun(before, env);
  const job = await store.jobs.retryJob(id, { note, fresh });
  const run = { projectId: before?.project_id, slug: before?.slug, env };
  if (fresh !== true) {
    if (before?.status === "gate") clearTermination(run);
    return { job, runDir: null, witness: clearRunTerminal(run) };
  }
  return { job, runDir: discardRunDir(run), witness: { status: "absent", path: null, reason: null } };
}
