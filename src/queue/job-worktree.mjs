import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { jobWorktreePath, worktreesDir } from "../config/paths.mjs";
import { runGitAsync } from "../host/git.mjs";
import { branchAliases, sameBranch } from "./branch-name.mjs";
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

// The entry git registers for the recorded worktree on the recorded branch (or one of its names), or null when there is none this job may reuse.
async function reusableEntry(git, { prior, hints }) {
  if (!prior.worktree || !isAbsolute(prior.worktree) || !existsSync(prior.worktree)) return null;
  const entry = (await linkedWorktrees(git)).find((candidate) => sameDir(candidate.path, prior.worktree)) ?? null;
  if (!entry || (prior.branch !== null && !sameBranch(shortBranch(entry.branch), prior.branch, hints))) return null;
  return entry;
}

// Tells whether a ref exists in the checkout.
async function refExists(git, ref) {
  return (await git(["rev-parse", "--verify", "--quiet", ref])).ok;
}

// Tells whether a local branch exists in the checkout.
async function branchExists(git, branch) {
  return await refExists(git, `${HEADS}${branch}`);
}

// The names of a run's branch that exist as local branches of the checkout.
async function localAliases(ctx, name) {
  const found = [];
  for (const alias of branchAliases(name, ctx.hints)) if (await branchExists(ctx.git, alias)) found.push(alias);
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

// The names of a run's branch that exist on origin, read after a best-effort fetch; none when the checkout has no origin.
async function remoteAliases(ctx, name) {
  if (!(await ctx.git(["remote", "get-url", "origin"])).ok) return [];
  const aliases = branchAliases(name, ctx.hints);
  await fetchPublished(ctx, aliases);
  const found = [];
  for (const alias of aliases) if (await refExists(ctx.git, `refs/remotes/origin/${alias}`)) found.push(alias);
  return found;
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
  const holdsTarget = linked.some((entry) => sameDir(entry.path, ctx.target) && sameBranch(shortBranch(entry.branch), branch, ctx.hints));
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

// The gate of a run whose branch exists under several names at once, none of which nightqueue may pick.
function ambiguousBranch(names) {
  return failed(`the branches ${names.map((name) => `\`${name}\``).join(", ")} are all names of this run's branch; nightqueue will not pick one - delete the stale one, then retry`);
}

// Creates a fresh branch of the job from the base, refused when any name of it already exists locally, since the state of the run does not name it.
async function createFreshRecorded(ctx, prior) {
  const branch = jobBranchName(ctx.job.slug);
  const [taken] = await localAliases(ctx, branch);
  if (taken) {
    return failed(`the branch \`${taken}\` already exists in ${ctx.checkout} and the state of this run does not name it; nightqueue never takes over or forces a branch - rename or delete it, then retry`);
  }
  return await createRecorded(ctx, { branch, prior, make: () => createFresh(ctx, branch) });
}

// Recreates the worktree of a run on the branch it recorded, under whichever of its names exists locally, else on origin, else fresh.
async function createFromRecorded(ctx, prior) {
  const local = await localAliases(ctx, prior.branch);
  if (local.length > 1) return ambiguousBranch(local);
  if (local.length === 1) return await createRecorded(ctx, { branch: local[0], prior, make: () => recreate(ctx, local[0]) });
  const remote = await remoteAliases(ctx, prior.branch);
  if (remote.length > 1) return ambiguousBranch(remote);
  if (remote.length === 0) return await createFreshRecorded(ctx, prior);
  const [branch] = remote;
  const make = () => addWorktree(ctx.git, ["--no-track", "-b", branch, ctx.target, `refs/remotes/origin/${branch}`]);
  return await createRecorded(ctx, { branch, prior, make });
}

// Creates the worktree of a job that has none to reuse: recreated from its recorded branch, or fresh on its own branch, never on a branch the state does not name.
async function create(ctx, prior) {
  return prior.branch !== null ? await createFromRecorded(ctx, prior) : await createFreshRecorded(ctx, prior);
}

// Tells whether the worktree slot of a slug is free: neither its path under the home nor any name of its branch exists; advisory, since `git worktree add` refuses an occupied path anyway.
export async function worktreeSlotFree({ projectId, slug, checkout, env = process.env, gitImpl = runGitAsync } = {}) {
  try {
    if (existsSync(jobWorktreePath(projectId, slug, env))) return false;
    const ctx = { git: gitIn({ gitImpl, checkout, env }), hints: { slug } };
    return (await localAliases(ctx, jobBranchName(slug))).length === 0;
  } catch {
    return true;
  }
}

// Points the state of the run at the branch its reused worktree really holds, when `run pr` renamed it after the state was written; never fatal.
function followHeldBranch(ctx, { prior, held }) {
  if (held === null || held === prior.branch) return;
  const { job, env } = ctx;
  ctx.log(`the run's branch is \`${held}\` (state named \`${prior.branch ?? "none"}\`); the state now follows git`);
  const written = recordHeldWorktree({ projectId: job.project_id, slug: job.slug, branch: held, worktree: prior.worktree, env });
  if (written.status !== "written") ctx.log(`the state of the run could not follow the branch git holds (${written.reason})`);
}

// Places the git worktree of a job before its session starts: the recorded one reused, recreated from its branch, or created fresh under the home.
export async function prepareJobWorktree({ job, checkout, baseBranch, env = process.env, gitImpl = runGitAsync, log = () => {} } = {}) {
  if (!isRunPath(job?.project_id, job?.slug)) return failed("the run has no slug, so the runtime cannot place its worktree");
  try {
    const target = jobWorktreePath(job.project_id, job.slug, env);
    const state = ownRunState({ projectId: job.project_id, slug: job.slug, jobId: job.id, env });
    const hints = { slug: job.slug, type: recordedText(state?.type) };
    const ctx = { job, checkout, baseBranch, env, log, target, hints, git: gitIn({ gitImpl, checkout, env }) };
    const prior = { worktree: recordedText(state?.worktree), branch: recordedText(state?.branch) };
    const entry = await reusableEntry(ctx.git, { prior, hints });
    if (entry) {
      const held = shortBranch(entry.branch) ?? prior.branch;
      followHeldBranch(ctx, { prior, held });
      return await reuse(ctx, prior.worktree, held);
    }
    if (existsSync(target)) return failed(`${target} exists and is not this job's registered worktree; \`nightqueue doctor\` lists it`);
    return await create(ctx, prior);
  } catch (err) {
    return failed(`the worktree could not be prepared: ${err?.message ?? String(err)}`);
  }
}
