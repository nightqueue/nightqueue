import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { withPathLock } from "../config/lock.mjs";
import { jobWorktreePath, startPointsLockPath, worktreesDir } from "../config/paths.mjs";
import { runGitAsync } from "../host/git.mjs";
import { shellQuote } from "../host/shell.mjs";
import { branchAliases, sameBranch, sameRefName, sameRunBranch } from "./branch-name.mjs";
import { isRunPath, ownRunState } from "./resume.mjs";
import { recordAdoptedWorktree, recordHeldWorktree, recordRunFields } from "./run-state.mjs";
import { canonicalPath, droppedNames, isAdoptedWorktree, lockPid, lockState, parseWorktreeList, sameDir } from "./worktree.mjs";
import { jobRef } from "../memory/refs.mjs";
import { isValidBranchName } from "../memory/start-point.mjs";

export const JOB_BRANCH_PREFIX = "worktree-";
export const WORKTREE_FAILED = "worktree-failed";
const HEADS = "refs/heads/";
const ORIGIN_REFS = "refs/remotes/origin/";
const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 60000;
const START_CLAIM_TIMEOUT_MS = 5000;
const BATCH_SSH = "ssh -o BatchMode=yes";
const LAST_BRANCH_RUNG = 99;

// A preparation that stopped, in the shape the runner gates a job with.
function failed(message) {
  return { ok: false, code: WORKTREE_FAILED, message };
}

// First line of a git message, short enough for a notice.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
}

// The refusal of a branch name git cannot parse, which no retry can ever get past.
function unparsableBranchText(name) {
  return `the branch \`${name}\` does not exist and never can: git does not accept that name; nothing was changed; cancel this job and queue the work on a valid branch`;
}

// A text field of the state: the trimmed value, or null when there is none.
function recordedText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

// The short name of a `refs/heads/...` ref, or null for anything else.
function shortBranch(ref) {
  return typeof ref === "string" && ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null;
}

