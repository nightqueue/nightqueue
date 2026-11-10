import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { worktreesDir } from "../config/paths.mjs";

export const CHAT_WORKTREE_ENV = "NIGHTQUEUE_CHAT_WORKTREE";

// The real path of an existing directory, or null when the path does not exist or is not a directory.
function realDirectory(path) {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// The worktree entry (`<worktreesDir>/<projectId>/<slug>`, real path) an absolute existing directory lies in, or null when it lies in none.
export function worktreeEntry(path, env = process.env) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  const target = realDirectory(path);
  const root = realDirectory(worktreesDir(env));
  if (target === null || root === null) return null;
  const parts = relative(root, target).split(sep);
  if (parts.length < 2 || parts[0] === ".." || parts[0] === "" || isAbsolute(parts[0])) return null;
  return join(root, parts[0], parts[1]);
}
