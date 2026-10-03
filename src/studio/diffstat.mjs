import { existsSync } from "node:fs";
import { jobWorktreePath } from "../config/paths.mjs";
import { runGitAsync } from "../host/git.mjs";
import { isRunPath, readRunState } from "../queue/resume.mjs";

const GIT_TIMEOUT_MS = 5000;
const FALLBACK_BASES = ["origin/main", "origin/master", "main", "master"];
const RELEASED_NOTE = "worktree released — names from the run's result, no line counts";
const NONE_NOTE = "no worktree and no recorded files yet";
const MERGED_NOTE = "no change left against the base (already merged?) — names from the run's result, no line counts";
const SAFE_CONFIG = ["-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null"];

// Runs one read-only git command in the worktree, never taking the optional index lock nor running a repo-configured command.
function readGit(cwd, args, env) {
  return runGitAsync({ args: [...SAFE_CONFIG, ...args], cwd, env: { ...env, GIT_OPTIONAL_LOCKS: "0" }, timeoutMs: GIT_TIMEOUT_MS });
}

// The job's worktree on disk: the one its state.json records, else the runtime's default place; null when neither exists.
function worktreeOf(job, env) {
  const recorded = readRunState({ projectId: job?.project_id, slug: job?.slug, env })?.worktree;
  if (typeof recorded === "string" && recorded.trim() && existsSync(recorded.trim())) return recorded.trim();
  if (!isRunPath(job?.project_id, job?.slug)) return null;
  const fallback = jobWorktreePath(job.project_id, job.slug, env);
  return existsSync(fallback) ? fallback : null;
}

// The branch the job is compared with: origin's default branch, else the first of the usual names that exists.
async function baseOf(cwd, env) {
  const head = await readGit(cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], env);
  if (head.ok && head.stdout.trim()) return head.stdout.trim();
  for (const ref of FALLBACK_BASES) {
    if ((await readGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], env)).ok) return ref;
  }
  throw new Error(`no base branch (origin/HEAD, ${FALLBACK_BASES.join(", ")}) exists in ${cwd}`);
}

// The stdout of a git read, or an error naming the command and git's own reason.
async function gitOutput(cwd, args, env) {
  const answer = await readGit(cwd, args, env);
  if (!answer.ok) throw new Error(`git ${args[0]} failed: ${answer.stderr.trim() || "no reason given"}`);
  return answer.stdout;
}

// A count of `--numstat`, null for a binary file's `-`.
function countOf(text) {
  return /^\d+$/.test(text) ? Number(text) : null;
}

// The files of a `diff --numstat -z` output, one `{ path, added, deleted }` each.
function parseNumstat(stdout) {
  return stdout
    .split("\0")
    .map((entry) => /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry))
    .filter(Boolean)
    .map(([, added, deleted, path]) => ({ path, added: countOf(added), deleted: countOf(deleted) }));
}

// The sums of the counted lines, a binary or untracked file adding nothing.
function totalsOf(files) {
  return files.reduce((sum, file) => ({ added: sum.added + (file.added ?? 0), deleted: sum.deleted + (file.deleted ?? 0) }), { added: 0, deleted: 0 });
}

// The diffstat of a live worktree against the merge base with its base branch, the uncommitted edits and untracked files included.
async function worktreeDiffstat(cwd, env) {
  const base = await baseOf(cwd, env);
  const mergeBase = (await gitOutput(cwd, ["merge-base", base, "HEAD"], env)).trim();
  const changed = parseNumstat(await gitOutput(cwd, ["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "-z", mergeBase], env));
  const untracked = (await gitOutput(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], env))
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, added: null, deleted: null, untracked: true }));
  const files = [...changed, ...untracked];
  return { source: "worktree", base, files, totals: totalsOf(changed), note: null };
}

// The repo-relative files the finished run recorded in its result, an empty list when it has none.
function resultFiles(job) {
  try {
    const result = typeof job?.result === "string" ? JSON.parse(job.result) : job?.result;
    const files = Array.isArray(result?.files) ? result.files : [];
    return files.filter((path) => typeof path === "string" && path.trim());
  } catch {
    return [];
  }
}

// The names-only answer when no worktree can be read: the run's recorded files, or nothing.
function recordedDiffstat(job, note) {
  const files = resultFiles(job).map((path) => ({ path, added: null, deleted: null }));
  if (files.length === 0) return { source: "none", base: null, files: [], totals: null, note: note ?? NONE_NOTE };
  return { source: "recorded", base: null, files, totals: null, note: note ?? RELEASED_NOTE };
}

// The files a job touched with their line counts, read from its worktree without writing anything; names only once the worktree is gone.
export async function jobDiffstat(job, env = process.env) {
  const cwd = worktreeOf(job, env);
  if (!cwd) return recordedDiffstat(job, null);
  try {
    const live = await worktreeDiffstat(cwd, env);
    return live.files.length === 0 && resultFiles(job).length > 0 ? recordedDiffstat(job, MERGED_NOTE) : live;
  } catch (err) {
    return recordedDiffstat(job, `the worktree could not be read: ${err?.message ?? String(err)}`);
  }
}
