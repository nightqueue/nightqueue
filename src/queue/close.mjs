import { UserError } from "../config/errors.mjs";
import { sameBranch } from "./branch-name.mjs";
import { defaultCloseDeps } from "./close-deps.mjs";
import { closedLine, parseCloseChecklist, postCloseLine } from "./close-view.mjs";
import { resolveConflictedRebase } from "./merger.mjs";
import { releaseJobWorktree } from "./worktree.mjs";
import { checkoutOfJob } from "../memory/registry-access.mjs";
import { jobRef } from "../memory/refs.mjs";
import { parseOriginColumn } from "../integrations/origin.mjs";
import { forgetLogged, forgetOrigin, logStep, originStep } from "../integrations/post-close.mjs";

export const CLOSE_LEASE_SLACK_S = 60;
export const POST_CLOSE_TIMEOUT_S = 60;
export const PR_CLOSED_NOTE = "pull request closed without merge";
const STEP_STATUSES = new Set(["done", "skipped", "failed"]);
const ABORTED = Symbol("aborted");

const GH_TIMEOUT_MS = 20000;
const MERGE_TIMEOUT_MS = 60000;
const GIT_TIMEOUT_MS = 120000;
const CLEANUP_TIMEOUT_MS = 15000;
const TEST_RESERVE_MS = 90000;
const UNKNOWN_RETRY_MS = 3000;
const MERGE_REREADS = 3;
const MERGE_REREAD_GAP_MS = 2000;
const CHECKS_POLL_MS = 10000;
const CHECKS_POLL_MAX_MS = 60000;
const CHECKS_WAIT_RESERVE_MS = 30000;
const CI_EMPTY_WINDOW_MS = 60000;
const PUSH_REREADS = 3;
const PUSH_REREAD_GAP_MS = 2000;
const MAX_LOOPBACKS = 2;
const NAMES_SHOWN = 10;
const SUITE_LINES_SHOWN = 20;
const CONFLICTED_STATES = new Set(["CONFLICTING", "DIRTY"]);
const MERGE_REOPEN = ["preflight", "conflict"];

// A failed step result.
function failed(reason, note, extra = {}) {
  return { status: "failed", reason, note, ...extra };
}

// The first non-empty line of a text, or a placeholder naming its absence.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0]?.trim() || "no output";
}

// The non-empty lines of a text.
function linesOf(text) {
  return String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

// The short form of a commit sha.
function sha7(sha) {
  return String(sha ?? "").slice(0, 7);
}

// Up to ten names joined for a note, saying how many more there were.
function namesNote(names) {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN ? `${shown} (+${names.length - NAMES_SHOWN} more)` : shown;
}

// The timeout and signal of a child call: its own timeout, never past the close's deadline.
function bounded(ctx, ownMs) {
  return { timeoutMs: Math.max(1, Math.min(ownMs, ctx.remainingMs())), signal: ctx.signal };
}

// Runs git for a step, in the canonical checkout unless another directory is given.
async function git(ctx, deps, args, { cwd = ctx.checkout, ownMs = GIT_TIMEOUT_MS } = {}) {
  return await deps.git(args, { cwd, ...bounded(ctx, ownMs) });
}

// Runs a cleanup git call with its own short timeout and no signal, so it runs even after the close was aborted; never throws.
async function cleanupGit(deps, args, cwd) {
  try {
    return await deps.git(args, { cwd, timeoutMs: CLEANUP_TIMEOUT_MS });
  } catch (err) {
    return { ok: false, stdout: "", stderr: err?.message ?? String(err) };
  }
}

// Tells whether a read shows an open pull request without the head commit a merge must be pinned to.
function headlessOpenPr(pr) {
  return Boolean(pr?.ok) && pr.state === "OPEN" && !String(pr.headRefOid ?? "").trim();
}

// Reads the pull request of the close as GitHub has it now; an open one without a head commit is unreadable.
async function readPr(ctx, deps) {
  const pr = await deps.gh.prDetail(ctx.prUrl, bounded(ctx, GH_TIMEOUT_MS));
  return headlessOpenPr(pr) ? { ok: false, error: "GitHub answered no head commit for the open pull request" } : pr;
}

// The failure of a pull request gh could not read.
function unreadablePr(ctx, pr) {
  return failed("pr-unreadable", `gh could not read ${ctx.prUrl} (${pr?.error ?? "no answer"})`);
}

// The data a close keeps about its pull request from one read.
function prData(pr) {
  const data = { prNumber: pr.number, title: pr.title, headBranch: pr.headRefName, baseBranch: pr.baseRefName };
  return pr.headRefOid ? { ...data, headSha: pr.headRefOid } : data;
}

// The data that records a merged pull request, as GitHub reports it, and who merged it: `nightqueue` or the `operator` outside a close.
function mergedData(pr, mergedBy) {
  return { merged: true, mergeSha: pr.mergeSha ?? null, mergedAt: pr.mergedAt ?? null, mergedBy };
}

// Who merged a pull request a step reads already merged: whoever the checklist already names, else the operator, outside a close.
function mergedByOf(ctx) {
  return ctx.data.mergedBy ?? "operator";
}

// Waits between two reads through the injected sleep, never past the deadline.
async function pause(ctx, deps, ms) {
  await deps.sleep(Math.max(0, Math.min(ms, ctx.remainingMs())), ctx.signal);
}

// Tells whether a read settles the post-push wait: a readable pull request not open, or showing the expected head with its mergeability computed.
function settlesPushedRead(pr, expected) {
  if (!pr?.ok) return false;
  return pr.state !== "OPEN" || (pr.headRefOid === expected && pr.mergeable !== "UNKNOWN");
}

// Reads the pull request after the close pushed its head, a few times at most, until GitHub shows the expected head.
async function readPushedPr(ctx, deps, expected) {
  let last = null;
  for (let attempt = 0; attempt < PUSH_REREADS; attempt += 1) {
    if (attempt > 0) await pause(ctx, deps, PUSH_REREAD_GAP_MS);
    last = await readPr(ctx, deps);
    if (settlesPushedRead(last, expected)) return last;
  }
  return last;
}

// Reads the pull request, retrying while GitHub still lags behind a head this close pushed.
async function readHeadPr(ctx, deps) {
  return ctx.data.pushedBy === "close" && ctx.data.headSha ? await readPushedPr(ctx, deps, ctx.data.headSha) : await readPr(ctx, deps);
}

// What the checks of the pull request said, as a stop of the close or the note of checks that let it go on.
function checksReading(ctx, checks) {
  if (!checks?.ok) return { problem: failed("checks-unreadable", `gh could not read the checks of ${ctx.prUrl} (${checks?.error ?? "no answer"})`) };
  if (checks.failing.length) return { problem: failed("checks-red", `failing checks: ${namesNote(checks.failing)}`) };
  if (checks.pending.length) return { problem: failed("checks-pending", `checks still running: ${namesNote(checks.pending)}; run again once they finish`) };
  return { note: checks.checks.length ? `${checks.checks.length} checks green` : "no checks reported" };
}

// The note of checks `--force` let the close go past, naming what they said.
function ignoredChecksNote(checks) {
  if (!checks?.ok) return `checks ignored with --force: unreadable: ${checks?.error ?? "no answer"}`;
  const said = [
    checks.failing.length ? `failing: ${namesNote(checks.failing)}` : null,
    checks.pending.length ? `pending: ${namesNote(checks.pending)}` : null,
  ].filter(Boolean);
  return `checks ignored with --force: ${said.join("; ")}`;
}

// Reads the checks of the pull request; a read gh attributes to another head than the one judged is unreadable.
async function readHeadChecks(ctx, deps, head) {
  const checks = await deps.gh.prChecks(ctx.prUrl, bounded(ctx, GH_TIMEOUT_MS));
  if (!checks?.ok || !checks.headSha || !head || checks.headSha === head) return checks;
  return { ok: false, checks: [], failing: [], pending: [], otherHead: checks.headSha, error: `the checks gh read belong to ${sha7(checks.headSha)}, not ${sha7(head)}` };
}

// The durable record of a head CI verified: only a non-empty all-green rollup, never under --force.
function ciGreenData(ctx, checks, head) {
  const green = checks?.ok && checks.checks.length > 0 && !checks.failing.length && !checks.pending.length;
  return green && head && !ctx.force ? { ciGreenSha: head } : {};
}

// Tells whether the checks of the pull request stop the close, and what they said; with --force they never stop it and the note names them.
async function checksVerdict(ctx, deps, head) {
  const checks = await readHeadChecks(ctx, deps, head);
  const reading = checksReading(ctx, checks);
  if (reading.problem) return ctx.force ? { note: ignoredChecksNote(checks) } : reading;
  return { ...reading, data: ciGreenData(ctx, checks, head) };
}

// The paths `git status --porcelain -z` lists, renamed ones under both names.
function porcelainPaths(stdout) {
  const tokens = String(stdout ?? "").split("\0");
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2)) && tokens[index + 1]) paths.push(tokens[++index]);
  }
  return paths;
}

