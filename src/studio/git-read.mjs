import { existsSync } from "node:fs";
import { jobWorktreePath } from "../config/paths.mjs";
import { runGitAsync } from "../host/git.mjs";
import { isRunPath, readRunState } from "../queue/resume.mjs";

export const GIT_TIMEOUT_MS = 5000;
const FALLBACK_BASES = ["origin/main", "origin/master", "main", "master"];
const SAFE_CONFIG = ["-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

// Runs one read-only git command in the worktree, never taking the optional index lock nor running a repo-configured command.
export function readGit(cwd, args, env) {
  return runGitAsync({ args: [...SAFE_CONFIG, ...args], cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: GIT_TIMEOUT_MS });
}

// The stdout of a git read, or an error naming the command and git's own reason.
export async function gitOutput(cwd, args, env) {
  const answer = await readGit(cwd, args, env);
  if (!answer.ok) throw new Error(`git ${args[0]} failed: ${answer.stderr.trim() || "no reason given"}`);
  return answer.stdout;
}

// The job's worktree on disk: the one its state.json records, else the runtime's default place; null when neither exists.
export function worktreeOf(job, env) {
  const recorded = readRunState({ projectId: job?.project_id, slug: job?.slug, env })?.worktree;
  if (typeof recorded === "string" && recorded.trim() && existsSync(recorded.trim())) return recorded.trim();
  if (!isRunPath(job?.project_id, job?.slug)) return null;
  const fallback = jobWorktreePath(job.project_id, job.slug, env);
  return existsSync(fallback) ? fallback : null;
}

// The branch the job is compared with: origin's default branch, else the first of the usual names that exists.
export async function baseOf(cwd, env) {
  const head = await readGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], env);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const ref of FALLBACK_BASES) {
    if ((await readGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], env)).ok) return ref;
  }
  throw new Error(`no base branch (origin/HEAD, ${FALLBACK_BASES.join(", ")}) exists in ${cwd}`);
}
