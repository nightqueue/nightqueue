import { UserError } from "../config/errors.mjs";
import { projectByName } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { sameBranch } from "./branch-name.mjs";
import { defaultCloseDeps } from "./close-deps.mjs";
import { closedLine, parseCloseChecklist } from "./close-view.mjs";
import { releaseJobWorktree } from "./worktree.mjs";

export const CLOSE_LEASE_SLACK_S = 60;
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
const NAMES_SHOWN = 10;
const SUITE_LINES_SHOWN = 20;
const CONFLICTED_STATES = new Set(["CONFLICTING", "DIRTY"]);

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

// Reads the pull request of the close as GitHub has it now.
async function readPr(ctx, deps) {
  return await deps.gh.prDetail(ctx.prUrl, bounded(ctx, GH_TIMEOUT_MS));
}

// The failure of a pull request gh could not read.
function unreadablePr(ctx, pr) {
  return failed("pr-unreadable", `gh could not read ${ctx.prUrl} (${pr?.error ?? "no answer"})`);
}

// The data a close keeps about its pull request from one read.
function prData(pr) {
  return { prNumber: pr.number, title: pr.title, headBranch: pr.headRefName, baseBranch: pr.baseRefName, headSha: pr.headRefOid };
}

// The data that records a merged pull request, as GitHub reports it, and who merged it: `nightshift` or the `operator` outside a close.
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

