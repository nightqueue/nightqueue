import { UserError } from "../config/errors.mjs";
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
const WIP_SUBJECT_SLUG = /^wip\(([^)]+)\): /;
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

// The wip refs that name a commit, in ref order.
function* wipRefsAt(commit) {
  const listed = (yield* gitText(["for-each-ref", `--points-at=${commit}`, "--format=%(refname)", WIP_REF_PREFIX])) ?? "";
  return listed.split("\n").filter(Boolean);
}

// The commits a tip adds to a base, newest first, each with its subject.
function* branchCommits(base, tip = "HEAD") {
  const listed = yield ["log", "--topo-order", "--format=%H%x00%s", `${base}..${tip}`];
  if (!listed?.ok) throw new UserError(gitFailure(listed, "git could not list the commits the branch adds"));
  return String(listed.stdout ?? "").split("\n").filter(Boolean).map((line) => {
    const [commit, subject = ""] = line.split("\0");
    return { commit, subject };
  });
}

// Every wip ref by name, and the ref naming each commit.
function* wipRefIndex() {
  const listed = yield ["for-each-ref", "--format=%(objectname) %(refname)", WIP_REF_PREFIX];
  if (!listed?.ok) throw new UserError(gitFailure(listed, "git could not list the runtime's wip refs"));
  const pairs = String(listed.stdout ?? "").split("\n").map((line) => line.trim().split(" ")).filter(([object, ref]) => object && ref);
  return { names: new Set(pairs.map(([, ref]) => ref)), byCommit: new Map(pairs) };
}

// Tells whether a commit is the runtime's own for this run: a `wip(<slug>)` subject of an allowed slug, whose wip ref reaches it.
function* isRunWip({ commit, subject }, { refs, slugs, anySlug }) {
  const slug = WIP_SUBJECT_SLUG.exec(subject)?.[1];
  if (!slug || !(anySlug || slugs.includes(slug)) || !refs.names.has(wipRef(slug))) return false;
  const reached = yield ["merge-base", "--is-ancestor", commit, wipRef(slug)];
  return reached?.ok === true;
}

// The refusal of a commit that is not the run's own and looks like a wip one (its subject or a wip ref naming it), or null.
function foreignWipLine({ commit, subject, ref }) {
  if (!ref && !subject.startsWith(WIP_SUBJECT_PREFIX)) return null;
  return `REJECTED: the branch carries the wip commit ${commit.slice(0, 7)} (${ref ?? subject}), which is not this run's own and is never pushed: stop and record it as an open item; the operator squashes it`;
}

// The refusal of a commit above a wip commit, which a fold would squash into the delivery.
function buriedLine({ commit, subject }, wip) {
  return `REJECTED: the commit ${commit.slice(0, 7)} (${subject}) sits above the wip commit ${wip.commit.slice(0, 7)}, which is never pushed: stop and record it as an open item; the operator squashes it`;
}

// The refusals of what the branch adds, given each commit with its ownership and the index of the oldest own one (-1 for none).
function ownershipProblems(commits, oldestOwn) {
  return commits.flatMap((entry, index) => {
    if (entry.own) return [];
    const foreign = foreignWipLine(entry);
    if (foreign) return [foreign];
    return index < oldestOwn ? [buriedLine(entry, commits[oldestOwn])] : [];
  });
}

// What folding the own commits takes: the commit they sit on and the paths they carry; or the refusal of a wip with no parent.
function* foldOf(commits, oldestOwn) {
  const oldest = commits[oldestOwn];
  const parent = yield* gitText(["rev-parse", "--verify", "-q", `${oldest.commit}^`]);
  if (!parent) return { problems: [`REJECTED: the wip commit ${oldest.commit.slice(0, 7)} has no parent, so it cannot be folded and is never pushed: stop and record it as an open item`], fold: null };
  const head = commits[0].commit;
  const changed = yield ["diff", "--name-only", "-z", "--no-renames", parent, head];
  if (!changed?.ok) throw new UserError(gitFailure(changed, "git could not list the paths of the wip commits"));
  const carried = String(changed.stdout ?? "").split("\0").filter(Boolean);
  return { problems: [], fold: { head, parent, commits: commits.filter((entry) => entry.own).map((entry) => entry.commit), carried } };
}

// Each commit with the wip ref naming it and whether it is the run's own.
function* withOwnership(entries, owner) {
  const commits = [];
  for (const entry of entries) commits.push({ ...entry, ref: owner.refs.byCommit.get(entry.commit) ?? null, own: yield* isRunWip(entry, owner) });
  return commits;
}

// The paths the index holds against HEAD.
function* stagedPaths() {
  const staged = yield ["diff", "--cached", "--name-only", "-z", "--no-renames"];
  if (!staged?.ok) throw new UserError(gitFailure(staged, "git could not list the staged paths"));
  return String(staged.stdout ?? "").split("\0").filter(Boolean);
}