// Tells whether a path lies strictly under a root once both are resolved.
function isUnder(root, path) {
  const inside = relative(canonicalPath(root), canonicalPath(path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

// The branch the runtime creates for a job's worktree, with no `+` a published name would read as the interactive separator.
export function jobBranchName(slug) {
  return `${JOB_BRANCH_PREFIX}${String(slug ?? "").replaceAll("+", "-")}`;
}

// A git runner bound to the checkout (or another directory), the environment and the chosen timeout.
function gitIn({ gitImpl, checkout, env }) {
  return (args, { timeoutMs = READ_TIMEOUT_MS, extraEnv = {}, cwd = checkout } = {}) => gitImpl({ args, cwd, env: { ...env, ...extraEnv }, timeoutMs });
}

// The linked worktrees git registers for the checkout, or none when git cannot list them.
async function linkedWorktrees(git) {
  const listed = await git(["worktree", "list", "--porcelain"]);
  if (!listed.ok) return [];
  const [, ...linked] = parseWorktreeList(listed.stdout);
  return linked;
}

// The entry git registers for the recorded worktree on the recorded branch (or one of its names), or on a detached HEAD unless the worktree is the operator's own; null when there is none this job may reuse.
async function reusableEntry(git, { prior, hints, state }) {
  if (!prior.worktree || !isAbsolute(prior.worktree) || !existsSync(prior.worktree)) return null;
  const entry = (await linkedWorktrees(git)).find((candidate) => sameDir(candidate.path, prior.worktree)) ?? null;
  if (!entry) return null;
  if (entry.branch === null) return isAdoptedWorktree(state) ? null : entry;
  if (prior.branch !== null && !sameBranch(shortBranch(entry.branch), prior.branch, hints)) return null;
  return entry;
}

// Tells whether a ref exists in the checkout; throws when git could not answer, since an unanswered read is never "absent", or when git cannot parse the name, which no retry fixes.
async function refExists(ctx, ref) {
  const answer = await ctx.git(["rev-parse", "--verify", "--quiet", ref]);
  if (answer.ok) return true;
  if (answer.exitCode === 1) return false;
  const format = await ctx.git(["check-ref-format", ref]);
  if (format.exitCode === 1) throw new Error(unparsableBranchText(ref.replace(/^refs\/(heads|remotes\/origin)\//, "")));
  const reason = firstLine(answer.stderr) || "git gave no reason";
  throw Object.assign(new Error(`git could not read ${ref} in ${ctx.checkout} (${reason}); retry`), { refUnreadable: true });
}

// Tells whether a local branch exists in the checkout.
async function branchExists(ctx, branch) {
  return await refExists(ctx, `${HEADS}${branch}`);
}

// The names of a run's branch that exist as local branches of the checkout.
async function localAliases(ctx, name) {
  const found = [];
  for (const alias of branchAliases(name, ctx.hints)) if (await branchExists(ctx, alias)) found.push(alias);
  return found;
}

// The branch names origin publishes among the given ones, or null when origin could not be asked.
async function publishedOnOrigin(ctx, names) {
  const listed = await ctx.git(["ls-remote", "--heads", "origin", ...names], { timeoutMs: FETCH_TIMEOUT_MS, extraEnv: fetchEnv(ctx.env) });
  if (!listed.ok) {
    ctx.log(`git ls-remote origin failed (${firstLine(listed.stderr)}); only the remote branches the checkout already knows are looked at`);
    return null;
  }
  const refs = String(listed.stdout ?? "").split("\n").map((line) => shortBranch(line.split("\t")[1]?.trim()));
  return names.filter((name) => refs.includes(name));
}

// Refreshes the remote-tracking refs of the names origin publishes, best effort: a failure is logged and what the checkout knows stays.
async function fetchPublished(ctx, names) {
  const published = (await publishedOnOrigin(ctx, names)) ?? [];
  for (const name of published) {
    const refspec = `+${HEADS}${name}:refs/remotes/origin/${name}`;
    const fetched = await ctx.git(["fetch", "--quiet", "origin", refspec], { timeoutMs: FETCH_TIMEOUT_MS, extraEnv: fetchEnv(ctx.env) });
    if (!fetched.ok) ctx.log(`git fetch origin ${name} failed (${firstLine(fetched.stderr)}); the checkout's own copy of it is used`);
  }
}

// The given branch names that exist on origin, read after a best-effort fetch; none when the checkout has no origin.
async function onOrigin(ctx, names) {
  if (!(await ctx.git(["remote", "get-url", "origin"])).ok) return [];
  await fetchPublished(ctx, names);
  const found = [];
  for (const name of names) if (await refExists(ctx, `refs/remotes/origin/${name}`)) found.push(name);
  return found;
}

// The names of a run's branch that exist on origin.
async function remoteAliases(ctx, name) {
  return await onOrigin(ctx, branchAliases(name, ctx.hints));
}

// The canonical git common directory seen from a directory, or the reason git could not answer there.
async function commonDirFrom(git, cwd) {
  const answered = await git(["rev-parse", "--git-common-dir"], { cwd });
  const out = answered.ok ? String(answered.stdout ?? "").trim() : "";
  return out ? { dir: canonicalPath(resolve(cwd, out)) } : { error: firstLine(answered.stderr) || "git rev-parse failed" };
}

// Why git cannot work in a registered worktree of the checkout and whether a repair may touch it, or null when it can.
async function unusableReason(ctx, path) {
  const tree = await commonDirFrom(ctx.git, path);
  if (tree.error) return { reason: tree.error, repairable: true };
  const own = await commonDirFrom(ctx.git, ctx.checkout);
  if (own.error) return { reason: `git cannot read ${ctx.checkout}: ${own.error}`, repairable: false };
  return tree.dir === own.dir ? null : { reason: "it links to another repository", repairable: false };
}

// Why a registered worktree stays unusable once `git worktree repair` had its chance, or null when git can work in it.
async function unusableAfterRepair(ctx, path) {
  const unusable = await unusableReason(ctx, path);
  if (!unusable?.repairable) return unusable?.reason ?? null;
  const repaired = await ctx.git(["worktree", "repair", path], { timeoutMs: WRITE_TIMEOUT_MS });
  if (!repaired.ok) ctx.log(`git worktree repair ${path} failed (${firstLine(repaired.stderr)})`);
  const still = await unusableReason(ctx, path);
  if (still) return `${still.reason}; \`git worktree repair\` did not fix it`;
  ctx.log(`git could not work in the worktree ${path} (${unusable.reason}); \`git worktree repair\` fixed it`);
  return null;
}

// Runs `git worktree add`, answering the failure with git's own first line, or null when it worked.
async function addWorktree(git, args) {
  const added = await git(["worktree", "add", "--quiet", ...args], { timeoutMs: WRITE_TIMEOUT_MS });
  return added.ok ? null : failed(`git worktree add failed: ${firstLine(added.stderr) || "git gave no reason"}`);
}

// The environment of a fetch that must never wait on a prompt: no terminal prompt, and ssh in batch mode unless the operator set their own ssh.
function fetchEnv(env) {
  const ownSsh = Boolean(env?.GIT_SSH_COMMAND || env?.GIT_SSH);
  return ownSsh ? { GIT_TERMINAL_PROMPT: "0" } : { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: BATCH_SSH };
}

// The ref a fresh branch starts from: the freshly fetched origin default branch when there is one, else the checkout's HEAD.
async function baseRef(ctx) {
  if (typeof ctx.baseBranch !== "string" || !ctx.baseBranch) return "HEAD";
  const fetched = await ctx.git(["fetch", "--quiet", "origin", ctx.baseBranch], { timeoutMs: FETCH_TIMEOUT_MS, extraEnv: fetchEnv(ctx.env) });
  if (!fetched.ok) ctx.log(`git fetch origin ${ctx.baseBranch} failed (${firstLine(fetched.stderr)}); the worktree starts from what the checkout already has`);
  return (await refExists(ctx, `refs/remotes/origin/${ctx.baseBranch}`)) ? `origin/${ctx.baseBranch}` : "HEAD";
}

// Tells whether git still registers a worktree whose directory is gone on the branch, the one thing that stops re-adding it.
async function prunableHolds(git, branch) {
  return (await linkedWorktrees(git)).some((entry) => sameRefName(shortBranch(entry.branch), branch) && entry.prunable !== null);
}

// Checks the recorded branch out again at the job's path, forgetting first only a registration whose directory is gone and that holds it.
async function recreate(ctx, branch) {
  if (await prunableHolds(ctx.git, branch)) await ctx.git(["worktree", "prune"], { timeoutMs: WRITE_TIMEOUT_MS });
  return await addWorktree(ctx.git, [ctx.target, branch]);
}

// Creates the job's own branch, never tracking anything, at the job's path.
async function createFresh(ctx, branch) {
  const base = await baseRef(ctx);
  return await addWorktree(ctx.git, ["--no-track", "-b", branch, ctx.target, base]);
}

// Tells whether a branch is known to exist after a failed add, where a read git could not answer counts as not held and never hides the add's own message.
async function branchKnownHeld(ctx, branch) {
  try {
    return await branchExists(ctx, branch);
  } catch (err) {
    ctx.log(`the branch \`${branch}\` could not be read after the failed add (${firstLine(err?.message ?? err)})`);
    return false;
  }
}

// Records in the state of the run, after a failed add, only what git actually holds: the branch when it exists, the target when it is registered on it.
async function recordWhatGitHolds(ctx, { branch, prior }) {
  const heldBranch = (await branchKnownHeld(ctx, branch)) ? branch : prior.branch;
  const linked = await linkedWorktrees(ctx.git);
  const holdsTarget = linked.some((entry) => sameDir(entry.path, ctx.target) && sameBranch(shortBranch(entry.branch), branch, ctx.hints));
  const { job, env } = ctx;
  const written = recordHeldWorktree({ projectId: job.project_id, slug: job.slug, branch: heldBranch, worktree: holdsTarget ? ctx.target : prior.worktree, env });
  if (written.status !== "written") ctx.log(`the state of the run could not be set back to what git holds after the failed add (${written.reason})`);
}

// The gate of a place the state of the run could not record, or null when it was recorded.
function recordRefusal(written, what) {
  return written.status === "written" ? null : failed(`${what}: the state of the run could not record it (${written.reason})`);
}

// Runs the step that makes a worktree, answering a throw as the gate it is, so the caller still sets the state back.
async function runMake(make) {
  try {
    return await make();
  } catch (err) {
    return failed(`the worktree could not be prepared: ${err?.message ?? String(err)}`);
  }
}

// Creates the job's worktree with its ownership recorded first, through the claim when one is given: a refused record creates nothing, and a failed add leaves a state naming only what git holds.
async function createRecorded(ctx, { branch, prior, make, claim = null }) {
  const { job, env, target } = ctx;
  const write = () => recordRunFields({ projectId: job.project_id, slug: job.slug, fields: { branch, worktree: target }, env });
  const refused = claim ? await claim(write) : recordRefusal(write(), `the worktree ${target} was not created`);
  if (refused) return refused;
  const error = await runMake(make);
  if (!error) return { ok: true, path: target, branch, reused: false, legacy: false };
  await recordWhatGitHolds(ctx, { branch, prior });
  return error;
}

// A recorded worktree reused where it is, the location an older nightqueue chose included, once git proves it can work there, repairing a lost link by itself.
async function reuse(ctx, path, branch) {
  const unusable = await unusableAfterRepair(ctx, path);
  if (unusable) return failed(`the worktree ${path} is registered but git cannot use it (${unusable})`);
  return { ok: true, path, branch, reused: true, legacy: !isUnder(worktreesDir(ctx.env), path) };
}

// The name among the given ones whose ref under the root has the newest commit, ties broken by git's refname order; the first name when git cannot order them.
async function newestAlias(ctx, { names, root }) {
  const listed = await ctx.git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)", ...names.map((name) => `${root}${name}`)]);
  if (!listed.ok) ctx.log(`git for-each-ref failed (${firstLine(listed.stderr)}); the branches could not be ordered by commit`);
  const ordered = String(listed.stdout ?? "").split("\n").map((line) => line.trim().slice(root.length));
  return ordered.find((name) => names.includes(name)) ?? names[0];
}

// The one name of a run's branch to work on among those that exist: the recorded name, else the newest; the others are logged and stay untouched.
async function pickAlias(ctx, { recorded, names, root }) {
  if (names.length === 1) return names[0];
  const pick = names.includes(recorded) ? recorded : await newestAlias(ctx, { names, root });
  const listing = names.map((name) => `\`${name}\``).join(", ");
  ctx.log(`the run's branch exists under several names (${listing}): the run takes \`${pick}\` and leaves the others untouched`);
  return pick;
}

// The first `<base>-<n>` no local branch carries under any of its names and no other open job holds, or null when none is free; one rung git could not read is skipped, a second stops the walk.
async function nextFreeRung(ctx, { base, others }) {
  let unreadable = 0;
  for (let rung = 2; rung <= LAST_BRANCH_RUNG; rung += 1) {
    const branch = `${base}-${rung}`;
    if (ownerRefusal({ others, hints: ctx.hints }, { path: null, branch })) continue;
    try {
      if ((await localAliases(ctx, branch)).length === 0) return branch;
    } catch (err) {
      unreadable += 1;
      if (!err?.refUnreadable || unreadable > 1) throw err;
      ctx.log(`the branch name \`${branch}\` is skipped: ${firstLine(err.message)}`);
    }
  }
  return null;
}

// The branch name a job can take now: its own when no local branch carries it, else the next free one; gated when another open job owns its own name, or when none is free.
async function freeJobBranch(ctx) {
  const base = jobBranchName(ctx.job.slug);
  const [taken] = await localAliases(ctx, base);
  if (!taken) return { ok: true, branch: base, base, taken: null };
  const holds = await ctx.openHolds();
  if (!Array.isArray(holds)) return failed(`the queue could not be read to check who owns \`${base}\`; retry`);
  const others = otherHolds(holds, ctx.job);
  const owner = ownerRefusal({ others, hints: ctx.hints }, { path: null, branch: base });
  if (owner) return failed(owner);
  const branch = await nextFreeRung(ctx, { base, others });
  if (branch === null) return failed(`no branch name from \`${base}\` to \`${base}-${LAST_BRANCH_RUNG}\` is free in ${ctx.checkout} for this run`);
  return { ok: true, branch, base, taken };
}

// Creates a fresh branch of the job from the base; a name past a branch the state does not name is logged and claimed, so two jobs never both take it.
async function createFreshRecorded(ctx, prior) {
  const free = await freeJobBranch(ctx);
  if (!free.ok) return free;
  const { branch, base, taken } = free;
  const make = () => createFresh(ctx, branch);
  if (taken === null) return await createRecorded(ctx, { branch, prior, make });
  ctx.log(`the branch \`${base}\` is taken (\`${taken}\`) and the state of this run does not name it: the run takes \`${branch}\``);
  return await createRecorded(ctx, { branch, prior, make, claim: (write) => claimStart(ctx, { path: null, branch }, write) });
}

// Recreates the worktree of a run on the branch it recorded, under whichever of its names exists locally, else on origin, else fresh.
async function createFromRecorded(ctx, prior) {
  const local = await localAliases(ctx, prior.branch);
  if (local.length > 0) {
    const branch = await pickAlias(ctx, { recorded: prior.branch, names: local, root: HEADS });
    return await createRecorded(ctx, { branch, prior, make: () => recreate(ctx, branch) });
  }
  const remote = await remoteAliases(ctx, prior.branch);
  if (remote.length === 0) return await createFreshRecorded(ctx, prior);
  const branch = await pickAlias(ctx, { recorded: prior.branch, names: remote, root: ORIGIN_REFS });
  return await createFromOrigin(ctx, { branch, prior });
}

// Creates the job's worktree on a local branch made from origin's copy of that branch, never tracking it.
async function createFromOrigin(ctx, { branch, prior, claim = null }) {
  const make = () => addWorktree(ctx.git, ["--no-track", "-b", branch, ctx.target, `refs/remotes/origin/${branch}`]);
  return await createRecorded(ctx, { branch, prior, make, claim });
}

// Creates the worktree of a job that has none to reuse: recreated from its recorded branch, or fresh on its own branch, never on a branch the state does not name.
async function create(ctx, prior) {
  return prior.branch !== null ? await createFromRecorded(ctx, prior) : await createFreshRecorded(ctx, prior);
}

// Tells whether the worktree slot of a slug is free: neither its path under the home nor any name of its branch exists; a slot it cannot read is logged and never free.
export async function worktreeSlotFree({ projectId, slug, checkout, env = process.env, gitImpl = runGitAsync, log = () => {} } = {}) {
  try {
    if (existsSync(jobWorktreePath(projectId, slug, env))) return false;
    const ctx = { git: gitIn({ gitImpl, checkout, env }), checkout, hints: { slug } };
    return (await localAliases(ctx, jobBranchName(slug))).length === 0;
  } catch (err) {
    log(`the worktree slot of \`${slug}\` could not be read (${firstLine(err?.message ?? err)})`);
    return false;
  }
}

// The job-log line of a state that moved to the branch its worktree really holds.
function heldBranchLine({ prior, held }) {
  return `the run's branch is \`${held}\` (state named \`${prior.branch ?? "none"}\`); the state now follows git`;
}

// Points the state of the run at the branch its reused worktree really holds, when `run pr` renamed it after the state was written; never fatal.
function followHeldBranch(ctx, { prior, held }) {
  if (held === null || held === prior.branch) return;
  const { job, env } = ctx;
  ctx.log(heldBranchLine({ prior, held }));
  const written = recordHeldWorktree({ projectId: job.project_id, slug: job.slug, branch: held, worktree: prior.worktree, env });
  if (written.status !== "written") ctx.log(`the state of the run could not follow the branch git holds (${written.reason})`);
}

// The starting point a job was queued with, as `{ branch, worktree }`, or null when it has none.
function queuedStart(job) {
  const branch = recordedText(job?.start_branch);
  const worktree = recordedText(job?.start_worktree);
  return branch === null && worktree === null ? null : { branch, worktree };
}

// The refusal of a protected branch, naming its real spelling when the job asked for it under another case.
function protectedBranchText(asked, real, what) {
  const spelling = asked === real ? "" : ` (\`${real}\`, under another case)`;
  return `\`${asked}\` is ${what}${spelling}; a job never works on it`;
}

// Why a job may not work on a branch: under any case it is the default branch or the main checkout's; null when it may.
function mainBranchRefusal(place, branch) {
  if (sameRefName(branch, place.baseBranch)) return protectedBranchText(branch, place.baseBranch, "the default branch");
  const mainBranch = shortBranch(place.main?.branch);
  return sameRefName(branch, mainBranch) ? protectedBranchText(branch, mainBranch, "the main checkout's branch") : null;
}

// Tells whether an open job's hold covers the given worktree path or branch, each branch expanded by its own run's slug/type.
function holdCovers(hold, { path, branch }, hints = {}) {
  if (path !== null && hold.worktree !== null && sameDir(hold.worktree, path)) return true;
  return branch !== null && hold.branch !== null && sameRunBranch(hold.branch, { slug: hold.slug, type: hold.type }, branch, hints);
}

// Why another open job keeps this one off a start point, naming that job; null when no other open job holds it.
function ownerRefusal(place, { path, branch }) {
  const owner = place.others.find((hold) => holdCovers(hold, { path, branch }, place.hints ?? {}));
  return owner ? `\`${path ?? branch}\` belongs to ${jobRef(owner.jobId)}, which is not closed; two open jobs never share a branch` : null;
}

// Why a live session keeps a job out of a worktree; null when no live session locked it.
function lockRefusal(entry) {
  return lockState(entry) === "live" ? `\`${entry.path}\` is locked by a live session (pid ${lockPid(entry.locked)})` : null;
}

// The holds of the open jobs of this job's project other than the job itself.
function otherHolds(holds, job) {
  return holds.filter((hold) => hold.jobId !== job.id && (hold.projectId ?? job.project_id) === job.project_id);
}

// Under the claim lock: refuses a start point another open job holds, else records it as this job's; null when recorded.
async function claimUnderLock(place, { path, branch }, write) {
  const holds = await place.openHolds();
  if (!Array.isArray(holds)) return failed(`the queue could not be read to check who owns \`${path ?? branch}\`; retry`);
  const refusal = ownerRefusal({ others: otherHolds(holds, place.job), hints: place.hints }, { path, branch });
  if (refusal) return failed(refusal);
  return recordRefusal(write(), `\`${path ?? branch}\` was not taken`);
}

// Takes a start point as one step per project, so two jobs started at once never both take it; null when this job took it, never throws.
async function claimStart(place, hold, write) {
  const lock = startPointsLockPath(place.job.project_id, place.env);
  try {
    return await withPathLock(lock, () => claimUnderLock(place, hold, write), { timeoutMs: place.claimTimeoutMs });
  } catch (err) {
    return failed(`\`${hold.path ?? hold.branch}\` could not be claimed (${firstLine(err?.message ?? String(err))}); another job of this project is taking its starting point right now - retry`);
  }
}

// Writes to the job log the uncommitted changes of the start worktree the job works on top of; never a gate.
async function noteUncommitted(place, path) {
  const status = await place.git(["status", "--porcelain", "--untracked-files=all"], { cwd: path });
  if (!status.ok) {
    place.log(`the start worktree ${path} could not be read for uncommitted changes (${firstLine(status.stderr)})`);
    return;
  }
  if (String(status.stdout ?? "").trim() === "") return;
  place.log(`the start worktree ${path} has uncommitted changes (${droppedNames(status.stdout)}); the job works on top of them, and nightqueue never removes this worktree`);
}

// A linked worktree proven fit for this job to work in, or the gate of the rule that refuses it.
async function vetEntry(place, entry) {
  const branch = shortBranch(entry.branch);
  if (branch === null) return failed(`the worktree ${entry.path} is detached; a job starts only on a branch: put one on it (git -C ${shellQuote(entry.path)} switch -c <name>) and retry`);
  const refusal = mainBranchRefusal(place, branch) ?? ownerRefusal(place, { path: entry.path, branch }) ?? lockRefusal(entry);
  return refusal ? failed(refusal) : await reuse(place, entry.path, branch);
}

// Starts the job in a linked worktree on its branch, once no rule refuses it, claimed and recorded as the worktree the job adopted.
async function startInEntry(place, entry) {
  const reused = await vetEntry(place, entry);
  if (!reused.ok) return reused;
  const { job, env } = place;
  const { branch } = reused;
  const adopt = () => recordAdoptedWorktree({ projectId: job.project_id, slug: job.slug, branch, worktree: entry.path, env });
  const refused = await claimStart(place, { path: entry.path, branch }, adopt);
  if (refused) return refused;
  await noteUncommitted(place, entry.path);
  return reused;
}

// Tells whether a path is a directory that holds nothing; one that cannot be read does not count as empty.
function isEmptyDir(path) {
  try {
    return readdirSync(path).length === 0;
  } catch {
    return false;
  }
}

// A name beside the path that nothing holds now, for a stray directory to move to.
function freeStrayName(target) {
  if (!existsSync(`${target}.stray`)) return `${target}.stray`;
  let rung = 2;
  while (existsSync(`${target}.stray-${rung}`)) rung += 1;
  return `${target}.stray-${rung}`;
}

// The one command that frees a stray path and cannot destroy what it holds: `rmdir` of an empty directory, else a move that overwrites nothing.
function strayFreeCommand(target) {
  if (isEmptyDir(target)) return `rmdir ${shellQuote(target)}`;
  return `mv -n ${shellQuote(target)} ${shellQuote(freeStrayName(target))}`;
}

// The gate of a directory at the job's path that git does not register, naming what it is and the command that frees it.
function strayRefusal(place) {
  return failed(`${place.target} exists and is not a linked worktree of ${place.checkout}: it is a stray directory; free it with \`${strayFreeCommand(place.target)}\``);
}

// The gate of a job queued on a branch whose path is occupied: the open job holding the path when one does, else what occupies it, answered by a fresh retry at a new path.
function occupiedTargetRefusal(place, name) {
  const entry = place.linked.find((candidate) => sameDir(candidate.path, place.target));
  if (!entry) return strayRefusal(place);
  const owner = ownerRefusal(place, { path: place.target, branch: null });
  if (owner) return failed(owner);
  const held = shortBranch(entry.branch);
  const holding = held === null ? "a detached HEAD" : `\`${held}\``;
  return { ...failed(`${place.target} is a linked worktree on ${holding}, and this job was queued on \`${name}\`, so it cannot start there; nothing was changed`), fresh: true };
}

// Starts the job in the linked worktree it was queued with.
async function startInWorktree(place, path) {
  const entry = place.linked.find((candidate) => sameDir(candidate.path, path));
  if (!entry) return failed(`${path} is not a linked worktree of ${place.checkout}; a job never works in the main checkout or an unregistered directory`);
  return await startInEntry(place, entry);
}

// The local branch names git lists, or null with one log line saying what the placement does without them.
async function listedBranches(place, withoutThem) {
  const listed = await place.git(["for-each-ref", "--format=%(refname)", HEADS]);
  if (listed.ok) return String(listed.stdout ?? "").split("\n").map((line) => shortBranch(line.trim())).filter(Boolean);
  place.log(`git for-each-ref failed (${firstLine(listed.stderr)}); ${withoutThem}`);
  return null;
}

// The name git lists for a branch asked under any spelling: the asked one when git lists it as is or lists no match, or when it cannot list.
async function listedSpelling(place, asked) {
  const names = await listedBranches(place, `the branch is taken as queued, \`${asked}\``);
  if (names === null || names.includes(asked)) return asked;
  return names.find((name) => sameRefName(name, asked)) ?? asked;
}

// The live linked worktree holding the asked branch: its exact spelling first, else another spelling unless git lists both as branches of their own.
async function holdingEntry(place, asked) {
  const live = place.linked.filter((candidate) => candidate.prunable === null);
  const exact = live.find((candidate) => shortBranch(candidate.branch) === asked);
  if (exact) return exact;
  const folded = live.filter((candidate) => sameRefName(shortBranch(candidate.branch), asked));
  if (folded.length === 0) return null;
  const names = await listedBranches(place, `the worktree ${folded[0].path} is taken as the one holding \`${asked}\``);
  if (names === null || !names.includes(asked)) return folded[0];
  return folded.find((candidate) => !names.includes(shortBranch(candidate.branch))) ?? null;
}

// Places the job in a new worktree on the branch git names for what was asked, local or else from origin.
async function startOnListedBranch(place, asked) {
  const name = await listedSpelling(place, asked);
  if (name !== asked) place.log(`the job was queued on \`${asked}\` and git names that branch \`${name}\`: the run takes \`${name}\``);
  const prior = { branch: null, worktree: null };
  const claim = (write) => claimStart(place, { path: place.target, branch: name }, write);
  if (await branchExists(place, name)) return await createRecorded(place, { branch: name, prior, make: () => recreate(place, name), claim });
  if ((await onOrigin(place, [name])).length === 1) return await createFromOrigin(place, { branch: name, prior, claim });
  return failed(`the branch \`${asked}\` does not exist in ${place.checkout} nor on origin`);
}

// Starts the job on the branch it was queued with: in the linked worktree holding it under any case, else in a new worktree on it.
async function startOnBranch(place, asked) {
  if (!isValidBranchName(asked)) return failed(unparsableBranchText(asked));
  const refusal = mainBranchRefusal(place, asked);
  if (refusal) return failed(refusal);
  const entry = await holdingEntry(place, asked);
  if (entry) return await startInEntry(place, entry);
  const owner = ownerRefusal(place, { path: null, branch: asked });
  if (owner) return failed(owner);
  if (existsSync(place.target)) return occupiedTargetRefusal(place, asked);
  return await startOnListedBranch(place, asked);
}

// Why a job may not take back the worktree or branch its run recorded: another open job holds it now; null when none does.
async function recordedRefusal(ctx, prior) {
  if (prior.branch === null && prior.worktree === null) return null;
  const holds = await ctx.openHolds();
  if (!Array.isArray(holds)) return failed(`the queue could not be read to check who owns \`${prior.worktree ?? prior.branch}\`; retry`);
  const refusal = ownerRefusal({ others: otherHolds(holds, ctx.job), hints: ctx.hints }, { path: prior.worktree, branch: prior.branch });
  return refusal ? failed(refusal) : null;
}

// What a placement is checked against: the worktrees git lists and the holds of the other open jobs, or the gate when either cannot be read.
async function loadPlace(ctx, subject) {
  const listed = await ctx.git(["worktree", "list", "--porcelain"]);
  if (!listed.ok) return failed(`git cannot list the worktrees of ${ctx.checkout} (${firstLine(listed.stderr)}); retry`);
  const [main, ...linked] = parseWorktreeList(listed.stdout);
  const holds = await ctx.openHolds();
  if (!Array.isArray(holds)) return failed(`the queue could not be read to check who owns \`${subject}\`; retry`);
  return { ...ctx, ok: true, main, linked, others: otherHolds(holds, ctx.job) };
}

// Places a job on the starting point it was queued with, checked against the main checkout, live locks and every other open job.
async function placeStart(ctx, start) {
  const place = await loadPlace(ctx, start.worktree ?? start.branch);
  if (!place.ok) return place;
  return start.worktree !== null ? await startInWorktree(place, start.worktree) : await startOnBranch(place, start.branch);
}

// Writes to the job log that a job queued on another branch follows the branch its worktree now holds.
function logQueuedDrift(place, held) {
  const queued = queuedStart(place.job)?.branch ?? null;
  if (queued !== null && !sameRefName(queued, held)) place.log(`the job was queued on \`${queued}\` and its worktree now holds \`${held}\`: the run follows the worktree`);
}

// Writes to the job log what an adoption moved: the branch the state named and the branch the job was queued on, when the worktree now holds another.
function logAdoptedBranch(place, { prior, held }) {
  if (held !== prior.branch) place.log(heldBranchLine({ prior, held }));
  logQueuedDrift(place, held);
}

// Puts a new branch on the detached HEAD of a worktree with `git switch`, which keeps its changes and refuses mid-rebase; answers the gate naming git's reason, or null.
async function switchToNewBranch(place, { path, branch }) {
  const switched = await place.git(["switch", "--no-track", "-c", branch], { cwd: path, timeoutMs: WRITE_TIMEOUT_MS });
  if (switched.ok) return null;
  return failed(`the worktree ${path} is on a detached HEAD and git could not put the branch \`${branch}\` on it (${firstLine(switched.stderr) || "git gave no reason"}); finish or abort what is in progress there, then retry`);
}

// Takes the runtime's own worktree left on a detached HEAD by creating the job's free branch on it, recorded first and set back when git refuses.
async function placeDetached(place, { entry, path, prior }) {
  const refusal = ownerRefusal(place, { path, branch: null }) ?? lockRefusal(entry);
  if (refusal) return failed(refusal);
  const usable = await reuse(place, path, null);
  if (!usable.ok) return usable;
  const free = await freeJobBranch(place);
  if (!free.ok) return free;
  const { job, env } = place;
  const { branch } = free;
  const hold = (held, worktree) => recordHeldWorktree({ projectId: job.project_id, slug: job.slug, branch: held, worktree, env });
  const refused = await claimStart(place, { path, branch }, () => hold(branch, path));
  if (refused) return refused;
  const error = await runMake(() => switchToNewBranch(place, { path, branch }));
  if (error) return setBackAfterSwitch(place, { error, written: hold(prior.branch, prior.worktree) });
  const left = prior.branch === null ? "" : ` and leaves \`${prior.branch}\` untouched`;
  place.log(`the run's worktree ${path} was on a detached HEAD: the run takes \`${branch}\` on it${left}`);
  logQueuedDrift(place, branch);
  return { ...usable, branch };
}

// The gate of a refused switch, logging a state that could not be set back.
function setBackAfterSwitch(place, { error, written }) {
  if (written.status !== "written") place.log(`the state of the run could not be set back after the refused switch (${written.reason})`);
  return error;
}

// Takes the runtime's own worktree at the job's path on the branch it really holds, claimed and recorded as held so a later release may still remove it.
async function adoptTarget(place, { entry, prior }) {
  const reused = await vetEntry(place, entry);
  if (!reused.ok) return reused;
  const { job, env } = place;
  const { branch } = reused;
  const hold = () => recordHeldWorktree({ projectId: job.project_id, slug: job.slug, branch, worktree: entry.path, env });
  const refused = await claimStart(place, { path: entry.path, branch }, hold);
  if (refused) return refused;
  logAdoptedBranch(place, { prior, held: branch });
  return reused;
}

// Places a job whose path already exists but holds nothing its state names: the registered worktree adopted, on a new branch when it is detached; a stray directory refused.
async function placeOnTarget(ctx, prior) {
  const place = await loadPlace(ctx, ctx.target);
  if (!place.ok) return place;
  const found = place.linked.find((candidate) => sameDir(candidate.path, ctx.target));
  if (!found) return strayRefusal(place);
  const entry = { ...found, path: ctx.target };
  return entry.branch === null ? await placeDetached(place, { entry, path: ctx.target, prior }) : await adoptTarget(place, { entry, prior });
}

// Reuses the worktree the run recorded, following the branch it really holds, or putting a branch on a detached HEAD.
async function reuseRecorded(ctx, { entry, prior }) {
  if (entry.branch !== null) {
    const held = shortBranch(entry.branch) ?? prior.branch;
    followHeldBranch(ctx, { prior, held });
    return await reuse(ctx, prior.worktree, held);
  }
  const place = await loadPlace(ctx, prior.worktree);
  return place.ok ? await placeDetached(place, { entry, path: prior.worktree, prior }) : place;
}

// Places the git worktree of a job before its session starts: the recorded one reused, its queued starting point, recreated from its branch, or created fresh under the home.
export async function prepareJobWorktree({ job, checkout, baseBranch, env = process.env, gitImpl = runGitAsync, log = () => {}, openHolds = async () => [], claimTimeoutMs = START_CLAIM_TIMEOUT_MS } = {}) {
  if (!isRunPath(job?.project_id, job?.slug)) return failed("the run has no slug, so the runtime cannot place its worktree");
  try {
    const target = jobWorktreePath(job.project_id, job.slug, env);
    const state = ownRunState({ projectId: job.project_id, slug: job.slug, jobId: job.id, env });
    const start = queuedStart(job);
    const hints = { slug: start ? null : job.slug, type: recordedText(state?.type) };
    const ctx = { job, checkout, baseBranch, env, log, target, hints, openHolds, claimTimeoutMs, git: gitIn({ gitImpl, checkout, env }) };
    const prior = { worktree: recordedText(state?.worktree), branch: recordedText(state?.branch) };
    const taken = await recordedRefusal(ctx, prior);
    if (taken) return taken;
    const entry = await reusableEntry(ctx.git, { prior, hints, state });
    if (entry) return await reuseRecorded(ctx, { entry, prior });
    if (start && prior.branch === null && prior.worktree === null) return await placeStart(ctx, start);
    if (existsSync(target)) return await placeOnTarget(ctx, prior);
    return await create(ctx, prior);
  } catch (err) {
    return failed(`the worktree could not be prepared: ${err?.message ?? String(err)}`);
  }
}

// Places the worktree of a run started outside any job exactly as a job's: same path, branch, base and record-first creation.
export async function prepareRunWorktree({ projectId, slug, checkout, baseBranch, env = process.env, gitImpl = runGitAsync, log = () => {} } = {}) {
  return await prepareJobWorktree({ job: { id: null, project_id: projectId, slug }, checkout, baseBranch, env, gitImpl, log });
}
