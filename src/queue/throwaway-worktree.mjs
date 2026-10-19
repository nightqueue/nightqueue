const CLEANUP_TIMEOUT_MS = 15000;
export const WORKTREE_REMOVAL_MAX_MS = 2 * CLEANUP_TIMEOUT_MS + 5000;

// The first non-empty line of a text, or a placeholder naming its absence.
function firstLine(text) {
  return String(text ?? "").trim().split("\n")[0]?.trim() || "no output";
}

// Runs git through the deps, turning a throw into a failed answer.
async function gitQuietly(deps, args, options) {
  try {
    return await deps.git(args, options);
  } catch (err) {
    return { ok: false, stdout: "", stderr: err?.message ?? String(err) };
  }
}

// Removes a temporary directory; one left behind never fails the caller.
function removeDirQuietly(deps, dir) {
  try {
    deps.fs.removeDir(dir);
  } catch {
    return;
  }
}

// Creates a detached worktree of a ref in a fresh temporary directory, answering { dir } or { error } naming why it could not.
export async function addDetachedWorktree({ deps, checkout, ref, prefix, timeoutMs, signal }) {
  let dir = null;
  try {
    dir = deps.fs.makeTempDir(prefix);
  } catch (err) {
    return { error: `could not create a temporary directory: ${err?.message ?? String(err)}` };
  }
  const added = await gitQuietly(deps, ["worktree", "add", "--detach", dir, ref], { cwd: checkout, timeoutMs, signal });
  if (added?.ok) return { dir };
  await removeDetachedWorktree({ deps, checkout, dir });
  return { error: `git worktree add failed (${firstLine(added?.stderr)})` };
}

// Removes a throwaway worktree with every file inside it, each part best-effort, with its own short timeout and no signal.
export async function removeDetachedWorktree({ deps, checkout, dir }) {
  await gitQuietly(deps, ["worktree", "remove", "--force", dir], { cwd: checkout, timeoutMs: CLEANUP_TIMEOUT_MS });
  removeDirQuietly(deps, dir);
  await gitQuietly(deps, ["worktree", "prune"], { cwd: checkout, timeoutMs: CLEANUP_TIMEOUT_MS });
}