// The files the pull after the merge would bring into the canonical checkout, or null when that cannot be told.
async function incomingFiles(ctx, deps, base) {
  if (!base) return null;
  const prFiles = await deps.gh.prDiffNames(ctx.prUrl, bounded(ctx, GH_TIMEOUT_MS));
  const baseDiff = await git(ctx, deps, ["diff", "--name-only", "HEAD", `origin/${base}`]);
  if (!prFiles?.ok || !baseDiff.ok) return null;
  return new Set([...prFiles.files, ...linesOf(baseDiff.stdout)]);
}

// Tells whether local changes in the canonical checkout would stop the pull after the merge; nightqueue never stashes them.
async function checkoutVerdict(ctx, deps, base) {
  const status = await git(ctx, deps, ["status", "--porcelain", "-z"]);
  if (!status.ok) return { problem: failed("checkout-dirty", `git status failed in ${ctx.checkout} (${firstLine(status.stderr)})`) };
  const dirty = porcelainPaths(status.stdout);
  if (!dirty.length) return { note: "canonical checkout clean" };
  const incoming = await incomingFiles(ctx, deps, base);
  if (!incoming) return { problem: failed("checkout-dirty", `${dirty.length} local changes in ${ctx.checkout} and nightqueue cannot tell which files the pull would bring`) };
  const touched = dirty.filter((path) => incoming.has(path));
  if (touched.length) {
    return { problem: failed("checkout-dirty", `local changes in ${ctx.checkout} the pull would touch: ${namesNote(touched)}; commit or stash them yourself; nightqueue never stashes`) };
  }
  return { note: `${dirty.length} local changes the pull does not touch` };
}

// Tells whether the pull request is on the job's own branch (or its published alias), and what the check leaves in the note.
function attributionVerdict(ctx, pr) {
  const branch = typeof ctx.branch === "string" ? ctx.branch.trim() : "";
  if (!branch) return { note: "branch not recorded; attribution not checked" };
  if (sameBranch(pr.headRefName, branch, { type: ctx.type, slug: ctx.slug })) return { note: null };
  const head = pr.headRefName || "unknown";
  const note = `PR #${pr.number} is on branch \`${head}\`, but ${jobRef(ctx.jobId)} ran on \`${branch}\`; it is not this job's pull request. Fix the job's pr_url before closing it`;
  return { problem: failed("pr-not-the-job-branch", note) };
}

// A step note with the attribution note appended when there is one.
function withAttributionNote(note, attribution) {
  return attribution.note ? `${note}; ${attribution.note}` : note;
}

// The checks verdict of preflight; checks still running are waited on within the close's budget instead of stopping it.
async function checksOrWait(ctx, deps, data) {
  const waitsFirst = ctx.data.pushedBy === "close" && Boolean(data.headSha) && !ctx.force;
  const checks = waitsFirst ? null : await checksVerdict(ctx, deps, data.headSha);
  if (checks && (checks.problem?.reason !== "checks-pending" || !data.headSha)) return checks;
  const waited = await waitForChecks(ctx, deps, { status: "done", note: "checks waited", data }, `checks still running on ${sha7(data.headSha)}`);
  return waited.status === "done" ? { note: waited.note, data: waited.data } : { problem: { ...waited, reopen: [] } };
}

// The tip of a branch as `git fetch` left it in the canonical checkout, or null when it cannot be told.
async function remoteHead(ctx, deps, fetchedOk, branch) {
  if (!fetchedOk || !branch) return null;
  const resolved = await git(ctx, deps, ["rev-parse", `origin/${branch}`]);
  return resolved.ok ? resolved.stdout.trim() || null : null;
}

// The head preflight expects after this close's push: the recorded one, else the branch tip git fetched; null when nothing was pushed.
async function expectedPushedHead(ctx, deps, fetchedOk) {
  if (ctx.data.pushedBy !== "close") return null;
  return ctx.data.headSha ?? (await remoteHead(ctx, deps, fetchedOk, ctx.data.headBranch));
}

// The note lead and data of a head GitHub shows other than the recorded one, or null when it did not move.
function movedHead(ctx, pr) {
  if (!headMoved(ctx, pr)) return null;
  return { lead: `the head moved from ${sha7(ctx.data.headSha)} to ${sha7(pr.headRefOid)}`, data: { headSha: pr.headRefOid, pushedBy: null } };
}

// What CI says about one head: a stop, no check at all (`empty`), or green now or once waited for (`slow`).
async function ciVerdict(ctx, deps, { head, lead, data, reopen }) {
  const prefix = lead ? `${lead}; ` : "";
  const checks = await readHeadChecks(ctx, deps, head);
  if (!checks?.ok) return { problem: failed("checks-unreadable", `${prefix}gh could not read the checks of ${ctx.prUrl} (${checks?.error ?? "no answer"})`, { reopen }) };
  if (checks.failing.length) return { problem: failed("checks-red", `${prefix}failing checks: ${namesNote(checks.failing)}`, { data, reopen }) };
  if (!checks.checks.length) return { empty: true, note: lead, data };
  if (!checks.pending.length) return { note: `${prefix}${checksGreenNote(checks, head)}`, data: { ...data, ...ciGreenData(ctx, checks, head) } };
  const waiting = { status: "done", note: lead ?? `checks waited on ${sha7(head)}`, data: { ...data, headSha: head } };
  const waited = await waitForChecks(ctx, deps, waiting, `checks still running on ${sha7(head)}`);
  if (waited.status !== "done") return { problem: { ...waited, reopen } };
  return { note: waited.note, data: waited.data, slow: true, changed: waited.headChanged === true };
}

// How preflight and conflict go on with a head other than the one recorded: they note it and what CI says; only the merge step accepts it.
async function movedHeadVerdict(ctx, deps, pr, { reopen }) {
  const { lead, data } = movedHead(ctx, pr);
  const to = sha7(pr.headRefOid);
  if (ctx.force) return { note: `${lead}; taken with --force`, data };
  const verdict = await ciVerdict(ctx, deps, { head: pr.headRefOid, lead, data, reopen });
  return verdict.empty ? { note: `${lead}; no CI reports on ${to} yet; the merge step verifies this head`, data } : verdict;
}

// Whether GitHub's read of a pull request this close pushed is confirmed, by the push record or by the branch tip git fetched; otherwise the stop.
async function pushedHeadVerdict(ctx, deps, { pr, expected, fetchedOk }) {
  if (expected && pr.headRefOid === expected) return { pushedBy: "close" };
  const head = await remoteHead(ctx, deps, fetchedOk, pr.headRefName);
  const gitAgrees = Boolean(head) && pr.headRefOid === head;
  if (gitAgrees && !ctx.data.headSha) return { pushedBy: "close" };
  if (gitAgrees) {
    const moved = await movedHeadVerdict(ctx, deps, pr, { reopen: ["conflict"] });
    return moved.problem ? moved : { pushedBy: null, note: moved.note, data: moved.data };
  }
  const pushed = expected ?? head;
  const note = `this close pushed ${sha7(pushed)}, but GitHub still shows ${sha7(pr.headRefOid)} after ${PUSH_REREADS} reads; run again`;
  return { problem: failed("head-not-visible", note, { data: !ctx.data.headSha && pushed ? { headSha: pushed } : {} }) };
}

// The preflight note of a head this close pushed, or an empty suffix.
function pushedHeadNote(data) {
  return data.pushedBy === "close" ? `; head ${sha7(data.headSha)} pushed by this close` : "";
}

