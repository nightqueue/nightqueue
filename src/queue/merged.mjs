import { ghPrView } from "../host/gh.mjs";
import { isoToSqlite } from "../memory/db.mjs";
import { listMergeCandidates, markJobMerged, stampPrChecked } from "../memory/jobs.mjs";
import { callerJobId } from "./retry.mjs";

// A pull request already checked inside this window is not asked about again.
export const PR_CHECK_WINDOW_MS = 5 * 60 * 1000;

// Jobs one sweep checks at most, so a long backlog never turns a `queue status` into a batch of network calls.
export const MERGE_SWEEP_LIMIT = 10;

const PR_URL_RE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/;

// Reader of pull requests bound to one environment, the seam every call site of the sweep passes.
export function prViewer(env, spawnSyncImpl) {
  return (url) => ghPrView(url, { env, spawnSyncImpl });
}

// Tells whether a stored URL is a GitHub pull request, because gh resolves anything else against the current directory.
function isGithubPrUrl(url) {
  return typeof url === "string" && PR_URL_RE.test(url);
}

// Report of a sweep that decided not to run.
function skipReport(reason) {
  return { skipped: reason, checked: 0, merged: 0, undetermined: 0 };
}

// Applies one answer of gh to one job and tells what it wrote; an undetermined answer writes nothing at all.
function applyPrState(job, view, ctx) {
  if (view?.ok !== true) return "undetermined";
  if (view.state !== "MERGED") {
    stampPrChecked(job.id, { checkedAt: ctx.checkedAt }, ctx.env);
    return "checked";
  }
  const mergedAt = isoToSqlite(view.mergedAt) ?? ctx.checkedAt;
  return markJobMerged(job.id, { mergedAt, mergeSha: view.mergeSha, checkedAt: ctx.checkedAt }, ctx.env) ? "merged" : "checked";
}

// Checks one job without ever letting its own failure end the sweep of the ones behind it.
function checkJob(job, ctx) {
  try {
    return applyPrState(job, ctx.viewPr(job.pr_url), ctx);
  } catch {
    return "undetermined";
  }
}

// The clock of a sweep as a Date, or null when the caller handed something that is not an instant.
function toDate(value) {
  const date = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

// Jobs to ask gh about, or null when the query itself failed; a URL gh could resolve against another repository is dropped.
function readCandidates({ env, clock, limit }) {
  const cutoff = isoToSqlite(new Date(clock.getTime() - PR_CHECK_WINDOW_MS));
  try {
    return listMergeCandidates({ cutoff, limit }, env).filter((job) => isGithubPrUrl(job.pr_url));
  } catch {
    return null;
  }
}

// Flips the delivered jobs whose pull request is already merged; it is silent, never throws and writes nothing it could not confirm.
export function refreshMergedJobs({ env = process.env, ghImpl = null, now = () => new Date(), limit = MERGE_SWEEP_LIMIT } = {}) {
  if (env?.NIGHTSHIFT_NO_PR_CHECK === "1") return skipReport("disabled");
  if (callerJobId(env) !== null) return skipReport("inside-job");
  const clock = toDate(now());
  if (!clock) return skipReport("error");
  const checkedAt = isoToSqlite(clock);
  const candidates = readCandidates({ env, clock, limit });
  if (!candidates) return skipReport("error");
  const ctx = { env, checkedAt, viewPr: typeof ghImpl === "function" ? ghImpl : prViewer(env, undefined) };
  const report = { skipped: null, checked: 0, merged: 0, undetermined: 0 };
  for (const job of candidates) {
    report.checked += 1;
    const outcome = checkJob(job, ctx);
    if (outcome === "merged") report.merged += 1;
    if (outcome === "undetermined") report.undetermined += 1;
  }
  return report;
}
