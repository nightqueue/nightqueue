import { runGit, runGitAsync } from "../host/git.mjs";
import { jobRef } from "../memory/refs.mjs";
import { neverCommittedReason } from "./never-committed.mjs";
import { isAdoptedWorktree, parseWorktreeList } from "./worktree.mjs";

// The first words of the paragraph the runtime writes about a terminated run's work, the marker that keeps one paragraph per notice.
export const WIP_PREFIX = "Terminated run: ";
export const WIP_RETRY_PREFIX = "Retry: nightqueue queue retry";
export const WIP_NEW_JOB_PREFIX = "New job from it:";
export const WIP_KEPT_PREFIX = "Wip commit: ";
export const WIP_REF_PREFIX = "refs/nightqueue/wip/";
const WIP_LINE_PREFIXES = [WIP_PREFIX, WIP_RETRY_PREFIX, WIP_NEW_JOB_PREFIX, WIP_KEPT_PREFIX];
const WIP_SUBJECT_PREFIX = "wip(";
const REASON_MAX = 120;
const PATH_CHUNK = 500;
const DEFAULT_BRANCHES = ["main", "master"];
const HEADS_PREFIX = "refs/heads/";

export const WIP_SKIP_REASONS = {
  adopted: "adopted worktree",
  defaultBranch: "default branch",
  mainCheckout: "main checkout's branch",
  detached: "detached HEAD",
  noWorktree: "no worktree recorded",
};

// The subject of a terminated run's wip commit: the slug, the phase and the first line of the reason, capped.
export function wipMessage(slug, phase, reason) {
  const line = String(reason ?? "").trim().split("\n")[0].trim().slice(0, REASON_MAX);
  return `wip(${slug}): terminated at ${phase} — ${line}`;
}

// The ref the runtime alone writes for a run's wip commit, its durable record next to the branch.
export function wipRef(slug) {
  return `${WIP_REF_PREFIX}${slug}`;
}

// Drives a generator of git argument lists with a synchronous git, feeding each result back; answers what the generator returns.
function runStepsSync(steps, { cwd, env, gitImpl }) {
  let next = steps.next();
  while (!next.done) next = steps.next(gitImpl({ args: next.value, cwd, env }));
  return next.value;
}

// Drives a generator of git argument lists without blocking the event loop, feeding each result back; answers what it returns.
async function runStepsAsync(steps, { cwd, env, gitImpl }) {
  let next = steps.next();
  while (!next.done) next = steps.next(await gitImpl({ args: next.value, cwd, env }));
  return next.value;
}

// The trimmed output of a git step, or null when git refused it.
function* gitText(args) {
  const result = yield args;
  return result?.ok ? String(result.stdout ?? "").trim() : null;
}

// The first line of what a failed git call said, for the notice.
function gitFailure(result, what) {
  const said = String(result?.stderr || result?.stdout || "").trim().split("\n")[0];
  return said ? `${what}: ${said}` : what;
}

// Runs one git command over the paths, PATH_CHUNK at a time so argv stays bounded; answers the first failed result, or null.
function* inChunks(command, paths) {
  for (let start = 0; start < paths.length; start += PATH_CHUNK) {
    const result = yield [...command, ...paths.slice(start, start + PATH_CHUNK)];
    if (!result?.ok) return result ?? { ok: false, stderr: "git gave no answer" };
  }
  return null;
}

// The branches a wip commit never lands on: origin's default, `main`/`master`, and the branch the main checkout has out.
function* protectedBranches() {
  const origin = (yield* gitText(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])) ?? "";
  const defaults = origin.startsWith("origin/") ? [...DEFAULT_BRANCHES, origin.slice("origin/".length)] : DEFAULT_BRANCHES;
  const mainRef = parseWorktreeList((yield* gitText(["worktree", "list", "--porcelain"])) ?? "")[0]?.branch ?? "";
  const mainCheckout = mainRef.startsWith(HEADS_PREFIX) ? mainRef.slice(HEADS_PREFIX.length) : null;
  return { defaults, mainCheckout };
}