// Checks, before anything is changed, that the pull request is the job's own, open, green and pullable into the canonical checkout.
async function preflightStep({ ctx, deps }) {
  if (!ctx.checkout || !deps.fs.exists(ctx.checkout)) return failed("checkout-missing", `the checkout of project \`${ctx.project}\` is missing: ${ctx.checkout ?? "not registered"}`);
  const fetched = await git(ctx, deps, ["fetch", "origin"]);
  const data = { fetchWarning: fetched.ok ? null : `WARNING: git fetch origin failed (${firstLine(fetched.stderr)})` };
  const expected = await expectedPushedHead(ctx, deps, fetched.ok);
  const pr = expected ? await readPushedPr(ctx, deps, expected) : await readPr(ctx, deps);
  if (!pr?.ok) return { ...unreadablePr(ctx, pr), data };
  const verdict = ctx.data.pushedBy === "close" && pr.state === "OPEN" ? await pushedHeadVerdict(ctx, deps, { pr, expected, fetchedOk: fetched.ok }) : null;
  if (verdict?.problem) return { ...verdict.problem, data: { ...data, ...verdict.problem.data } };
  Object.assign(data, prData(pr));
  if (verdict) data.pushedBy = verdict.pushedBy;
  const attribution = attributionVerdict(ctx, pr);
  if (attribution.problem) return { ...attribution.problem, data };
  if (pr.state === "CLOSED") return failed("pr-closed", `PR #${pr.number} was closed without being merged`, { data });
  if (pr.state === "MERGED") return { status: "done", note: withAttributionNote(`PR #${pr.number} already merged as ${sha7(pr.mergeSha)}`, attribution), data: { ...data, ...mergedData(pr, mergedByOf(ctx)) } };
  const checks = verdict?.note ? verdict : await checksOrWait(ctx, deps, data);
  if (checks.problem) return { ...checks.problem, data };
  Object.assign(data, checks.data ?? {});
  const checkout = await checkoutVerdict(ctx, deps, pr.baseRefName);
  if (checkout.problem) return { ...checkout.problem, data };
  return { status: "done", note: withAttributionNote(`PR #${pr.number} open; ${checks.note}; ${checkout.note}${pushedHeadNote(data)}`, attribution), data };
}

// Reads the pull request's mergeability, reading once more after a pause when GitHub has not computed it yet.
async function readMergeability(ctx, deps) {
  const pr = await readHeadPr(ctx, deps);
  if (!pr?.ok || pr.state !== "OPEN" || pr.mergeable !== "UNKNOWN") return pr;
  await pause(ctx, deps, UNKNOWN_RETRY_MS);
  return await readPr(ctx, deps);
}

// Tells whether the head GitHub shows is another than the recorded one.
function headMoved(ctx, pr) {
  return Boolean(ctx.data.headSha) && pr.headRefOid !== ctx.data.headSha;
}

// A step result with the note and data of a moved head the step went on with put before its own.
function withMovedHead(moved, result) {
  if (!moved) return result;
  return { ...result, note: `${moved.note}; ${result.note}`, data: { ...moved.data, ...(result.data ?? {}) } };
}

// Rebases the pull request when GitHub says it conflicts with its base; otherwise there is nothing to do here.
async function conflictStep({ ctx, deps }) {
  if (ctx.data.merged) return { status: "skipped", note: "the pull request is already merged" };
  const pr = await readMergeability(ctx, deps);
  if (!pr?.ok) return unreadablePr(ctx, pr);
  if (pr.state === "MERGED") return { status: "skipped", note: "the pull request is already merged", data: mergedData(pr, mergedByOf(ctx)) };
  if (pr.state === "CLOSED") return failed("pr-closed", `PR #${pr.number} was closed without being merged`);
  const moved = headMoved(ctx, pr) ? await movedHeadVerdict(ctx, deps, pr, { reopen: ["preflight"] }) : null;
  if (moved?.problem) return moved.problem;
  return withMovedHead(moved, await conflictVerdict(ctx, deps, pr));
}

// What the conflict step does with an open pull request at the head it goes on with.
async function conflictVerdict(ctx, deps, pr) {
  if (pr.mergeStateStatus === "BEHIND") return await updateBehindHead(ctx, deps, { head: pr.headRefName, base: pr.baseRefName });
  if (pr.mergeStateStatus === "BLOCKED" && pr.mergeable === "MERGEABLE") return await waitBlockedHead(ctx, deps, pr);
  if (pr.mergeable === "MERGEABLE" || pr.mergeStateStatus === "CLEAN") return { status: "skipped", note: `mergeable (${pr.mergeStateStatus ?? pr.mergeable})` };
  if (pr.mergeable === "UNKNOWN") return failed("mergeability-unknown", "GitHub has not computed whether the pull request merges; run again in a minute");
  if (CONFLICTED_STATES.has(pr.mergeable) || CONFLICTED_STATES.has(pr.mergeStateStatus)) return await rebaseInThrowaway(ctx, deps, { head: pr.headRefName, base: pr.baseRefName });
  return { status: "skipped", note: `mergeable is ${pr.mergeable ?? "unknown"} (${pr.mergeStateStatus ?? "no state"}); the merge step decides` };
}

// Waits for the checks of the head GitHub reports mergeable but BLOCKED; --force skips the wait, no checks go on at once.
async function waitBlockedHead(ctx, deps, pr) {
  if (ctx.force) return { status: "skipped", note: "merge state BLOCKED; checks not waited with --force" };
  const head = sha7(pr.headRefOid);
  const blocked = { status: "done", note: `merge state BLOCKED on ${head}`, data: { headSha: pr.headRefOid } };
  return await waitForChecks(ctx, deps, blocked, `merge blocked on ${head}, checks still running`, { emptySettles: true });
}

// Brings a head behind its base up to date with the rebase path, then waits for the required checks of the new head.
async function updateBehindHead(ctx, deps, branches) {
  const updated = await rebaseInThrowaway(ctx, deps, branches);
  if (updated.status !== "done" || ctx.force) return updated;
  return await waitForChecks(ctx, deps, updated, `branch updated to ${sha7(updated.data.headSha)}, checks still running`);
}

// The success note of a checks wait: how many checks went green on the head, or that none was reported.
function checksGreenNote(checks, sha) {
  return checks.checks.length ? `${checks.checks.length} checks green on ${sha7(sha)}` : `no checks reported on ${sha7(sha)}`;
}

// The stop of a checks wait out of time: checks-unreadable when its last read failed, checks-pending otherwise.
function checksWaitStop(ctx, { checks, data, stillRunning, stop }) {
  if (!checks?.ok) return failed("checks-unreadable", `gh could not read the checks of ${ctx.prUrl} (${checks?.error ?? "no answer"}) while waiting on ${sha7(data.headSha)}`, stop);
  return failed("checks-pending", `${stillRunning} - run queue close ${jobRef(ctx.jobId)} again`, stop);
}

// The progress line of the checks of a head, or null when they could not be read.
function checksProgress(sha, checks) {
  if (!checks?.ok) return null;
  const total = checks.checks.length;
  return `waiting for checks on ${sha7(sha)}: ${total - checks.pending.length}/${total} done`;
}

// Tells whether a read shows no check at all on the head.
function noChecksRead(checks) {
  return Boolean(checks?.ok) && !checks.checks.length;
}

// The end of a wait whose checks gh reads on another head than the waited one or the one it replaced: the live head is judged again.
function headChangedWait(updated, checks) {
  const note = `${updated.note}; the checks now belong to ${sha7(checks.otherHead)}, not ${sha7(updated.data.headSha)}; the merge step judges the live head`;
  return { ...updated, note, headChanged: true };
}

// The result one checks read settles a wait with, or null to keep waiting; `noCi` marks an empty rollup that outlasted its window.
function settledWait(ctx, { updated, checks, emptySettles, windowOut }) {
  const { data } = updated;
  if (checks?.otherHead && checks.otherHead !== data.headShaBefore) return headChangedWait(updated, checks);
  if (!checks?.ok) return null;
  if (checks.failing.length) return failed("checks-red", `failing checks: ${namesNote(checks.failing)}`, { data, reopen: ["preflight"] });
  if (checks.pending.length) return null;
  if (checks.checks.length || emptySettles) {
    return { ...updated, note: `${updated.note}; ${checksGreenNote(checks, data.headSha)}`, data: { ...data, ...ciGreenData(ctx, checks, data.headSha) } };
  }
  return windowOut ? { ...updated, noCi: true } : null;
}

// Polls the checks of the updated head with a growing gap until they are all green, one is red or the close's time is nearly out.
// With `emptyWindowMs`, an empty rollup is polled for that long at most and then answered as `noCi`.
async function waitForChecks(ctx, deps, updated, stillRunning, { emptySettles = false, emptyWindowMs = 0 } = {}) {
  const { data } = updated;
  let waitedMs = 0;
  for (let attempt = 0, gap = CHECKS_POLL_MS; ; attempt += 1, gap = Math.min(gap * 2, CHECKS_POLL_MAX_MS)) {
    const checks = await readHeadChecks(ctx, deps, data.headSha);
    const settles = emptySettles || (attempt > 0 && !emptyWindowMs);
    const settled = settledWait(ctx, { updated, checks, emptySettles: settles, windowOut: emptyWindowMs > 0 && waitedMs >= emptyWindowMs });
    if (settled) return settled;
    await ctx.progress?.(checksProgress(data.headSha, checks) ?? `waiting for checks on ${sha7(data.headSha)}: not readable yet`);
    if (ctx.remainingMs() <= CHECKS_WAIT_RESERVE_MS) return checksWaitStop(ctx, { checks, data, stillRunning, stop: { data, reopen: ["preflight"] } });
    const windowLeft = emptyWindowMs && noChecksRead(checks) ? emptyWindowMs - waitedMs : gap;
    const ms = Math.min(gap, windowLeft, ctx.remainingMs() - CHECKS_WAIT_RESERVE_MS);
    await pause(ctx, deps, ms);
    waitedMs += ms;
  }
}