// The fold a kill cut between its reset and its commit: ORIG_HEAD holds only the run's own commits above HEAD and the index only what they carry; null for any other state.
function* interruptedFold(owner) {
  const tip = yield* gitText(["rev-parse", "--verify", "-q", "ORIG_HEAD"]);
  if (!tip || !(yield ["merge-base", "--is-ancestor", "HEAD", tip])?.ok) return null;
  const commits = yield* withOwnership(yield* branchCommits("HEAD", tip), owner);
  if (commits.length === 0 || !commits.every((entry) => entry.own)) return null;
  const staged = yield* stagedPaths();
  const { fold } = yield* foldOf(commits, commits.length - 1);
  return fold && staged.length > 0 && staged.every((path) => fold.carried.includes(path)) ? { ...fold, interrupted: true } : null;
}

// The steps of `readBranchWips`, which may throw.
function* branchWipsSteps({ base, slugs, anySlug }) {
  const owner = { refs: yield* wipRefIndex(), slugs, anySlug };
  const commits = yield* withOwnership(yield* branchCommits(base), owner);
  const oldestOwn = commits.findLastIndex((entry) => entry.own);
  const problems = ownershipProblems(commits, oldestOwn);
  if (problems.length > 0) return { problems, fold: null };
  return oldestOwn < 0 ? { problems, fold: yield* interruptedFold(owner) } : yield* foldOf(commits, oldestOwn);
}

// Reads, without changing anything, the wip commits the branch adds to its base: the refusals of the foreign or buried ones, or the fold of the run's own; throws a `UserError` when git cannot answer.
export function readBranchWips({ cwd, base, slugs, anySlug = false, env = process.env, gitImpl = runGit } = {}) {
  return runStepsSync(branchWipsSteps({ base, slugs, anySlug }), { cwd, env, gitImpl });
}

// The steps of `wipAtHead`, which may throw.
function* wipAtHeadSteps() {
  const commit = yield* gitText(["rev-parse", "--verify", "-q", "HEAD"]);
  const subject = commit ? ((yield* gitText(["log", "-1", "--format=%s", commit])) ?? "") : "";
  const slug = WIP_SUBJECT_SLUG.exec(subject)?.[1];
  if (!slug || !(yield* isRunWip({ commit, subject }, { refs: yield* wipRefIndex(), slugs: [slug] }))) return null;
  const branch = (yield* gitText(["symbolic-ref", "--quiet", "--short", "HEAD"])) || null;
  return { status: "committed", commit, short: (yield* commitIds(commit)).short, branch, ref: wipRef(slug) };
}

// The runtime's wip commit HEAD of a worktree sits on, whichever run made it, without changing anything; null for any other HEAD or when git cannot answer.
export async function wipAtHead({ cwd, env = process.env, gitImpl = runGitAsync } = {}) {
  try {
    return await runStepsAsync(wipAtHeadSteps(), { cwd, env, gitImpl });
  } catch {
    return null;
  }
}

// Runs one git command over the paths, chunked so argv stays bounded; answers the first failed result, or null.
export function gitInChunks({ command, paths, cwd, env = process.env, gitImpl = runGit } = {}) {
  return runStepsSync(inChunks(command, paths), { cwd, env, gitImpl });
}

// The first line of the paragraph: what happened to the work.
function wipStatusLine(wip, worktree) {
  const where = worktree || "the run's worktree";
  if (wip?.status === "committed") return `${WIP_PREFIX}wip commit ${wip.short} kept on ${wip.branch}${wip.ref ? ` (ref ${wip.ref})` : ""}, local, never pushed, not reviewed.`;
  if (wip?.status === "clean") return `${WIP_PREFIX}no wip commit, the worktree had no changes.`;
  if (wip?.reason === WIP_SKIP_REASONS.noWorktree) return `${WIP_PREFIX}no wip commit (${wip.reason}).`;
  if (wip?.status === "skipped") return `${WIP_PREFIX}no wip commit (${wip.reason}); the changes stay uncommitted in ${where}.`;
  return `${WIP_PREFIX}the wip commit failed (${wip?.reason ?? "unknown reason"}); the changes stay uncommitted in ${where}.`;
}

// The paragraph the operator reads about a terminated run's work: what was kept, the exact retry line and the branch a new job can start from.
export function wipNoticeLine({ wip, jobId = null, branch = null, worktree = null } = {}) {
  const lines = [wipStatusLine(wip, worktree)];
  if (Number.isSafeInteger(jobId) && jobId > 0) {
    lines.push(`${WIP_RETRY_PREFIX} ${jobRef(jobId)} (the next attempt starts on the wip commit in the same worktree; add --fresh to start over on a new branch)`);
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
