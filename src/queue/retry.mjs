import { UserError } from "../config/errors.mjs";
import { callerJobId } from "../config/job-home.mjs";
import { ghPrViewAsync } from "../host/gh.mjs";
import { openStore } from "../store/open.mjs";
import { flattenPrState } from "./pr-state.mjs";
import { discardRunDir, PRE_RENUMBERING_REFUSAL, preRenumberingArtifact, rowClaimOrdinal } from "./resume.mjs";
import { consumeRunConclusion } from "./run-state.mjs";
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

// Refuses, with the words `retryJob` would use, a retry the row does not allow, before anything is touched.
async function refuseUnretryableRow(id, note, store) {
  const refusal = await store.jobs.retryRefusalOf(id, { note });
  if (refusal !== null) throw new UserError(refusal);
}

// Tells whether the row is still in the turn the retry checked: any retry, claim or new ending moves one of these.
function sameTurn(before, now) {
  return now?.status === before?.status && now?.attempts === before?.attempts && now?.finished_at === before?.finished_at;
}

// Consumes the last attempt's conclusion before the commit; a row that moved, a record that cannot be written or a run another job stamped refuses the retry with nothing written.
async function consumeLastConclusion({ id, before, run, store }) {
  let now = before;
  const stillCurrent = async () => {
    now = await store.jobs.getJob(id);
    return sameTurn(before, now);
  };
  const consumed = await consumeRunConclusion({ ...run, jobId: id, attempt: before?.attempts, ordinal: rowClaimOrdinal(before), stillCurrent });
  if (consumed.status === "moved") {
    throw new UserError(`${jobRef(id)} changed while this retry was applied (it is now \`${now?.status}\`): nothing was written; read it with nightqueue queue status ${jobRef(id)}`);
  }
  if (consumed.status === "kept") {
    throw new UserError(`${jobRef(id)}: the last attempt's record could not be consumed (${consumed.reason}): retry again in a moment; nothing was written`);
  }
  if (consumed.status === "foreign") {
    throw new UserError(`${jobRef(id)}: the run directory \`${run.slug}\` is stamped by ${jobRef(consumed.stampedBy)}: nothing was written; \`nightqueue queue retry ${jobRef(id)} --fresh\` starts it over and deletes that directory`);
  }
  return consumed;
}

// The line a failed commit carries when the record was already consumed, read from the row as it is now.
async function consumedLine(id, store) {
  try {
    const row = await store.jobs.getJob(id);
    return `\n${jobRef(id)}: the last attempt's record was already consumed and the job is \`${row?.status}\`, its notice still on the row; retry again`;
  } catch {
    return `\n${jobRef(id)}: the last attempt's record was already consumed and the row could not be read; retry again`;
  }
}

// Commits a plain retry; a commit that throws after a consumption says what was consumed and keeps its error class.
async function commitAfterConsumption({ id, note, store, consumed }) {
  try {
    return await store.jobs.retryJob(id, { note, fresh: false });
  } catch (err) {
    if (consumed.status === "written") err.message += await consumedLine(id, store);
    throw err;
  }
}

// Retries one job and, only with `fresh`, drops the run directory of the previous attempt; a plain retry first consumes the last attempt's conclusion, before the commit, so nothing a claimed run records is ever erased and a refused retry touches nothing.
export async function applyRetry({ id, note, fresh = false, env = process.env, prStateImpl = ghPrViewAsync, storeImpl = openStore } = {}) {
  requireOwnJob(id, env);
  refuseOverlongNote(note);
  const store = storeImpl(env);
  const before = await store.jobs.getJob(id);
  await refuseFinishedJob(id, before, { env, prStateImpl });
  if (fresh !== true) refusePreRenumberingRun(before, env);
  await refuseUnretryableRow(id, note, store);
  const run = { projectId: before?.project_id, slug: before?.slug, env };
  if (fresh === true) {
    const job = await store.jobs.retryJob(id, { note, fresh });
    return { job, runDir: discardRunDir(run) };
  }
  const consumed = await consumeLastConclusion({ id, before, run, store });
  return { job: await commitAfterConsumption({ id, note, store, consumed }), runDir: null };
}