// Creates the throwaway detached worktree of the pull request's head, or answers why it could not.
async function addThrowaway(ctx, deps, head) {
  let dir = null;
  try {
    dir = deps.fs.makeTempDir(`nightqueue-close-${ctx.jobId}-`);
  } catch (err) {
    return { problem: failed("worktree-failed", `could not create a temporary directory: ${err?.message ?? String(err)}`) };
  }
  const added = await git(ctx, deps, ["worktree", "add", "--detach", dir, `origin/${head}`]);
  if (added.ok) return { dir };
  await removeThrowaway(ctx, deps, dir);
  return { problem: failed("worktree-failed", `git worktree add failed (${firstLine(added.stderr)})`) };
}

// Removes the throwaway worktree and its directory, each part best-effort.
async function removeThrowaway(ctx, deps, dir) {
  await cleanupGit(deps, ["worktree", "remove", "--force", dir], ctx.checkout);
  removeDirQuietly(deps, dir);
  await cleanupGit(deps, ["worktree", "prune"], ctx.checkout);
}

// Removes a temporary directory; one left behind never fails the close.
function removeDirQuietly(deps, dir) {
  try {
    deps.fs.removeDir(dir);
  } catch {
    return;
  }
}

// Fetches both branches and rebases the head onto the base in a throwaway worktree, removed whatever happens.
async function rebaseInThrowaway(ctx, deps, { head, base }) {
  if (!head || !base) return failed("fetch-failed", "gh did not report the head and base branches of the pull request");
  const fetched = await git(ctx, deps, ["fetch", "origin", head, base]);
  if (!fetched.ok) return failed("fetch-failed", `git fetch origin ${head} ${base} failed (${firstLine(fetched.stderr)})`);
  const before = await git(ctx, deps, ["rev-parse", `origin/${head}`]);
  if (!before.ok) return failed("fetch-failed", `origin/${head} could not be resolved (${firstLine(before.stderr)})`);
  const branches = { head, base, headShaBefore: before.stdout.trim() };
  const throwaway = await addThrowaway(ctx, deps, head);
  if (throwaway.problem) return { ...throwaway.problem, data: { headShaBefore: branches.headShaBefore } };
  try {
    return await rebaseTestAndPush(ctx, deps, { ...branches, dir: throwaway.dir });
  } finally {
    await removeThrowaway(ctx, deps, throwaway.dir);
  }
}

// The stop of a step that finds the close aborted before an irreversible call, so a step the abort orphaned never pushes nor merges.
function abortedBefore(action) {
  return failed("interrupted", `the close was interrupted before the ${action}, which was not made`);
}

// Rebases in the throwaway worktree, runs the suite unless --force skips it, and pushes only when nothing stopped it.
async function rebaseTestAndPush(ctx, deps, work) {
  const data = { headShaBefore: work.headShaBefore };
  deps.fs.linkNodeModules(ctx.checkout, work.dir);
  const rebased = await git(ctx, deps, ["rebase", `origin/${work.base}`], { cwd: work.dir });
  let resolution = null;
  if (!rebased.ok) {
    const stop = await stopConflictedRebase(ctx, deps, { ...work, data, stderr: rebased.stderr });
    if (!stop.resolution) return stop;
    resolution = stop.resolution;
  }
  const markers = await leftoverMarkers(ctx, deps, work);
  if (markers.length) return failed("real-conflict", `conflict markers left in: ${namesNote(markers)}`, { data });
  const suite = ctx.force ? {} : await runSuite(ctx, deps, work.dir);
  if (suite.problem) return { ...suite.problem, data };
  if (ctx.signal?.aborted) return { ...abortedBefore("push"), data };
  const pushed = await git(ctx, deps, ["push", `--force-with-lease=refs/heads/${work.head}:${work.headShaBefore}`, "origin", `HEAD:refs/heads/${work.head}`], { cwd: work.dir });
  if (!pushed.ok) return failed("push-refused", `git push to ${work.head} was refused (${firstLine(pushed.stderr)})`, { data });
  const after = await git(ctx, deps, ["rev-parse", "HEAD"], { cwd: work.dir });
  if (!after.ok) {
    const note = `pushed ${sha7(work.headShaBefore)} -> ? but the new head could not be read (${firstLine(after.stderr)}); run again`;
    return failed("head-unreadable", note, { data: { ...data, headSha: null, pushedBy: "close" }, reopen: ["preflight"] });
  }
  data.headSha = after.stdout.trim();
  const note = rebasePushNote(ctx, { work, resolution, headSha: data.headSha });
  const verified = ctx.force || !data.headSha ? {} : { verifiedSha: data.headSha };
  return { status: "done", note, data: { ...data, pushedBy: "close", ...verified }, reopen: ["preflight"] };
}

// The note of a pushed rebase: the merger's resolution when it ran, else the plain rebase with or without the suite.
function rebasePushNote(ctx, { work, resolution, headSha }) {
  const pushed = `pushed ${sha7(work.headShaBefore)} -> ${sha7(headSha)}`;
  if (resolution) return `resolved by merger: ${resolution.hunks} hunks in ${resolution.files.length} files (${namesNote(resolution.files)}); suite green; ${pushed}`;
  const suiteNote = ctx.force ? "suite skipped with --force" : "suite green";
  return `rebased onto origin/${work.base}, ${suiteNote}, ${pushed}`;
}

// The record of what the merger did with a conflict, kept in the step's data.
function mergerRecord(merger) {
  if (merger.resolved) return { status: "resolved", hunks: merger.hunks, files: merger.files };
  if (!merger.eligible) return { status: "not-eligible", reason: merger.reason };
  return { status: "unresolved", reason: merger.reason, hunks: merger.hunks, files: merger.files };
}

// Records the conflict of a stopped rebase and hands it to the merger; what the merger does not resolve is aborted and answered naming the conflicted files.
async function stopConflictedRebase(ctx, deps, work) {
  const unmerged = await git(ctx, deps, ["diff", "--name-only", "--diff-filter=U"], { cwd: work.dir });
  const files = linesOf(unmerged.stdout);
  const prFiles = await deps.gh.prDiffNames(ctx.prUrl, bounded(ctx, GH_TIMEOUT_MS));
  work.data.conflict = { files, prFiles: prFiles?.ok ? prFiles.files : null, base: work.base, head: work.head, headSha: work.headShaBefore };
  const merger = files.length ? await resolveConflictedRebase(ctx, deps, { ...work, files, reserveMs: TEST_RESERVE_MS }) : null;
  if (merger) work.data.merger = mergerRecord(merger);
  if (merger?.resolved) return { resolution: merger };
  await cleanupGit(deps, ["rebase", "--abort"], work.dir);
  if (files.length) return failed("real-conflict", realConflictNote(work, { files, merger }), { data: work.data });
  return failed("rebase-failed", `git rebase origin/${work.base} failed (${firstLine(work.stderr)})`, { data: work.data });
}

// The note of a real conflict: the conflicted files, plus the merger's reason when it was eligible.
function realConflictNote(work, { files, merger }) {
  const note = `rebase onto origin/${work.base} conflicts in: ${namesNote(merger?.files ?? files)}`;
  return merger?.eligible ? `${note}; merger: ${merger.reason}` : note;
}

// The files a clean rebase still left conflict markers in.
async function leftoverMarkers(ctx, deps, work) {
  const checked = await git(ctx, deps, ["diff", "--check", `origin/${work.base}`, "HEAD"], { cwd: work.dir });
  const lines = linesOf(`${checked.stdout}\n${checked.stderr}`).filter((line) => line.includes("conflict marker"));
  return [...new Set(lines.map((line) => line.split(":")[0]))];
}

// Runs the project's suite in the throwaway worktree within what is left of the deadline, keeping a reserve for the push and the merge.
async function runSuite(ctx, deps, dir) {
  if (!deps.fs.readTestScript(dir)) return { problem: failed("no-test-script", "the package.json of the pull request has no scripts.test; a rebase that cannot be tested is never pushed") };
  const timeoutMs = ctx.remainingMs() - TEST_RESERVE_MS;
  if (timeoutMs <= 0) return { problem: failed("timeout", "not enough of the close's timeout is left to run the suite") };
  const suite = await deps.runTest({ cwd: dir, timeoutMs, signal: ctx.signal });
  if (suite?.ok) return {};
  const tail = String(suite?.output ?? "").split("\n").slice(-SUITE_LINES_SHOWN).join("\n").trim();
  const why = suite?.timedOut ? `npm test timed out after ${Math.round(timeoutMs / 1000)} s` : "npm test failed";
  return { problem: failed("suite-red", `${why}; nothing was pushed${tail ? `:\n${tail}` : ""}`) };
}

