import { statSync } from "node:fs";
import { join } from "node:path";

// Normalizes an indexed path to a path relative to the repository root, so worktrees share the same rows.
export function toRelativePath(path, repoRoot) {
  const raw = String(path ?? "").trim();
  if (!repoRoot || !raw.startsWith("/")) return raw.replace(/^\.\//, "");
  const root = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return raw.startsWith(root) ? raw.slice(root.length) : raw;
}

// Modification time of a file in milliseconds, or null when it is not there.
export function statMtime(absPath) {
  try {
    return Math.round(statSync(absPath).mtimeMs);
  } catch {
    return null;
  }
}

// Modification time of an indexed file under the repository root, or null without a root or a file.
export function indexedFileMtime(path, repoRoot) {
  const relative = toRelativePath(path, repoRoot);
  return repoRoot && relative ? statMtime(join(repoRoot, relative)) : null;
}

// The files of an index save, each carrying the modification time measured now, so a later replay never restats them.
export function withMeasuredMtimes(files, repoRoot) {
  return (Array.isArray(files) ? files : []).map((file) => ({ ...file, mtimeMs: indexedFileMtime(file?.path, repoRoot) }));
}