// Why the runtime must not commit in this worktree, or null when it may.
function* skipReason({ state, branch }) {
  if (isAdoptedWorktree(state)) return WIP_SKIP_REASONS.adopted;
  if (branch === null) return WIP_SKIP_REASONS.detached;
  const { defaults, mainCheckout } = yield* protectedBranches();
  if (defaults.includes(branch)) return WIP_SKIP_REASONS.defaultBranch;
  return branch === mainCheckout ? WIP_SKIP_REASONS.mainCheckout : null;
}

// The entries of `git status --porcelain -z` (v1): each with its columns, its path and, for a rename or copy in either column, its source path.
export function statusEntries(raw) {
  const tokens = String(raw ?? "").split("\0");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.length < 4) continue;
    const hasOrig = /[RC]/.test(token[0]) || /[RC]/.test(token[1]);
    const orig = hasOrig ? (tokens[index + 1] ?? "") : null;
    if (hasOrig) index += 1;
    entries.push({
      staged: token[0] !== " " && token[0] !== "?",
      changed: token[1] !== " ",
      path: token.slice(3),
      orig,
      renamedInIndex: token[0] === "R",
      renamedInWorktree: token[1] === "R",
    });
  }
  return entries;
}

// The paths `git add` must take: every allowed changed path, plus the source of a rename the index has not seen, so its deletion is staged.
function pathsToAdd(entries) {
  const changed = entries.filter((entry) => entry.changed).map((entry) => entry.path);
  const removed = entries.filter((entry) => entry.renamedInWorktree && entry.orig).map((entry) => entry.orig);
  return [...new Set([...changed, ...removed])].filter((path) => !neverCommittedReason(path));
}

// The refused paths the index already carries (a staged path, or the source of a staged rename), which must be unstaged before the commit.
function refusedStagedPaths(entries) {
  const staged = entries.filter((entry) => entry.staged).map((entry) => entry.path);
  const removed = entries.filter((entry) => entry.renamedInIndex && entry.orig).map((entry) => entry.orig);
  return [...new Set([...staged, ...removed])].filter((path) => neverCommittedReason(path));
}

// Stages every change the wip may take and unstages any refused path already staged; answers the paths taken, or the failure.
function* stageWip() {
  const status = yield ["status", "--porcelain", "-z", "--untracked-files=all"];
  if (!status?.ok) return { error: gitFailure(status, "git status failed") };
  const entries = statusEntries(status.stdout);
  const reset = yield* inChunks(["--literal-pathspecs", "reset", "-q", "--"], refusedStagedPaths(entries));
  if (reset) return { error: gitFailure(reset, "git reset of a refused path failed") };
  const added = yield* inChunks(["--literal-pathspecs", "add", "--"], pathsToAdd(entries));
  if (added) return { error: gitFailure(added, "git add failed") };
  return { files: entries.filter((entry) => !neverCommittedReason(entry.path)).map((entry) => entry.path) };
}

// Tells whether the index holds anything to commit.
function* hasStagedChanges() {
  const diff = yield ["diff", "--cached", "--quiet"];
  return !diff?.ok;
}

// Tells whether HEAD is this run's own wip commit (a `wip(` subject named by its record or by its wip ref), which a new one amends instead of stacking.
function* isOwnWip({ head, prior, ref }) {
  const subject = (yield* gitText(["log", "-1", "--format=%s", "HEAD"])) ?? "";
  if (!subject.startsWith(WIP_SUBJECT_PREFIX)) return false;
  if (typeof prior?.commit === "string" && prior.commit === head) return true;
  return (yield* gitText(["rev-parse", "--verify", "-q", ref])) === head;
}

// The paths a wip commit carries: the record's when it names that commit, else what the commit changed against its parent.
function* wipFiles(commit, prior) {
  if (prior?.commit === commit && Array.isArray(prior.files)) return prior.files;
  const listed = (yield* gitText(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit])) ?? "";
  return listed.split("\0").filter(Boolean);
}

// The short hash and the parent of a commit, as the answer and the record carry them.
function* commitIds(commit) {
  const short = (yield* gitText(["rev-parse", "--short", commit])) || commit.slice(0, 7);
  const parent = yield* gitText(["rev-parse", "--verify", "-q", `${commit}^`]);
  return { short, parent };
}

// Deletes every other wip ref that still names the commit an amend replaced, so a run keeps exactly one live wip ref.
function* dropReplacedRefs(replaced, ref) {
  for (const other of (yield* wipRefsAt(replaced)).filter((name) => name !== ref)) yield ["update-ref", "-d", other];
}