// Re-reads the pull request after a merge call until GitHub reports its merge commit, a few times at most.
async function rereadMerge(ctx, deps) {
  let last = null;
  for (let attempt = 0; attempt < MERGE_REREADS; attempt += 1) {
    if (attempt > 0) await pause(ctx, deps, MERGE_REREAD_GAP_MS);
    if (ctx.signal?.aborted) break;
    last = await readPr(ctx, deps);
    if (last?.ok && last.state === "MERGED" && last.mergeSha) return last;
  }
  return last;
}

// Pulls the merge into the canonical checkout when it is on the base branch; the result is only noted, never a failure.
async function pullBase(ctx, deps, base) {
  const branch = await git(ctx, deps, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch.ok) return `canonical checkout not pulled: its branch could not be read (${firstLine(branch.stderr)})`;
  const current = branch.stdout.trim();
  if (!base || current !== base) return `canonical checkout is on ${current}, not ${base ?? "the base"}; not pulled`;
  const pulled = await git(ctx, deps, ["pull", "--ff-only"]);
  return pulled.ok ? `canonical checkout fast-forwarded on ${base}` : `git pull --ff-only failed (${firstLine(pulled.stderr)}); pull it yourself`;
}

// The done result of a merged pull request: its merge commit and who merged it recorded, and the canonical checkout pulled when it can be.
async function mergedResult(ctx, deps, { pr, note, mergedBy }) {
  const data = mergedData(pr, mergedBy);
  const pulled = await pullBase(ctx, deps, ctx.data.baseBranch ?? pr.baseRefName ?? null);
  return { status: "done", note: `${note} as ${sha7(data.mergeSha)}; ${pulled}`, data };
}

// The result of a merge the step finds already made: skipped as `merged outside a close` when the operator made it, done when nightqueue did.
async function madeMergeResult(ctx, deps, { pr, mergedBy }) {
  if (mergedBy !== "operator") return await mergedResult(ctx, deps, { pr, note: "already merged", mergedBy });
  const result = await mergedResult(ctx, deps, { pr, note: "merged outside a close", mergedBy });
  return { ...result, status: "skipped" };
}

// The failure of a merge GitHub does not show with a merge commit; a merged state is still recorded, so no re-run merges again.
function mergeWithoutSha({ pr, call }) {
  const mergedBy = call ? { mergedBy: "nightqueue" } : {};
  const data = pr?.ok && pr.state === "MERGED" ? { merged: true, mergedAt: pr.mergedAt ?? null, ...mergedBy } : {};
  const said = call ? `gh pr merge ${call.ok ? "exited 0" : `failed (${firstLine(call.stderr)})`}; ` : "";
  const state = pr?.ok ? pr.state : "unreadable";
  return failed("merge-without-sha", `${said}the pull request reads ${state} with no merge commit`, { data });
}

// Finishes a merge already recorded, by nightqueue or by the operator: re-read only for a missing merge commit, never merge again.
async function confirmRecordedMerge(ctx, deps) {
  const mergedBy = ctx.data.mergedBy ?? "nightqueue";
  if (ctx.data.mergeSha) return await madeMergeResult(ctx, deps, { pr: { mergeSha: ctx.data.mergeSha, mergedAt: ctx.data.mergedAt }, mergedBy });
  const pr = await readPr(ctx, deps);
  if (pr?.ok && pr.state === "MERGED" && pr.mergeSha) return await madeMergeResult(ctx, deps, { pr, mergedBy });
  return mergeWithoutSha({ pr, call: null });
}

// Tells whether the branch of the pull request carries GitHub workflows; a branch git cannot list counts as having them, so the close waits.
async function hasWorkflows(ctx, deps, branch) {
  if (!branch) return true;
  const listed = await git(ctx, deps, ["ls-tree", "--name-only", `origin/${branch}`, ".github/workflows/"]);
  if (!listed.ok) return true;
  return linesOf(listed.stdout).some((line) => /\.ya?ml$/.test(line));
}

// The merge-time note of a head with no CI and no test script: nothing can verify it, so only --force merges it.
function unverifiableHeadNote(ctx) {
  return `the package.json of the pull request has no scripts.test, so this head cannot be verified; run queue close ${jobRef(ctx.jobId)} --force to merge it unverified`;
}

// Runs the suite on a head no CI verifies, rebased in the throwaway worktree, and takes the head it verified and pushed.
async function suiteVerdict(ctx, deps, { pr, lead, data }) {
  const prefix = `${lead ? `${lead}; ` : ""}no CI on ${sha7(pr.headRefOid)}: `;
  const suite = await rebaseInThrowaway(ctx, deps, { head: pr.headRefName, base: pr.baseRefName });
  if (suite.reason === "no-test-script") return { problem: { ...suite, note: `${prefix}${unverifiableHeadNote(ctx)}` } };
  if (suite.status !== "done") return { problem: { ...suite, note: `${prefix}${suite.note}` } };
  if (!suite.data?.verifiedSha) return { problem: failed("head-unreadable", `${prefix}the suite ran but the head it verified is unknown; run again`, { data: suite.data }) };
  return { head: suite.data.verifiedSha, note: `${prefix}${suite.note}`, data: { ...data, ...suite.data }, slow: true, pushed: true };
}

// Verifies a head no check reports on: waits for CI when the branch has workflows, and runs the suite when there is no CI or it never reports.
async function noCiVerdict(ctx, deps, { pr, lead, data }) {
  const head = pr.headRefOid;
  if (await hasWorkflows(ctx, deps, pr.headRefName)) {
    const waiting = { status: "done", note: lead ?? `CI waited on ${sha7(head)}`, data: { ...data, headSha: head } };
    const waited = await waitForChecks(ctx, deps, waiting, `no CI reports on ${sha7(head)} yet`, { emptyWindowMs: CI_EMPTY_WINDOW_MS });
    if (waited.status !== "done") return { problem: { ...waited, reopen: MERGE_REOPEN } };
    if (waited.headChanged) return { changed: true };
    if (!waited.noCi) return { head, note: waited.note, data: waited.data, slow: true };
  }
  return await suiteVerdict(ctx, deps, { pr, lead, data });
}

// The head the merge step may merge: one this close's suite verified, one CI reports green on, any head under --force, or one verified now.
async function mergeHeadVerdict(ctx, deps, pr, known) {
  const head = pr.headRefOid;
  const moved = movedHead(ctx, pr);
  if (ctx.force) return { head, note: moved ? `${moved.lead}; taken with --force` : null, data: moved?.data ?? {} };
  if (head === known.verifiedSha || head === known.ciGreenSha) return { head, note: null, data: {} };
  const ci = await ciVerdict(ctx, deps, { head, lead: moved?.lead ?? null, data: moved?.data ?? {}, reopen: MERGE_REOPEN });
  if (ci.problem || ci.changed) return ci;
  if (ci.empty) return await noCiVerdict(ctx, deps, { pr, lead: ci.note, data: ci.data });
  return { head, note: ci.note, data: moved || ci.slow ? ci.data : {}, slow: ci.slow === true };
}

// A merge step result carrying the verification data gathered so far, with the note of the head it went on with put first.
function withMergeData(result, merge, lead = null) {
  const note = lead ? `${lead}; ${result.note}` : result.note;
  return { ...result, note, data: { ...merge.data, ...(result.data ?? {}) } };
}

// The result of a read that ends the merge step before any verdict: unreadable, merged or closed; null for an open pull request.
async function endedPrResult(ctx, deps, pr) {
  if (!pr?.ok) return unreadablePr(ctx, pr);
  if (pr.state === "MERGED") return await madeMergeResult(ctx, deps, { pr, mergedBy: mergedByOf(ctx) });
  if (pr.state === "CLOSED") return failed("pr-closed", `PR #${pr.number} was closed without being merged`);
  return null;
}

// Tells whether a read shows the pull request still open at the given head.
function openAt(pr, head) {
  return Boolean(pr?.ok) && pr.state === "OPEN" && pr.headRefOid === head;
}

// Folds an accepted verdict's data into what the merge step has verified.
function recordVerdict(merge, verdict) {
  Object.assign(merge.data, verdict.data ?? {});
  merge.known = { verifiedSha: merge.data.verifiedSha ?? merge.known.verifiedSha, ciGreenSha: merge.data.ciGreenSha ?? merge.known.ciGreenSha };
}