// Tells whether the checks of the pull request stop the close, and what they said; with --force they never stop it and the note names them.
async function checksVerdict(ctx, deps) {
  const checks = await deps.gh.prChecks(ctx.prUrl, bounded(ctx, GH_TIMEOUT_MS));
  const reading = checksReading(ctx, checks);
  return reading.problem && ctx.force ? { note: ignoredChecksNote(checks) } : reading;
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

// Tells whether local changes in the canonical checkout would stop the pull after the merge; nightshift never stashes them.
async function checkoutVerdict(ctx, deps, base) {
  const status = await git(ctx, deps, ["status", "--porcelain", "-z"]);
  if (!status.ok) return { problem: failed("checkout-dirty", `git status failed in ${ctx.checkout} (${firstLine(status.stderr)})`) };
  const dirty = porcelainPaths(status.stdout);
  if (!dirty.length) return { note: "canonical checkout clean" };
  const incoming = await incomingFiles(ctx, deps, base);
  if (!incoming) return { problem: failed("checkout-dirty", `${dirty.length} local changes in ${ctx.checkout} and nightshift cannot tell which files the pull would bring`) };
  const touched = dirty.filter((path) => incoming.has(path));
  if (touched.length) {
    return { problem: failed("checkout-dirty", `local changes in ${ctx.checkout} the pull would touch: ${namesNote(touched)}; commit or stash them yourself; nightshift never stashes`) };
  }
  return { note: `${dirty.length} local changes the pull does not touch` };
}

// Tells whether the pull request is on the job's own branch (or its published alias), and what the check leaves in the note.
function attributionVerdict(ctx, pr) {
  const branch = typeof ctx.branch === "string" ? ctx.branch.trim() : "";
  if (!branch) return { note: "branch not recorded; attribution not checked" };
  if (sameBranch(pr.headRefName, branch, { type: ctx.type, slug: ctx.slug })) return { note: null };
  const head = pr.headRefName || "unknown";
  const note = `PR #${pr.number} is on branch \`${head}\`, but job \`${ctx.jobId}\` ran on \`${branch}\`; it is not this job's pull request. Fix the job's pr_url before closing it`;
  return { problem: failed("pr-not-the-job-branch", note) };
}

// A step note with the attribution note appended when there is one.
function withAttributionNote(note, attribution) {
  return attribution.note ? `${note}; ${attribution.note}` : note;
}

// Checks, before anything is changed, that the pull request is the job's own, open, green and pullable into the canonical checkout.
async function preflightStep({ ctx, deps }) {
  if (!ctx.checkout || !deps.fs.exists(ctx.checkout)) return failed("checkout-missing", `the checkout of project \`${ctx.project}\` is missing: ${ctx.checkout ?? "not registered"}`);
  const fetched = await git(ctx, deps, ["fetch", "origin"]);
  const data = { fetchWarning: fetched.ok ? null : `WARNING: git fetch origin failed (${firstLine(fetched.stderr)})` };
  const pr = await readPr(ctx, deps);
  if (!pr?.ok) return { ...unreadablePr(ctx, pr), data };
  Object.assign(data, prData(pr));
  const attribution = attributionVerdict(ctx, pr);
  if (attribution.problem) return { ...attribution.problem, data };
  if (pr.state === "CLOSED") return failed("pr-closed", `PR #${pr.number} was closed without being merged`, { data });
  if (pr.state === "MERGED") return { status: "done", note: withAttributionNote(`PR #${pr.number} already merged as ${sha7(pr.mergeSha)}`, attribution), data: { ...data, ...mergedData(pr, mergedByOf(ctx)) } };
  const checks = await checksVerdict(ctx, deps);
  if (checks.problem) return { ...checks.problem, data };
  const checkout = await checkoutVerdict(ctx, deps, pr.baseRefName);
  if (checkout.problem) return { ...checkout.problem, data };
  return { status: "done", note: withAttributionNote(`PR #${pr.number} open; ${checks.note}; ${checkout.note}`, attribution), data };
}

// Reads the pull request's mergeability, reading once more after a pause when GitHub has not computed it yet.
async function readMergeability(ctx, deps) {
  const pr = await readPr(ctx, deps);
  if (!pr?.ok || pr.state !== "OPEN" || pr.mergeable !== "UNKNOWN") return pr;
  await pause(ctx, deps, UNKNOWN_RETRY_MS);
  return await readPr(ctx, deps);
}

// Rebases the pull request when GitHub says it conflicts with its base; otherwise there is nothing to do here.
async function conflictStep({ ctx, deps }) {
  if (ctx.data.merged) return { status: "skipped", note: "the pull request is already merged" };
  const pr = await readMergeability(ctx, deps);
  if (!pr?.ok) return unreadablePr(ctx, pr);
  if (pr.state === "MERGED") return { status: "skipped", note: "the pull request is already merged", data: mergedData(pr, mergedByOf(ctx)) };
  if (pr.state === "CLOSED") return failed("pr-closed", `PR #${pr.number} was closed without being merged`);
  if (pr.mergeable === "MERGEABLE" || pr.mergeStateStatus === "CLEAN") return { status: "skipped", note: `mergeable (${pr.mergeStateStatus ?? pr.mergeable})` };
  if (pr.mergeable === "UNKNOWN") return failed("mergeability-unknown", "GitHub has not computed whether the pull request merges; run again in a minute");
  if (CONFLICTED_STATES.has(pr.mergeable) || CONFLICTED_STATES.has(pr.mergeStateStatus)) return await rebaseInThrowaway(ctx, deps, { head: pr.headRefName, base: pr.baseRefName });
  return { status: "skipped", note: `mergeable is ${pr.mergeable ?? "unknown"} (${pr.mergeStateStatus ?? "no state"}); the merge step decides` };
}

// Creates the throwaway detached worktree of the pull request's head, or answers why it could not.
async function addThrowaway(ctx, deps, head) {
  let dir = null;
  try {
    dir = deps.fs.makeTempDir(`nightshift-close-${ctx.jobId}-`);
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

// Rebases in the throwaway worktree, runs the suite unless --force skips it, and pushes only when nothing stopped it.
async function rebaseTestAndPush(ctx, deps, work) {
  const data = { headShaBefore: work.headShaBefore };
  deps.fs.linkNodeModules(ctx.checkout, work.dir);
  const rebased = await git(ctx, deps, ["rebase", `origin/${work.base}`], { cwd: work.dir });
  if (!rebased.ok) return await stopConflictedRebase(ctx, deps, { ...work, data, stderr: rebased.stderr });
  const markers = await leftoverMarkers(ctx, deps, work);
  if (markers.length) return failed("real-conflict", `conflict markers left in: ${namesNote(markers)}`, { data });
  const suite = ctx.force ? {} : await runSuite(ctx, deps, work.dir);
  if (suite.problem) return { ...suite.problem, data };
  const pushed = await git(ctx, deps, ["push", `--force-with-lease=refs/heads/${work.head}:${work.headShaBefore}`, "origin", `HEAD:refs/heads/${work.head}`], { cwd: work.dir });
  if (!pushed.ok) return failed("push-refused", `git push to ${work.head} was refused (${firstLine(pushed.stderr)})`, { data });
  const after = await git(ctx, deps, ["rev-parse", "HEAD"], { cwd: work.dir });
  data.headSha = after.ok ? after.stdout.trim() : null;
  const suiteNote = ctx.force ? "suite skipped with --force" : "suite green";
  return { status: "done", note: `rebased onto origin/${work.base}, ${suiteNote}, pushed ${sha7(work.headShaBefore)} -> ${sha7(data.headSha)}`, data };
}

// Records the conflict of a stopped rebase, aborts it and answers the failure naming the conflicted files.
async function stopConflictedRebase(ctx, deps, work) {
  const unmerged = await git(ctx, deps, ["diff", "--name-only", "--diff-filter=U"], { cwd: work.dir });
  const files = linesOf(unmerged.stdout);
  const prFiles = await deps.gh.prDiffNames(ctx.prUrl, bounded(ctx, GH_TIMEOUT_MS));
  // Extension seam: a later conflict resolver runs here, while the throwaway worktree is still stopped in the rebase.
  work.data.conflict = { files, prFiles: prFiles?.ok ? prFiles.files : null, base: work.base, head: work.head, headSha: work.headShaBefore };
  await cleanupGit(deps, ["rebase", "--abort"], work.dir);
  if (files.length) return failed("real-conflict", `rebase onto origin/${work.base} conflicts in: ${namesNote(files)}`, { data: work.data });
  return failed("rebase-failed", `git rebase origin/${work.base} failed (${firstLine(work.stderr)})`, { data: work.data });
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

// The result of a merge the step finds already made: skipped as `merged outside a close` when the operator made it, done when nightshift did.
async function madeMergeResult(ctx, deps, { pr, mergedBy }) {
  if (mergedBy !== "operator") return await mergedResult(ctx, deps, { pr, note: "already merged", mergedBy });
  const result = await mergedResult(ctx, deps, { pr, note: "merged outside a close", mergedBy });
  return { ...result, status: "skipped" };
}

// The failure of a merge GitHub does not show with a merge commit; a merged state is still recorded, so no re-run merges again.
function mergeWithoutSha({ pr, call }) {
  const mergedBy = call ? { mergedBy: "nightshift" } : {};
  const data = pr?.ok && pr.state === "MERGED" ? { merged: true, mergedAt: pr.mergedAt ?? null, ...mergedBy } : {};
  const said = call ? `gh pr merge ${call.ok ? "exited 0" : `failed (${firstLine(call.stderr)})`}; ` : "";
  const state = pr?.ok ? pr.state : "unreadable";
  return failed("merge-without-sha", `${said}the pull request reads ${state} with no merge commit`, { data });
}

// Finishes a merge already recorded, by nightshift or by the operator: re-read only for a missing merge commit, never merge again.
async function confirmRecordedMerge(ctx, deps) {
  const mergedBy = ctx.data.mergedBy ?? "nightshift";
  if (ctx.data.mergeSha) return await madeMergeResult(ctx, deps, { pr: { mergeSha: ctx.data.mergeSha, mergedAt: ctx.data.mergedAt }, mergedBy });
  const pr = await readPr(ctx, deps);
  if (pr?.ok && pr.state === "MERGED" && pr.mergeSha) return await madeMergeResult(ctx, deps, { pr, mergedBy });
  return mergeWithoutSha({ pr, call: null });
}

// Squash-merges the pull request at the head the close verified, and proves the merge by re-reading its merge commit.
async function mergeStep({ ctx, deps }) {
  if (ctx.data.merged) return await confirmRecordedMerge(ctx, deps);
  const pr = await readPr(ctx, deps);
  if (!pr?.ok) return unreadablePr(ctx, pr);
  if (pr.state === "MERGED") return await madeMergeResult(ctx, deps, { pr, mergedBy: mergedByOf(ctx) });
  if (pr.state === "CLOSED") return failed("pr-closed", `PR #${pr.number} was closed without being merged`);
  if (CONFLICTED_STATES.has(pr.mergeable) || CONFLICTED_STATES.has(pr.mergeStateStatus)) {
    return failed("not-mergeable", "the pull request conflicts with its base again; the next run rebases it", { reopen: ["conflict"] });
  }
  if (pr.headRefOid !== ctx.data.headSha) {
    return failed("head-moved", `the head moved from ${sha7(ctx.data.headSha)} to ${sha7(pr.headRefOid)}; the next run checks it again`, { reopen: ["preflight", "conflict"] });
  }
  const call = await deps.gh.prMerge(ctx.prUrl, { matchHeadCommit: ctx.data.headSha, ...bounded(ctx, MERGE_TIMEOUT_MS) });
  const reread = await rereadMerge(ctx, deps);
  if (!reread?.mergeSha || reread.state !== "MERGED") return mergeWithoutSha({ pr: reread, call });
  return await mergedResult(ctx, deps, { pr: reread, note: "squash-merged", mergedBy: "nightshift" });
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
];

export { conflictStep, mergeStep, preflightStep, settleStep };

// The registered checkout of a job's project, or null when it cannot be resolved (the preflight step reports it).
function resolveCheckout(job, env) {
  try {
    return projectByName(loadConfig(env), job.project)?.path ?? null;
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
function buildContext({ job, checkout, checklist, deadline, now, force }) {
  return {
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
function isStepResult(result) {
  return Boolean(result) && typeof result === "object" && STEP_STATUSES.has(result.status);
}

// Runs one step raced against the deadline; a throw, an invalid answer or the deadline becomes a failed result, never an exception.
async function runStepRaced(step, { ctx, deps, deadline }) {
  if (deadline.state.reason) return abortedResult(deadline.state.reason);
  let onAbort = null;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(ABORTED);
    deadline.controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => step.run({ ctx, deps })), aborted]);
    if (result === ABORTED) return abortedResult(deadline.state.reason);
    if (!isStepResult(result)) return { status: "failed", reason: "step-crashed", note: `the ${step.name} step answered an invalid result` };
    return result;
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
  for (const reopened of Array.isArray(result.reopen) ? result.reopen : []) delete checklist.steps[reopened];
  return note;
}

// The outcome of an attempt, in the shape every caller reads.
function outcomeOf(status, { step = null, reason = null, checklist, worktree = null }) {
  return { status, step, reason, mergeSha: checklist.data.mergeSha ?? null, worktree };
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
  return outcomeOf("closed", { step: "settle", checklist, worktree: closed.worktree ?? null });
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
    run.onStep?.({ name: step.name, status: "done", note: entry.note, earlier: true });
    return null;
  }
  const ctx = buildContext(run);
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

// Runs one attempt of a close over its steps, resuming from the stored checklist; a step failure is an outcome, never an exception.
export async function runClosePipeline({ store, job, worker, env = process.env, deps = null, timeoutS, signal = null, now = Date.now, onStep = null, checkout, force = false, steps = CLOSE_STEPS }) {
  if (!job) throw new UserError("runClosePipeline needs the job it closes");
  const deadline = armDeadline({ timeoutS: requireTimeoutS(timeoutS), signal, now });
  const checklist = startingChecklist(job);
  const run = { store, job, worker, env, deps: deps ?? defaultCloseDeps(env), now, onStep, checklist, deadline, force, checkout: checkout ?? resolveCheckout(job, env) };
  try {
    for (const [index, step] of steps.entries()) {
      const outcome = await advance(run, step, index === steps.length - 1);
      if (outcome) return outcome;
    }
    return await stopClose(run, { step: "settle", reason: "not-settled" });
  } finally {
    deadline.disarm();
  }
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