// Points the wip ref at the new commit in the same step; when the ref cannot be written the commit is undone, so a wip commit exists only with its ref.
function* anchorWip({ commit, head, ref, amend }) {
  const updated = yield ["update-ref", ref, commit];
  if (!updated?.ok) {
    const undone = yield ["reset", "--soft", "-q", head];
    const outcome = undone?.ok ? "the commit was undone" : `the commit could not be undone (${gitFailure(undone, "git reset")})`;
    return `${gitFailure(updated, `git update-ref ${ref} failed`)}; ${outcome}`;
  }
  if (amend) yield* dropReplacedRefs(head, ref);
  return null;
}

// Undoes a commit a failed `git commit` call still made (HEAD moved off the head before it), so no wip commit is left without its ref; answers what to add to the reason.
function* undoFailedCommit(head) {
  const now = yield* gitText(["rev-parse", "--verify", "-q", "HEAD"]);
  if (now === null || now === head) return "";
  const undone = yield ["reset", "--soft", "-q", head];
  return undone?.ok ? "; the commit it made was undone" : `; the commit it made could not be undone (${gitFailure(undone, "git reset")})`;
}

// Makes (or amends) the wip commit with what is staged, every repository hook and signing skipped, never pushed, and anchors its ref.
function* writeWipCommit({ message, amend, head, ref }) {
  const args = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "--no-verify", "-q", ...(amend ? ["--amend"] : []), "-m", message];
  const committed = yield args;
  if (!committed?.ok) return { error: `${gitFailure(committed, "git commit failed")}${yield* undoFailedCommit(head)}` };
  const commit = yield* gitText(["rev-parse", "HEAD"]);
  if (!commit) return { error: "the wip commit was made but HEAD could not be read" };
  const anchorError = yield* anchorWip({ commit, head, ref, amend });
  return anchorError ? { error: anchorError } : { commit };
}

// The answer for a HEAD that already is this run's wip with nothing new to add: the same commit, its ref written again.
function* adoptedWip({ head, prior, branch, ref }) {
  const updated = yield ["update-ref", ref, head];
  if (!updated?.ok) return { status: "failed", branch, reason: gitFailure(updated, `git update-ref ${ref} failed`) };
  const files = yield* wipFiles(head, prior);
  return { status: "committed", commit: head, ...(yield* commitIds(head)), branch, ref, files, amended: false };
}