// Merges the accepted head, pinned to it, and proves the merge by re-reading its commit; a failed call on a head that moved answers the new read.
async function callMerge(ctx, deps, { verdict, merge }) {
  if (ctx.signal?.aborted) return { result: withMergeData(abortedBefore("merge"), merge, verdict.note) };
  const call = await deps.gh.prMerge(ctx.prUrl, { matchHeadCommit: verdict.head, ...bounded(ctx, MERGE_TIMEOUT_MS) });
  const reread = await rereadMerge(ctx, deps);
  if (reread?.mergeSha && reread.state === "MERGED") {
    return { result: withMergeData(await mergedResult(ctx, deps, { pr: reread, note: "squash-merged", mergedBy: "nightqueue" }), merge, verdict.note) };
  }
  if (!call.ok && reread?.ok && reread.state === "OPEN" && reread.headRefOid !== verdict.head) return { next: reread };
  return { result: withMergeData(mergeWithoutSha({ pr: reread, call }), merge, verdict.note) };
}

// One pass of the merge over the head GitHub shows: its verdict, the conflict check and the merge call; answers the result or the read of a changed head.
async function mergeTurn(ctx, deps, { pr, merge }) {
  const verdict = await mergeHeadVerdict(ctx, deps, pr, merge.known);
  if (verdict.problem) return { result: withMergeData(verdict.problem, merge) };
  if (verdict.changed) return { next: await readPr(ctx, deps) };
  recordVerdict(merge, verdict);
  if (CONFLICTED_STATES.has(pr.mergeable) || CONFLICTED_STATES.has(pr.mergeStateStatus)) {
    return { result: withMergeData(failed("not-mergeable", "the pull request conflicts with its base again; the next run rebases it", { reopen: ["conflict"] }), merge, verdict.note) };
  }
  if (verdict.slow) {
    const reread = verdict.pushed ? await readPushedPr(ctx, deps, verdict.head) : await readPr(ctx, deps);
    if (!openAt(reread, verdict.head) && !pushLag(reread, verdict)) return { next: reread };
  }
  return await callMerge(ctx, deps, { verdict, merge });
}

// Tells whether a read after the close's own push still shows the head it replaced: GitHub lags, the head did not change; the pinned merge stays safe.
function pushLag(pr, verdict) {
  return Boolean(verdict.pushed) && Boolean(pr?.ok) && pr.state === "OPEN" && pr.headRefOid === verdict.data?.headShaBefore;
}

// The stop of a head that kept changing during the close: nothing merged, and the last head read never recorded.
function headKeptMoving(pr, merge) {
  const note = `the head changed ${MAX_LOOPBACKS} times during the close; nothing was merged (last read ${sha7(pr.headRefOid)})`;
  return withMergeData(failed("head-moved", note, { reopen: MERGE_REOPEN }), merge);
}

// Squash-merges the pull request at a head this close or CI verified, pinned to it, and proves the merge by re-reading its merge commit.
// A head that changes during the step is judged again, at most MAX_LOOPBACKS times; then the step stops with head-moved.
async function mergeStep({ ctx, deps }) {
  if (ctx.data.merged) return await confirmRecordedMerge(ctx, deps);
  const merge = { known: { verifiedSha: ctx.data.verifiedSha ?? null, ciGreenSha: ctx.data.ciGreenSha ?? null }, data: {} };
  let pr = await readHeadPr(ctx, deps);
  for (let changes = 0; ; changes += 1) {
    const ended = await endedPrResult(ctx, deps, pr);
    if (ended) return withMergeData(ended, merge);
    if (changes > MAX_LOOPBACKS) return headKeptMoving(pr, merge);
    const turn = await mergeTurn(ctx, deps, { pr, merge });
    if (turn.result) return turn.result;
    pr = turn.next;
  }
}

// Prepares the close: the merge must be recorded with its commit, and the notice line is written from it.
async function settleStep({ ctx }) {
  if (!ctx.data.merged || !ctx.data.mergeSha) return failed("not-merged", "the merge of the pull request is not recorded with its merge commit");
  const noticeLine = closedLine({ number: ctx.prNumber, sha: ctx.data.mergeSha, at: ctx.data.mergedAt });
  return { status: "done", note: `closing the job: ${noticeLine}`, data: { noticeLine } };
}

export const CLOSE_STEPS = [
  { name: "preflight", run: preflightStep },
  { name: "conflict", run: conflictStep },
  { name: "merge", run: mergeStep },
  { name: "settle", run: settleStep },
  { name: "origin", run: originStep, forget: forgetOrigin, required: false },
  { name: "log", run: logStep, forget: forgetLogged, required: false },
];

// Tells whether a step runs after the job is closed and can never stop or reopen the close.
function isPostCloseStep(step) {
  return step?.required === false;
}

const CLOSE_STEP_SET = new Set(CLOSE_STEPS.filter((step) => !isPostCloseStep(step)).map((step) => step.name));
const POST_CLOSE_NAMES = CLOSE_STEPS.filter(isPostCloseStep).map((step) => step.name);

// The post-close steps a `--steps` re-run names, deduplicated and in close order; any other name is refused with the valid ones.
export function postCloseStepsNamed(names) {
  const list = Array.isArray(names) ? names : [];
  const unknown = list.find((name) => !POST_CLOSE_NAMES.includes(name));
  if (!list.length || unknown !== undefined) {
    const named = unknown === undefined ? "no step" : `\`${String(unknown)}\``;
    throw new UserError(`${named} is not a post-close step; valid steps: ${POST_CLOSE_NAMES.join(", ")}`);
  }
  return CLOSE_STEPS.filter((step) => list.includes(step.name));
}

export { conflictStep, mergeStep, preflightStep, settleStep };

// The registered checkout of a job's project, or null when it cannot be resolved (the preflight step reports it).
function resolveCheckout(job, env) {
  try {
    return checkoutOfJob(job, env);
  } catch {
    return null;
  }
}

// The number of a pull request, from the close's recorded data or its URL, or null.
function prNumberOf(prUrl, data) {
  if (Number.isInteger(data.prNumber)) return data.prNumber;
  const match = /\/pull\/(\d+)/.exec(String(prUrl ?? ""));
  return match ? Number(match[1]) : null;
}

// The checklist a close attempt starts from: the stored one, with its steps and data guaranteed to be objects.
function startingChecklist(job) {
  const stored = parseCloseChecklist(job?.close) ?? {};
  const steps = stored.steps && typeof stored.steps === "object" && !Array.isArray(stored.steps) ? stored.steps : {};
  const data = stored.data && typeof stored.data === "object" && !Array.isArray(stored.data) ? stored.data : {};
  return { attempts: 1, ...stored, steps, data };
}

// Requires a positive, finite hard timeout, so a close can never run without a deadline.
function requireTimeoutS(timeoutS) {
  if (Number.isFinite(timeoutS) && timeoutS > 0) return timeoutS;
  throw new UserError(`invalid close timeout \`${String(timeoutS)}\`; expected a positive number of seconds`);
}

// Arms the hard deadline of one attempt: an abort at the deadline or on the caller's signal, remembering which came first.
function armDeadline({ timeoutS, signal, now }) {
  const controller = new AbortController();
  const deadlineMs = now() + timeoutS * 1000;
  const state = { reason: null };
  const abort = (reason) => {
    if (state.reason) return;
    state.reason = reason;
    controller.abort(new Error(reason));
  };
  const timer = setTimeout(() => abort("timeout"), Math.max(0, deadlineMs - now()));
  const onCallerAbort = () => abort("interrupted");
  if (signal?.aborted) onCallerAbort();
  else signal?.addEventListener?.("abort", onCallerAbort, { once: true });
  const disarm = () => {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", onCallerAbort);
  };
  return { controller, deadlineMs, state, disarm };
}

// The context every step reads: the job, its pull request, the deadline and the data recorded by earlier steps.
function buildContext(run, stepName) {
  const { job, checkout, checklist, deadline, now, force } = run;
  return {
    progress: (note) => reportProgress(run, stepName, note),
    jobId: job.id,
    prUrl: job.pr_url,
    prNumber: prNumberOf(job.pr_url, checklist.data),
    project: job.project,
    branch: job.branch ?? null,
    slug: job.slug ?? null,
    type: job.type ?? null,
    force: force === true,
    checkout,
    deadlineMs: deadline.deadlineMs,
    remainingMs: () => Math.max(0, deadline.deadlineMs - now()),
    signal: deadline.controller.signal,
    warning: checklist.data.fetchWarning ?? null,
    data: checklist.data,
  };
}

