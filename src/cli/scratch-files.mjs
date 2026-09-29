import { isAbsolute, join, relative } from "node:path";

const SCRATCH_NAME_RES = [/\.poc\./, /SCRATCH/, /-QA-/];

// Tells whether a repo-relative path is a QA scratch file by name: `*.poc.*`, `*SCRATCH*` or `*-QA-*`, case-sensitive so `src/qa.mjs` and `test/poc-helper.test.mjs` pass.
export function isScratchName(path) {
  return typeof path === "string" && SCRATCH_NAME_RES.some((pattern) => pattern.test(path));
}

// Tells whether a repo-relative path of the worktree lies under the run directory, when that directory is inside the worktree.
function isUnderRunDir(path, { cwd, runDir }) {
  if (!cwd || !runDir || !isAbsolute(runDir)) return false;
  const inside = relative(runDir, join(cwd, path));
  return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
}

// The paths among `paths` that are scratch: a scratch name, or a place under the run directory.
export function scratchFiles(paths, { cwd = null, runDir = null } = {}) {
  const list = Array.isArray(paths) ? paths : [];
  return list.filter((path) => isScratchName(path) || isUnderRunDir(path, { cwd, runDir }));
}