// The steps of `commitWip`, which may throw.
function* commitWipSteps({ cwd, slug, phase, reason, prior, state }) {
  const head = yield* gitText(["rev-parse", "--verify", "-q", "HEAD"]);
  if (head === null) return { status: "failed", branch: null, reason: `no commit HEAD readable in ${cwd}` };
  const branch = (yield* gitText(["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  const skipped = yield* skipReason({ state, branch });
  if (skipped) return { status: "skipped", branch, reason: skipped };
  const ref = wipRef(slug);
  const format = yield ["check-ref-format", ref];
  if (!format?.ok) return { status: "failed", branch, reason: `the wip ref name ${ref} is not a valid git ref` };
  const staged = yield* stageWip();
  if (staged.error) return { status: "failed", branch, reason: staged.error };
  const amend = yield* isOwnWip({ head, prior, ref });
  if (!(yield* hasStagedChanges())) return amend ? yield* adoptedWip({ head, prior, branch, ref }) : { status: "clean", branch, files: [] };
  const written = yield* writeWipCommit({ message: wipMessage(slug, phase, reason), amend, head, ref });
  if (written.error) return { status: "failed", branch, reason: written.error };
  const earlier = amend ? yield* wipFiles(head, prior) : [];
  const files = [...new Set([...earlier, ...staged.files])];
  return { status: "committed", commit: written.commit, ...(yield* commitIds(written.commit)), branch, ref, files, amended: amend };
}

// The answer of a wip step that threw, with the first line of the error.
function thrownWip(err) {
  return { status: "failed", branch: null, reason: String(err?.message ?? err).split("\n")[0] };
}

// Commits a terminated run's changes on its own branch as one wip commit with its wip ref; answers committed, clean, skipped or failed, and never throws.
export function commitWip({ cwd, slug, phase, reason, prior = null, state = null, env = process.env, gitImpl = runGit } = {}) {
  try {
    return runStepsSync(commitWipSteps({ cwd, slug, phase, reason, prior, state }), { cwd, env, gitImpl });
  } catch (err) {
    return thrownWip(err);
  }
}

// `commitWip` without blocking the event loop, for the runner; never rejects.
export async function commitWipAsync({ cwd, slug, phase, reason, prior = null, state = null, env = process.env, gitImpl = runGitAsync } = {}) {
  try {
    return await runStepsAsync(commitWipSteps({ cwd, slug, phase, reason, prior, state }), { cwd, env, gitImpl });
  } catch (err) {
    return thrownWip(err);
  }
}

// Gives a runtime wip commit back as uncommitted changes (a mixed reset to its parent), only when a wip ref names HEAD; answers restored, none, moved or failed, and never rejects.
export async function restoreWip({ cwd, env = process.env, gitImpl = runGitAsync } = {}) {
  try {
    return await runStepsAsync(restoreWipSteps(cwd), { cwd, env, gitImpl });
  } catch (err) {
    return { status: "failed", reason: String(err?.message ?? err).split("\n")[0] };
  }
}

// The wip refs that name a commit, in ref order.
function* wipRefsAt(commit) {
  const listed = (yield* gitText(["for-each-ref", `--points-at=${commit}`, "--format=%(refname)", WIP_REF_PREFIX])) ?? "";
  return listed.split("\n").filter(Boolean);
}

// The steps of `restoreWip`, which may throw.
function* restoreWipSteps(cwd) {
  const head = yield* gitText(["rev-parse", "--verify", "-q", "HEAD"]);
  if (head === null) return { status: "failed", reason: `no commit HEAD readable in ${cwd}` };
  const [ref] = yield* wipRefsAt(head);
  if (!ref) return { status: "none", head };
  const subject = (yield* gitText(["log", "-1", "--format=%s", "HEAD"])) ?? "";
  if (!subject.startsWith(WIP_SUBJECT_PREFIX)) return { status: "moved", head, subject };
  const { short, parent } = yield* commitIds(head);
  if (!parent) return { status: "failed", reason: `the wip commit ${short} has no parent to give it back onto` };
  const branch = (yield* gitText(["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  const reset = yield ["reset", "--mixed", "-q", parent];
  if (!reset?.ok) return { status: "failed", reason: gitFailure(reset, "git reset of the wip commit failed") };
  return { status: "restored", commit: head, short, subject, ref, parent, branch };
}

// Puts the branch back on a restored wip commit at the end of an attempt (a mixed reset, no new commit), only while HEAD is still its parent; answers reanchored, none, moved or failed, and never rejects.
export async function reanchorWip({ cwd, wip, env = process.env, gitImpl = runGitAsync } = {}) {
  try {
    return await runStepsAsync(reanchorWipSteps(cwd, wip), { cwd, env, gitImpl });
  } catch (err) {
    return { status: "failed", reason: String(err?.message ?? err).split("\n")[0] };
  }
}

// Why a restored wip cannot be re-anchored on the current HEAD (other than HEAD having moved), or null when it can.
function* reanchorRefusal(wip, head) {
  if ((yield* gitText(["rev-parse", "--verify", "-q", `${wip.commit}^`])) !== head) return `the wip commit ${wip.commit} is not a child of HEAD`;
  if ((yield* wipRefsAt(wip.commit)).length === 0) return `no wip ref names the commit ${wip.commit}`;
  const branch = (yield* gitText(["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  return branch === wip.branch ? null : `HEAD is on ${branch ?? "a detached HEAD"}, not on the wip's branch ${wip.branch}`;
}

// The steps of `reanchorWip`, which may throw.
function* reanchorWipSteps(cwd, wip) {
  if (wip?.restored !== true || typeof wip.commit !== "string" || !wip.commit) return { status: "none" };
  const head = yield* gitText(["rev-parse", "--verify", "-q", "HEAD"]);
  if (head === null) return { status: "failed", reason: `no commit HEAD readable in ${cwd}` };
  if (head !== wip.parent) return { status: "moved", head };
  const refusal = yield* reanchorRefusal(wip, head);
  if (refusal) return { status: "failed", reason: refusal };
  const reset = yield ["reset", "--mixed", "-q", wip.commit];
  if (!reset?.ok) return { status: "failed", reason: gitFailure(reset, "git reset onto the wip commit failed") };
  return { status: "reanchored", commit: wip.commit };
}

// Tells whether the worktree still carries the changes of a wip commit given back earlier (a change on one of its paths), or whether they were discarded by hand; answers carried, discarded or failed, and never rejects.
export async function worktreeCarriesWip({ cwd, wip, env = process.env, gitImpl = runGitAsync } = {}) {
  try {
    return await runStepsAsync(carriesWipSteps(wip), { cwd, env, gitImpl });
  } catch (err) {
    return { status: "failed", reason: String(err?.message ?? err).split("\n")[0] };
  }
}

// The steps of `worktreeCarriesWip`, which may throw.
function* carriesWipSteps(wip) {
  if (typeof wip?.commit !== "string" || !wip.commit) return { status: "failed", reason: "the wip record names no commit" };
  const paths = new Set(yield* wipFiles(wip.commit, wip));
  if (paths.size === 0) return { status: "failed", reason: `the paths of the wip commit ${wip.commit} could not be read` };
  const status = yield ["status", "--porcelain", "-z", "--untracked-files=all"];
  if (!status?.ok) return { status: "failed", reason: gitFailure(status, "git status failed") };
  const carried = statusEntries(status.stdout).some((entry) => paths.has(entry.path) || paths.has(entry.orig));
  return { status: carried ? "carried" : "discarded" };
}

// The first line of the paragraph: what happened to the work.
function wipStatusLine(wip, worktree) {
  const where = worktree || "the run's worktree";
  if (wip?.status === "committed") return `${WIP_PREFIX}work kept as wip commit ${wip.short} on branch ${wip.branch} (local, never pushed, not reviewed).`;
  if (wip?.status === "clean") return `${WIP_PREFIX}no wip commit, the worktree had no changes.`;
  if (wip?.reason === WIP_SKIP_REASONS.noWorktree) return `${WIP_PREFIX}no wip commit (${wip.reason}).`;
  if (wip?.status === "skipped") return `${WIP_PREFIX}no wip commit (${wip.reason}); the changes stay uncommitted in ${where}.`;
  return `${WIP_PREFIX}the wip commit failed (${wip?.reason ?? "unknown reason"}); the changes stay uncommitted in ${where}.`;
}

// The paragraph the operator reads about a terminated run's work: what was kept, the exact retry line and the branch a new job can start from.
export function wipNoticeLine({ wip, jobId = null, branch = null, worktree = null } = {}) {
  const lines = [wipStatusLine(wip, worktree)];
  if (Number.isSafeInteger(jobId) && jobId > 0) {
    lines.push(`${WIP_RETRY_PREFIX} ${jobRef(jobId)} (the changes come back uncommitted in the same worktree; add --fresh to start over on a new branch)`);
  }
  if (branch) lines.push(`${WIP_NEW_JOB_PREFIX} start_branch: ${branch}`);
  else if (wip?.reason === WIP_SKIP_REASONS.detached) lines.push(`${WIP_NEW_JOB_PREFIX} no branch (detached HEAD)`);
  return lines.join("\n");
}

// The paragraph of a run that did not end by terminating while its branch still sits on a terminated attempt's wip commit.
export function wipKeptLine({ wip, branch, worktree = null } = {}) {
  const where = worktree || "the run's worktree";
  const first = `${WIP_KEPT_PREFIX}the branch ${branch} keeps the wip commit ${wip?.short} of a terminated attempt (local, never pushed, not reviewed); changes made after it stay uncommitted in ${where}.`;
  return `${first}\n${WIP_NEW_JOB_PREFIX} start_branch: ${branch}`;
}

// The notice with every earlier wip line dropped and the given paragraph appended, so a notice carries exactly one.
export function withWipLine(notice, line) {
  const kept = String(notice ?? "")
    .split("\n")
    .filter((text) => !WIP_LINE_PREFIXES.some((prefix) => text.startsWith(prefix)))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return kept ? `${kept}\n\n${line}` : line;
}