// Tells whether a step answered the step contract.
function isStepResult(result, statuses = STEP_STATUSES) {
  return Boolean(result) && typeof result === "object" && statuses.has(result.status);
}

// The failure of a result that reopens something other than a close step, keeping its data; null when its reopen is valid.
function reopenProblem(stepName, result) {
  if (result.reopen === undefined) return null;
  const list = Array.isArray(result.reopen) ? result.reopen : null;
  const badIndex = list ? list.findIndex((name) => typeof name !== "string" || !CLOSE_STEP_SET.has(name)) : -1;
  if (list && badIndex < 0) return null;
  const bad = list ? list[badIndex] : result.reopen;
  const answered = result.note ? ` (it answered: ${result.note})` : "";
  return { status: "failed", reason: "reopen-unknown", note: `the ${stepName} step reopened ${JSON.stringify(bad)}, which is not a close step${answered}`, data: result.data };
}

// Runs one step raced against the deadline; a throw, an invalid answer or the deadline becomes a failed result, never an exception.
async function runStepRaced(step, { ctx, deps, deadline, statuses = STEP_STATUSES }) {
  if (deadline.state.reason) return abortedResult(deadline.state.reason);
  let onAbort = null;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(ABORTED);
    deadline.controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => step.run({ ctx, deps })), aborted]);
    if (result === ABORTED) return abortedResult(deadline.state.reason);
    if (!isStepResult(result, statuses)) return { status: "failed", reason: "step-crashed", note: `the ${step.name} step answered an invalid result` };
    return reopenProblem(step.name, result) ?? result;
  } catch (err) {
    if (deadline.state.reason) return abortedResult(deadline.state.reason);
    return { status: "failed", reason: "step-crashed", note: err?.message ?? String(err) };
  } finally {
    deadline.controller.signal.removeEventListener("abort", onAbort);
  }
}

// The failed result of a step cut by the deadline or by the caller.
function abortedResult(reason) {
  const note = reason === "timeout" ? "the close passed its hard timeout" : "the close was interrupted";
  return { status: "failed", reason, note };
}

// The note a step leaves in the checklist: its reason first when it failed, the fetch warning first when there is one.
function checklistNote(result, warning) {
  const base = String(result.note ?? "");
  const note = result.status === "failed" ? `${result.reason ?? "failed"} - ${base}`.replace(/ - $/, "") : base;
  return warning ? `${warning} | ${note}` : note;
}

// Folds one step result into the checklist: its entry, its data and the steps it reopens.
function applyResult(checklist, { name, result, at }) {
  if (result.data && typeof result.data === "object") Object.assign(checklist.data, result.data);
  const warning = checklist.data.fetchWarning ?? null;
  const note = checklistNote(result, warning);
  checklist.steps[name] = { status: result.status, note, at };
  for (const reopened of Array.isArray(result.reopen) ? result.reopen : []) markReopened(checklist, reopened);
  return note;
}

// Marks a step's entry reopened, keeping its note and time; a step with no entry has nothing to reopen.
function markReopened(checklist, name) {
  const entry = checklist.steps[name];
  if (entry) checklist.steps[name] = { ...entry, status: "reopened" };
}

// The outcome of an attempt, in the shape every caller reads.
function outcomeOf(status, { step = null, reason = null, checklist, worktree = null, accepted = [] }) {
  return { status, step, reason, mergeSha: checklist.data.mergeSha ?? null, worktree, ...(accepted.length ? { accepted } : {}) };
}

// Stops the close as failed at a step, releasing the lease; a lease that is not this worker's any more answers `lost`.
async function stopClose(run, { step, reason }) {
  run.checklist.failed = { step, reason };
  run.checklist.finishedAt = new Date(run.now()).toISOString();
  const released = await run.store.jobs.failClose(run.job.id, { worker: run.worker, close: run.checklist });
  return outcomeOf(released ? "failed" : "lost", { step, reason, checklist: run.checklist });
}

// Cancels the job whose pull request a step read closed without merge, releasing the lease and then its worktree; a lease that is not this worker's any more answers `lost`.
async function cancelClosedPr(run, step) {
  run.checklist.failed = { step, reason: "pr-closed" };
  run.checklist.finishedAt = new Date(run.now()).toISOString();
  const job = await run.store.jobs.cancelOnClosedPr(run.job.id, { worker: run.worker, close: run.checklist, note: PR_CLOSED_NOTE });
  if (!job) return outcomeOf("lost", { step, reason: "pr-closed", checklist: run.checklist });
  const worktree = await releaseJobWorktree({ job, env: run.env });
  return outcomeOf("cancelled", { step, reason: "pr-closed", checklist: run.checklist, worktree });
}

// The lease a checklist write renews: what is left of the deadline plus the slack, in whole seconds.
function renewalSeconds(run) {
  return Math.ceil(Math.max(0, run.deadline.deadlineMs - run.now()) / 1000) + CLOSE_LEASE_SLACK_S;
}

// Writes the checklist after a step and renews the lease; answers false when the lease is not this worker's any more.
async function recordStep(run) {
  return await run.store.jobs.recordCloseStep(run.job.id, { worker: run.worker, close: run.checklist, leaseS: renewalSeconds(run) });
}

// Records a running step's progress line on the checklist, renewing the lease, and shows it when it changed; a failed write never stops the step.
async function reportProgress(run, name, note) {
  const changed = run.checklist.steps[name]?.note !== note;
  run.checklist.steps[name] = { status: "running", note, at: new Date(run.now()).toISOString() };
  if (changed) run.onStep?.({ name, status: "running", note, earlier: false });
  try {
    await recordStep(run);
  } catch {
    return;
  }
}

// Performs the terminal write of a settled close: the job becomes `closed`, then where its worktree went is noted.
async function settleRun(run) {
  const { store, job, worker, checklist, deps } = run;
  checklist.finishedAt = new Date(run.now()).toISOString();
  const settleClosed = typeof deps.settleClosed === "function" ? deps.settleClosed : settleClosedJob;
  let closed = null;
  let refusal = null;
  try {
    closed = await settleClosed({ store, id: job.id, worker, close: checklist, noticeLine: checklist.data.noticeLine, env: run.env });
  } catch (err) {
    refusal = err?.message ?? String(err);
  }
  if (!closed?.job) return await refuseSettle(run, refusal);
  if (closed.worktree) await store.jobs.noteCloseWorktree(job.id, { worktree: closed.worktree });
  return outcomeOf("closed", { step: "settle", checklist, worktree: closed.worktree ?? null, accepted: closed.job.accepted_decisions ?? [] });
}

// Records a close the store refused as a settle failure, naming the job's status as it is now.
async function refuseSettle(run, refusal) {
  const current = await run.store.jobs.getJob(run.job.id);
  const detail = refusal ?? `the job is \`${current?.status ?? "unknown"}\` and its close lease is not this process's`;
  const at = new Date(run.now()).toISOString();
  applyResult(run.checklist, { name: "settle", result: { status: "failed", reason: "close-refused", note: detail }, at });
  return await stopClose(run, { step: "settle", reason: "close-refused" });
}

// Runs one step of the loop and answers the outcome that ends the attempt, or null to go on to the next step.
async function advance(run, step, isLast) {
  const entry = run.checklist.steps[step.name];
  if (entry?.status === "done" && !isLast) {
    run.onStep?.({ name: step.name, status: "done", note: entry.note, earlier: !run.ranThisAttempt?.has(step.name) });
    return null;
  }
  run.ranThisAttempt?.add(step.name);
  const ctx = buildContext(run, step.name);
  const result = await runStepRaced(step, { ctx, deps: run.deps, deadline: run.deadline });
  const note = applyResult(run.checklist, { name: step.name, result, at: new Date(run.now()).toISOString() });
  run.onStep?.({ name: step.name, status: result.status, note, earlier: false });
  if (result.status === "failed" && result.reason === "pr-closed") return await cancelClosedPr(run, step.name);
  if (result.status === "failed") return await stopClose(run, { step: step.name, reason: result.reason ?? "failed" });
  if (isLast && result.status === "done") return await settleRun(run);
  if (isLast) return await stopClose(run, { step: step.name, reason: "not-settled" });
  return await recordOrStop(run, step.name);
}

// Writes the checklist after a non-terminal step; a lease taken over answers `lost`, a failed write stops the close.
async function recordOrStop(run, name) {
  try {
    if (await recordStep(run)) return null;
    return outcomeOf("lost", { step: name, reason: "lease-lost", checklist: run.checklist });
  } catch (err) {
    run.checklist.steps[name].note += ` | the checklist could not be written: ${err?.message ?? String(err)}`;
    return await stopClose(run, { step: name, reason: "checklist-write-failed" });
  }
}

