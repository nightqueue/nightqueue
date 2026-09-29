import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { jobWorktreePath, worktreesDir } from "../config/paths.mjs";
import { runGitAsync } from "../host/git.mjs";
import { isRunPath, ownRunState } from "./resume.mjs";
import { recordHeldWorktree, recordRunFields } from "./run-state.mjs";
import { canonicalPath, parseWorktreeList, sameDir } from "./worktree.mjs";

export const JOB_BRANCH_PREFIX = "worktree-";
export const WORKTREE_FAILED = "worktree-failed";
const HEADS = "refs/heads/";
const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 60000;
const FETCH_TIMEOUT_MS = 60000;
const BATCH_SSH = "ssh -o BatchMode=yes";

// A preparation that stopped, in the shape the runner gates a job with.
function failed(message) {
  return { ok: false, code: WORKTREE_FAILED, message };
}

// First line of a git message, short enough for a notice.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0].slice(0, 200);
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

// The entry git registers for the recorded worktree on the recorded branch, or null when there is none this job may reuse.
async function reusableEntry(git, prior) {
  if (!prior.worktree || !isAbsolute(prior.worktree) || !existsSync(prior.worktree)) return null;
  const entry = (await linkedWorktrees(git)).find((candidate) => sameDir(candidate.path, prior.worktree)) ?? null;
  if (!entry || (prior.branch !== null && shortBranch(entry.branch) !== prior.branch)) return null;
  return entry;
}

// Tells whether a local branch exists in the checkout.
async function branchExists(git, branch) {
  return (await git(["rev-parse", "--verify", "--quiet", `${HEADS}${branch}`])).ok;
}

// The canonical git common directory seen from a directory, or the reason git could not answer there.
async function commonDirFrom(git, cwd) {
  const answered = await git(["rev-parse", "--git-common-dir"], { cwd });
  const out = answered.ok ? String(answered.stdout ?? "").trim() : "";
  return out ? { dir: canonicalPath(resolve(cwd, out)) } : { error: firstLine(answered.stderr) || "git rev-parse failed" };
}

// Why git cannot work in a registered worktree of the checkout, or null when it can.
async function unusableReason(ctx, path) {
  const tree = await commonDirFrom(ctx.git, path);
  if (tree.error) return tree.error;
  const own = await commonDirFrom(ctx.git, ctx.checkout);
  if (own.error) return `git cannot read ${ctx.checkout}: ${own.error}`;
  return tree.dir === own.dir ? null : "it links to another repository";
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
  const remote = await ctx.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ctx.baseBranch}`]);
  return remote.ok ? `origin/${ctx.baseBranch}` : "HEAD";
}

// Tells whether git still registers a worktree whose directory is gone on the branch, the one thing that stops re-adding it.
async function prunableHolds(git, branch) {
  return (await linkedWorktrees(git)).some((entry) => entry.branch === `${HEADS}${branch}` && entry.prunable !== null);
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

// Records in the state of the run, after a failed add, only what git actually holds: the branch when it exists, the target when it is registered on it.
async function recordWhatGitHolds(ctx, { branch, prior }) {
  const heldBranch = (await branchExists(ctx.git, branch)) ? branch : prior.branch;
  const linked = await linkedWorktrees(ctx.git);
  const holdsTarget = linked.some((entry) => sameDir(entry.path, ctx.target) && shortBranch(entry.branch) === branch);
  const { job, env } = ctx;
  const written = recordHeldWorktree({ projectId: job.project_id, slug: job.slug, branch: heldBranch, worktree: holdsTarget ? ctx.target : prior.worktree, env });
  if (written.status !== "written") ctx.log(`the state of the run could not be set back to what git holds after the failed add (${written.reason})`);
}

// Creates the job's worktree with its ownership recorded first: a refused record creates nothing, and a failed add leaves a state naming only what git holds.
async function createRecorded(ctx, { branch, prior, make }) {
  const { job, env, target } = ctx;
  const written = recordRunFields({ projectId: job.project_id, slug: job.slug, fields: { branch, worktree: target }, env });
  if (written.status !== "written") return failed(`the worktree ${target} was not created: the state of the run could not record it (${written.reason})`);
  const error = await make();
  if (!error) return { ok: true, path: target, branch, reused: false, legacy: false };
  await recordWhatGitHolds(ctx, { branch, prior });
  return error;
}

// A recorded worktree reused where it is, the location an older nightqueue chose included, once git proves it can work there.
async function reuse(ctx, path, branch) {
  const unusable = await unusableReason(ctx, path);
  if (unusable) return failed(`the worktree ${path} is registered but git cannot use it (${unusable}); run \`nightqueue doctor --fix\` (git worktree repair) and retry`);
  return { ok: true, path, branch, reused: true, legacy: !isUnder(worktreesDir(ctx.env), path) };
}

// Creates the worktree of a job that has none to reuse: recreated from its recorded branch, or fresh on its own branch, never on a branch the state does not name.
async function create(ctx, prior) {
  const recreating = prior.branch !== null && (await branchExists(ctx.git, prior.branch));
  const branch = recreating ? prior.branch : jobBranchName(ctx.job.slug);
  if (!recreating && (await branchExists(ctx.git, branch))) {
    return failed(`the branch \`${branch}\` already exists in ${ctx.checkout} and the state of this run does not name it; nightqueue never takes over or forces a branch - rename or delete it, then retry`);
  }
  const make = () => (recreating ? recreate(ctx, branch) : createFresh(ctx, branch));
  return await createRecorded(ctx, { branch, prior, make });
}

// Tells whether the worktree slot of a slug is free: neither its path under the home nor its branch exists; advisory, since `git worktree add` refuses an occupied path anyway.
export async function worktreeSlotFree({ projectId, slug, checkout, env = process.env, gitImpl = runGitAsync } = {}) {
  try {
    if (existsSync(jobWorktreePath(projectId, slug, env))) return false;
    return !(await branchExists(gitIn({ gitImpl, checkout, env }), jobBranchName(slug)));
  } catch {
    return true;
  }
}

// Places the git worktree of a job before its session starts: the recorded one reused, recreated from its branch, or created fresh under the home.
export async function prepareJobWorktree({ job, checkout, baseBranch, env = process.env, gitImpl = runGitAsync, log = () => {} } = {}) {
  if (!isRunPath(job?.project_id, job?.slug)) return failed("the run has no slug, so the runtime cannot place its worktree");
  try {
    const target = jobWorktreePath(job.project_id, job.slug, env);
    const ctx = { job, checkout, baseBranch, env, log, target, git: gitIn({ gitImpl, checkout, env }) };
    const state = ownRunState({ projectId: job.project_id, slug: job.slug, jobId: job.id, env });
    const prior = { worktree: recordedText(state?.worktree), branch: recordedText(state?.branch) };
    const entry = await reusableEntry(ctx.git, prior);
    if (entry) return await reuse(ctx, prior.worktree, shortBranch(entry.branch) ?? prior.branch);
    if (existsSync(target)) return failed(`${target} exists and is not this job's registered worktree; \`nightqueue doctor\` lists it`);
    return await create(ctx, prior);
  } catch (err) {
    return failed(`the worktree could not be prepared: ${err?.message ?? String(err)}`);
  }
}
