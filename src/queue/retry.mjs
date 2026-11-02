import { resolve } from "node:path";
import { UserError } from "../config/errors.mjs";
import { callerJobId } from "../config/job-home.mjs";
import { runDir } from "../config/paths.mjs";
import { ghPrViewAsync } from "../host/gh.mjs";
import { openStore } from "../store/open.mjs";
import { flattenPrState } from "./pr-state.mjs";
import { pipelineVersionBlock } from "./pipeline-version.mjs";
import { discardRunDir, keptRunDir, ownRunState, readRunState, rowClaimOrdinal } from "./resume.mjs";
import { consumeRunConclusion, recordFreshRetry, stalledPhases } from "./run-state.mjs";
import { ADOPTED_WORKTREE_REASON, DETACHED_WORK_PREFIX, heldBranchOf, inspectJobWorktree, releaseJobWorktree, UNCOMMITTED_WORKTREE_REASON } from "./worktree.mjs";
import { shellQuote } from "../host/shell.mjs";
import { jobRef } from "../memory/refs.mjs";
import { OPERATOR_NOTE_LIMIT } from "../memory/jobs.mjs";

export { callerJobId };

const FINISHED_JOB_TAIL = "a finished job does not resume; queue a new one";
const RETRYABLE_STATUSES = new Set(["gate", "failed", "cancelled"]);

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

// Refuses to resume a run started under another pipeline version, before anything is written; only a fresh retry starts it over.
function refuseVersionChangedRun(run) {
  const block = pipelineVersionBlock(readRunState(run), run.env);
  if (block !== null) throw new UserError(block.message);
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

// The note as the answer the run records, under the attempt that paused; null when the retry carries none.
function answerOf(note, attempt) {
  const text = typeof note === "string" ? note.trim() : "";
  return text === "" ? null : { text, attempt };
}

// Refuses a plain retry of a run whose last two attempts recorded nothing new, before anything is written; a note, `fresh` or a preflight gate, whose fixed cause is all it asks, always passes.
function refuseStalledRun({ id, before, run, note }) {
  if (answerOf(note, null) !== null || typeof before?.blocked_code === "string") return;
  const phases = stalledPhases(ownRunState({ ...run, jobId: id }));
  if (phases === null) return;
  throw new UserError(`${jobRef(id)} made no progress in its last two attempts (same ${phases} phases, no new answer): answer with a note, or retry --fresh`);
}

// Consumes the last attempt's conclusion and records the note before the commit; a row that moved, a record that cannot be written or a run another job stamped refuses the retry with nothing written.
async function consumeLastConclusion({ id, before, run, note, store }) {
  let now = before;
  const stillCurrent = async () => {
    now = await store.jobs.getJob(id);
    return sameTurn(before, now);
  };
  const answer = answerOf(note, before?.attempts);
  const consumed = await consumeRunConclusion({ ...run, jobId: id, attempt: before?.attempts, ordinal: rowClaimOrdinal(before), answer, stillCurrent });
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
    return await store.jobs.retryJob(id, { note, fresh: false, noteRecorded: consumed.answerRecorded === true });
  } catch (err) {
    if (consumed.status === "written") err.message += await consumedLine(id, store);
    throw err;
  }
}

// Refuses a fresh retry whose worktree could not be released, read-only and before anything is written, answering what it read; a worktree the job adopted is the operator's and stays without refusing.
async function refuseUnreleasableWorktree(job, env) {
  if (!RETRYABLE_STATUSES.has(job?.status)) return null;
  const inspected = await inspectJobWorktree({ job, branchStays: true, env });
  if (!inspected || inspected.removable || inspected.reason === ADOPTED_WORKTREE_REASON) return inspected;
  if (inspected.reason === UNCOMMITTED_WORKTREE_REASON) {
    throw new UserError(`the worktree has uncommitted changes at ${inspected.path}; commit or stash them, or retry without --fresh`);
  }
  const unreleased = `the worktree at ${inspected.path} could not be released (${inspected.reason})`;
  if (inspected.reason.startsWith(DETACHED_WORK_PREFIX)) throw new UserError(`${unreleased}; ${detachedExits(inspected.path)}`);
  throw new UserError(`${unreleased}; retry without --fresh`);
}

// The two ways past a detached HEAD holding work: a plain retry places the run's branch on it, and a branch put there by hand makes the fresh retry possible.
function detachedExits(path) {
  const ownBranch = `git -C ${shellQuote(path)} switch -c <name>`;
  return `retry without --fresh and the run puts its own branch on that HEAD and goes on there, or put a branch on it yourself (${ownBranch}) and retry --fresh, which keeps that branch`;
}

// The branch a job's run recorded, which a fresh retry leaves behind, or null when it recorded none.
function recordedBranch(run) {
  const branch = readRunState(run)?.branch;
  return typeof branch === "string" && branch.trim() ? branch.trim() : null;
}

// The branch that carries the work a fresh retry leaves behind: the one the inspected worktree really holds, else the one the run recorded.
async function leftBehindBranch(run, job, inspected) {
  const held = inspected ? await heldBranchOf({ job, path: inspected.path, env: run.env }) : null;
  return held ?? recordedBranch(run);
}

// Marks the state of a fresh retry that may leave its run directory behind, so doctor can name it; answers why it could not, or null.
function markFreshRetry(run, jobId, inspected) {
  if (!inspected || inspected.reason === ADOPTED_WORKTREE_REASON) return null;
  const written = recordFreshRetry({ ...run, jobId });
  return written.status === "written" ? null : written.reason;
}

// The run directory of a fresh retry after the release: kept with a worktree that stayed, since its state is what names that worktree; dropped when none stayed, or when the one that stayed was adopted.
function settleRunDir(run, { worktree, unmarked }) {
  if (worktree?.status !== "kept" || worktree.reason === ADOPTED_WORKTREE_REASON) return discardRunDir(run);
  const unlisted = unmarked === null ? "" : `; doctor cannot list it (${unmarked})`;
  return keptRunDir(resolve(runDir(run.projectId, run.slug, run.env)), `its worktree ${worktree.path} was kept${unlisted}`);
}

// Retries one job and, only with `fresh`, releases the previous attempt's worktree and drops its run directory, naming the branch that stays; a plain retry first consumes the last attempt's conclusion, before the commit, so nothing a claimed run records is ever erased, and the order is fixed, so a refused retry never deletes anything.
export async function applyRetry({ id, note, fresh = false, env = process.env, prStateImpl = ghPrViewAsync, storeImpl = openStore } = {}) {
  requireOwnJob(id, env);
  refuseOverlongNote(note);
  const store = storeImpl(env);
  const before = await store.jobs.getJob(id);
  await refuseFinishedJob(id, before, { env, prStateImpl });
  const run = { projectId: before?.project_id, slug: before?.slug, env };
  if (fresh !== true) refuseVersionChangedRun(run);
  await refuseUnretryableRow(id, note, store);
  if (fresh !== true) {
    refuseStalledRun({ id, before, run, note });
    const consumed = await consumeLastConclusion({ id, before, run, note, store });
    return { job: await commitAfterConsumption({ id, note, store, consumed }), runDir: null, worktree: null, keptBranch: null };
  }
  const inspected = await refuseUnreleasableWorktree(before, env);
  const keptBranch = await leftBehindBranch(run, before, inspected);
  const job = await store.jobs.retryJob(id, { note, fresh });
  const unmarked = markFreshRetry(run, before?.id ?? id, inspected);
  const worktree = await releaseJobWorktree({ job: before, branchStays: true, env });
  return { job, runDir: settleRunDir(run, { worktree, unmarked }), worktree, keptBranch };
}
