import { jobView } from "../memory/jobs.mjs";
import { worktreeEntry } from "./close.mjs";
import { prStateKey } from "./pr-state.mjs";
import { closeInProcess } from "./close-start.mjs";

// At most this many pull requests are asked about in one invocation, whatever the size of the backlog.
export const CLOSE_MERGED_QUERY_LIMIT = 10;
// The whole refresh this command waits for gh, however many pull requests it asked about.
export const CLOSE_MERGED_DEADLINE_MS = 20_000;

// Human reason for a pull request that did not confirm a merge, from the state the cache holds for it.
function undeterminedReason(state) {
  if (state === "open") return "pull request is open";
  if (state === "closed") return "pull request was closed, not merged";
  if (state === "conflicted") return "pull request has conflicts";
  if (state === "draft") return "pull request is a draft";
  return "gh did not confirm its state";
}

// Splits the close candidates into what the cache already confirms merged, what still needs a gh read (capped at the limit) and what is undetermined without ever asking gh.
function triageCandidates(candidates, prStates, limit) {
  const confirmed = [];
  const toQuery = [];
  const undetermined = [];
  let queried = 0;
  for (const job of candidates) {
    if (prStateKey(job.pr_url) === null) {
      undetermined.push({ id: job.id, reason: "no GitHub pull request url" });
      continue;
    }
    if (prStates.stateOf(job.pr_url) === "merged") {
      confirmed.push(job);
      continue;
    }
    if (prStates.isFresh(job.pr_url)) {
      undetermined.push({ id: job.id, reason: undeterminedReason(prStates.stateOf(job.pr_url)) });
      continue;
    }
    if (queried >= limit) {
      undetermined.push({ id: job.id, reason: `not checked: over the limit of ${limit} per call` });
      continue;
    }
    queried += 1;
    toQuery.push(job);
  }
  return { confirmed, toQuery, undetermined };
}

// Races a refresh of the cache against one overall deadline, so a gh that never answers cannot hang the command.
async function refreshBounded(prStates, urls, env, deadlineMs) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  try {
    await Promise.race([prStates.refresh(urls, env), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

// What a query answered for one candidate, once the refresh settled or the deadline cut it short.
function queriedOutcome(job, prStates) {
  const state = prStates.stateOf(job.pr_url);
  return state === "merged" ? { merged: true, job } : { merged: false, id: job.id, reason: undeterminedReason(state) };
}

// Runs the closing pipeline on one candidate in this process, turning a refusal or a stopped step into a refused entry instead of a thrown error.
async function attemptClose(job, store, env, deps) {
  try {
    const outcome = await closeInProcess({ store, id: job.id, env, deps });
    if (outcome.status !== "closed") return { ok: false, id: job.id, reason: `${outcome.step}: ${outcome.reason}` };
    const closed = jobView(await store.jobs.getJob(job.id));
    return { ok: true, job: closed, worktree: worktreeEntry(closed, outcome.worktree) };
  } catch (err) {
    return { ok: false, id: job.id, reason: err?.message ?? String(err) };
  }
}

// Closes every done job whose pull request the cache confirms merged through the closing pipeline, querying gh only for the gap and never past the bound; only a confirmed merge is closed.
export async function closeMerged({ store, prStates, env, deps = null, limit = CLOSE_MERGED_QUERY_LIMIT, deadlineMs = CLOSE_MERGED_DEADLINE_MS, onChecking } = {}) {
  const candidates = await store.jobs.listCloseCandidates();
  const { confirmed, toQuery, undetermined } = triageCandidates(candidates, prStates, limit);
  if (toQuery.length) {
    onChecking?.(toQuery.length);
    await refreshBounded(prStates, toQuery.map((job) => job.pr_url), env, deadlineMs);
  }
  const queried = toQuery.map((job) => queriedOutcome(job, prStates));
  const toClose = [...confirmed, ...queried.filter((entry) => entry.merged).map((entry) => entry.job)];
  const stillUndetermined = [...undetermined, ...queried.filter((entry) => !entry.merged)];

  const closed = [];
  const refused = [];
  const worktrees = [];
  for (const job of toClose) {
    const result = await attemptClose(job, store, env, deps);
    if (result.ok) closed.push(result.job);
    else refused.push({ id: result.id, reason: result.reason });
    if (result.worktree) worktrees.push(result.worktree);
  }
  return { closed, refused, undetermined: stillUndetermined, worktrees };
}
