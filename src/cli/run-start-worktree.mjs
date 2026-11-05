import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobWorktreePath, runDir } from "../config/paths.mjs";
import { runGitAsync } from "../host/git.mjs";
import { jobBranchName, prepareRunWorktree, worktreeSlotFree } from "../queue/job-worktree.mjs";
import { checkoutDefaultBranch } from "../queue/preflight.mjs";
import { isStateObject, readRunState } from "../queue/resume.mjs";
import { slugVariants } from "../queue/run-slug.mjs";
import { projectCheckout } from "./run-context.mjs";

// The registered checkout of the run's project, refused when its path no longer exists on disk.
function existingCheckout(run, env) {
  const checkout = projectCheckout(run.project, env);
  if (!existsSync(checkout)) {
    throw new UserError(`the checkout ${checkout} of project \`${run.project}\` does not exist; restore it or register the project again with \`nightqueue project add\``);
  }
  return checkout;
}

// Whether the run of this slug already recorded a phase, so a repeated start resumes it instead of taking the next slot.
function hasRecordedPhase(run, env) {
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env });
  return isStateObject(state) && Array.isArray(state.phases) && state.phases.length > 0;
}

// Whether the checkout has a commit a run branch can start from; false for a directory that is no repository or has an unborn HEAD.
async function hasCommit(checkout, env) {
  const probed = await runGitAsync({ args: ["-C", checkout, "rev-parse", "--verify", "--quiet", "HEAD"], env });
  return probed.ok === true;
}

// Creates the leaf of a run directory only when nothing is there yet, so only a directory this call created becomes the run; false when it exists.
function claimRunDir(dir) {
  mkdirSync(dirname(dir), { recursive: true });
  try {
    mkdirSync(dir);
    return true;
  } catch (err) {
    if (err?.code === "EEXIST") return false;
    throw new UserError(`the run directory ${dir} could not be created: ${err?.message ?? String(err)}`);
  }
}

// Deletes the run branch a refused placement left in the checkout, so the slug is free for the next start; a failure is logged, never fatal.
async function dropLeftoverBranch({ slug, checkout, env, log }) {
  const branch = jobBranchName(slug);
  const held = await runGitAsync({ args: ["-C", checkout, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], env });
  if (!held.ok) return;
  const dropped = await runGitAsync({ args: ["-C", checkout, "branch", "-D", branch], env });
  if (!dropped.ok) log(`the branch \`${branch}\` the refused placement left could not be deleted: ${String(dropped.stderr ?? "").trim()}`);
}

// Whether a live worktree of another placement holds the slug's slot: its path exists or git lists its branch as checked out.
async function slotHeldByAnotherPlacement({ projectId, slug, checkout, env }) {
  if (existsSync(jobWorktreePath(projectId, slug, env))) return true;
  const listed = await runGitAsync({ args: ["-C", checkout, "worktree", "list", "--porcelain"], env });
  return listed.ok === true && String(listed.stdout ?? "").split("\n").includes(`branch refs/heads/${jobBranchName(slug)}`);
}

// Places the worktree of one free slug and answers the run moved to it, or null when another placement took the slot first; a refused placement removes the directory and branch it left and throws.
async function placeOnSlug(run, { slug, dir, checkout, ctx, log }) {
  const placed = await prepareRunWorktree({ projectId: run.projectId, slug, checkout, baseBranch: checkoutDefaultBranch(checkout), env: ctx.env, log });
  if (placed.ok) return { ...run, slug, runDir: dir };
  rmSync(dir, { recursive: true, force: true });
  if (await slotHeldByAnotherPlacement({ projectId: run.projectId, slug, checkout, env: ctx.env })) {
    log(`the slot of \`${slug}\` was taken by another placement while this start placed it; trying the next slug`);
    return null;
  }
  await dropLeftoverBranch({ slug, checkout, env: ctx.env, log });
  throw new UserError(`the worktree of the run could not be placed: ${placed.message}`);
}

// Places the worktree of a run started outside a job like a job's, on the first slug whose worktree slot and run directory are free; a run with a recorded phase resumes as it is, and a checkout with no commit keeps the run in place.
export async function placeOperatorRun(run, ctx) {
  const checkout = existingCheckout(run, ctx.env);
  if (hasRecordedPhase(run, ctx.env)) return run;
  if (!(await hasCommit(checkout, ctx.env))) {
    ctx.err(`nightqueue: ${checkout} has no commit to branch from, so the run works in the checkout without a worktree`);
    return run;
  }
  const log = (line) => ctx.err(`nightqueue: ${line}`);
  for (const slug of slugVariants(run.slug)) {
    if (!(await worktreeSlotFree({ projectId: run.projectId, slug, checkout, env: ctx.env, log }))) continue;
    const dir = runDir(run.projectId, slug, ctx.env);
    if (!claimRunDir(dir)) continue;
    const placed = await placeOnSlug(run, { slug, dir, checkout, ctx, log });
    if (placed) return placed;
  }
  throw new UserError(`no run slug from \`${run.slug}\` to \`${run.slug}-9\` has a free worktree slot and run directory; pass another \`--slug\``);
}