// The index of the earliest step before `index` a result reopened, or -1.
function reopenedBefore(run, steps, index) {
  return steps.findIndex((step, position) => position < index && run.checklist.steps[step.name]?.status === "reopened");
}

// Walks the steps in order, looping back to an earlier step a successful result reopened, at most MAX_LOOPBACKS times.
async function walkSteps(run, steps) {
  run.ranThisAttempt = new Set();
  let index = 0;
  let loopbacks = 0;
  while (index < steps.length) {
    const outcome = await advance(run, steps[index], index === steps.length - 1);
    if (outcome) return outcome;
    const back = reopenedBefore(run, steps, index);
    if (back < 0) {
      index += 1;
      continue;
    }
    if (loopbacks === MAX_LOOPBACKS) return await stopClose(run, { step: steps[index].name, reason: "reopen-loop" });
    loopbacks += 1;
    index = back;
  }
  return await stopClose(run, { step: "settle", reason: "not-settled" });
}

// The project facts the post-close steps read: its org and its integrations, null when it has none or they cannot be read.
async function postCloseFacts(store, job) {
  try {
    const [project, integrations] = await Promise.all([store.projects.byId(job.project_id), store.projects.integrations(job.project_id)]);
    return integrations && Object.keys(integrations).length ? { orgId: project?.org_id ?? null, integrations } : null;
  } catch {
    return null;
  }
}

// The origin of a job, from a parsed view or the raw column.
function originOf(job) {
  const origin = job?.origin;
  return origin && typeof origin === "object" ? origin : parseOriginColumn(origin);
}

// The context a post-close step reads: the close's own, plus the job's origin, the project's integrations and the merge.
function postCloseContext(run, stepName) {
  const { job, checklist, facts } = run;
  return {
    ...buildContext(run, stepName),
    progress: (note) => run.onStep?.({ name: stepName, status: "running", note, earlier: false }),
    env: run.env,
    jobRef: jobRef(job.id),
    origin: originOf(job),
    integrations: facts.integrations,
    orgId: facts.orgId,
    title: checklist.data.title ?? null,
    mergeSha: checklist.data.mergeSha ?? null,
    mergedAt: checklist.data.mergedAt ?? null,
  };
}

const POST_RESULT_STATUSES = new Set(["done", "skipped", "warning", "failed"]);

// A post-close step result as recorded: `done`, `skipped` or `warning`; a failure, a throw or the budget becomes a warning.
function postCloseResult(name, result) {
  if (result.status !== "failed") return { status: result.status, note: String(result.note ?? ""), data: result.data, notice: result.notice === true };
  if (result.reason === "timeout") return { status: "warning", note: `passed the post-close budget of ${POST_CLOSE_TIMEOUT_S}s` };
  if (result.reason === "interrupted") return { status: "warning", note: "interrupted" };
  if (result.reason === "step-crashed") return { status: "warning", note: `the ${name} step failed` };
  return { status: "warning", note: String(result.note ?? result.reason ?? "failed"), data: result.data };
}

// The notice line a post-close result appends: a warning, a skip worth telling, or a success after one of those.
function postNoticeLine(name, result, previous) {
  const noticed = result.status === "warning" || (result.status === "skipped" && result.notice) || (result.status === "done" && previous?.noticed === true);
  return noticed ? postCloseLine(name, result) : null;
}

// Runs one post-close step and records it with its notice line; answers false when the post-close lease was lost.
async function runPostStep(run, step) {
  if (run.again) step.forget?.(run.checklist.data, run.facts.integrations);
  const previous = run.checklist.steps[step.name];
  const ctx = postCloseContext(run, step.name);
  const result = postCloseResult(step.name, await runStepRaced(step, { ctx, deps: run.deps, deadline: run.deadline, statuses: POST_RESULT_STATUSES }));
  if (result.data && typeof result.data === "object") Object.assign(run.checklist.data, result.data);
  const noticeLine = postNoticeLine(step.name, result, previous);
  const noticed = noticeLine !== null && result.status !== "done";
  run.checklist.steps[step.name] = { status: result.status, note: result.note, at: new Date(run.now()).toISOString(), ...(noticed ? { noticed: true } : {}) };
  run.onStep?.({ name: step.name, status: result.status, note: result.note, earlier: false });
  run.results.push({ name: step.name, status: result.status, note: result.note });
  return await recordPostStep(run, step.name, noticeLine);
}

// Writes the checklist after a post-close step; a failed write is reported as a line, never as a change of the closed job.
async function recordPostStep(run, name, noticeLine) {
  try {
    if (await run.store.jobs.recordPostCloseStep(run.job.id, { worker: run.worker, close: run.checklist, noticeLine })) return true;
    run.onStep?.({ name, status: "warning", note: "post-close lease lost; the remaining steps were not run", earlier: false });
  } catch {
    run.onStep?.({ name, status: "warning", note: "the post-close checklist could not be written", earlier: false });
  }
  return false;
}

// Releases the post-close lease quietly: a lease left behind expires on its own.
async function releasePostLease(run) {
  try {
    await run.store.jobs.releasePostClose(run.job.id, { worker: run.worker });
  } catch {
    return;
  }
}

// Runs the post-close phase, turning any throw into a `failed` answer so a closed job's close never rejects after settle.
async function runPostClose(base, steps, signal) {
  try {
    return await runPostClosePhase(base, steps, signal);
  } catch {
    const note = "post-close steps not run: the store could not be read or written";
    base.onStep?.({ name: "post-close", status: "warning", note, earlier: false });
    return { status: "failed", note, steps: [] };
  }
}

// Runs the post-close steps of a closed job under their own lease and budget; nothing here ever changes the job's status.
async function runPostClosePhase(base, steps, signal) {
  const facts = await postCloseFacts(base.store, base.job);
  if (!facts) return { status: "nothing", note: "the project has no integrations", steps: [] };
  const job = await base.store.jobs.acquirePostClose(base.job.id, { worker: base.worker, leaseS: POST_CLOSE_TIMEOUT_S + CLOSE_LEASE_SLACK_S });
  if (!job) {
    const note = "post-close steps skipped: held by another process";
    base.onStep?.({ name: "post-close", status: "skipped", note, earlier: false });
    return { status: "refused", note, steps: [] };
  }
  const deadline = armDeadline({ timeoutS: POST_CLOSE_TIMEOUT_S, signal, now: base.now });
  const run = { ...base, job, facts, deadline, checklist: startingChecklist(job), results: [] };
  try {
    for (const step of steps) if (!(await runPostStep(run, step))) break;
    return { status: "ran", note: null, steps: run.results };
  } finally {
    deadline.disarm();
    await releasePostLease(run);
  }
}

// Runs one attempt of a close over its steps, resuming from the stored checklist, then its post-close steps once the job is closed; a step failure is an outcome, never an exception.
export async function runClosePipeline({ store, job, worker, env = process.env, deps = null, timeoutS, signal = null, now = Date.now, onStep = null, checkout, force = false, steps = CLOSE_STEPS, again = false }) {
  if (!job) throw new UserError("runClosePipeline needs the job it closes");
  const pre = steps.filter((step) => !isPostCloseStep(step));
  const post = steps.filter(isPostCloseStep);
  const base = { store, job, worker, env, deps: deps ?? defaultCloseDeps(env), now, onStep, force, again, checkout: checkout ?? resolveCheckout(job, env) };
  if (!pre.length && post.length) return await runPostClose(base, post, signal);
  const deadline = armDeadline({ timeoutS: requireTimeoutS(timeoutS), signal, now });
  const run = { ...base, checklist: startingChecklist(job), deadline };
  let outcome;
  try {
    outcome = await walkSteps(run, pre);
  } finally {
    deadline.disarm();
  }
  if (outcome.status !== "closed" || !post.length) return outcome;
  const postClose = await runPostClose(base, post, signal);
  return postClose.status === "nothing" ? outcome : { ...outcome, postClose };
}

// The settle step's write: closes the job in one store write and only then releases its worktree; a refused settle touches nothing on disk.
export async function settleClosedJob({ store, id, worker, close, noticeLine, env = process.env, killImpl } = {}) {
  const job = await store.jobs.settleClose(id, { worker, close, noticeLine });
  if (!job) return { job: null, worktree: null };
  const worktree = await releaseJobWorktree({ job, env, killImpl });
  return { job, worktree };
}

// The entry a close reports for the worktree of one closed job, or null when the job had none.
export function worktreeEntry(job, worktree) {
  return worktree ? { id: job.id, ...worktree } : null;
}

// The text line a close prints for the worktree of a job it closed.
export function worktreeLine(entry) {
  return entry.status === "removed" ? `worktree removed: ${entry.path}` : `worktree kept: ${entry.path} - ${entry.reason}`;
}
