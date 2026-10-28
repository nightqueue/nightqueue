// Directories the pipeline never commits from, whoever asked for it: the host's own configuration and the scratch space of the run.
export const NEVER_COMMITTED_DIRS = [".claude", "tmp"];

// Why the pipeline refuses to commit a path from a directory it never commits from, or null; the comparison folds the case, because the filesystem resolves `.Claude/hook.js` to the very `.claude/hook.js` this refusal exists for.
export function neverCommittedReason(path) {
  const segments = String(path ?? "").split("/").filter(Boolean).map((segment) => segment.toLowerCase());
  const directory = segments.find((segment) => NEVER_COMMITTED_DIRS.includes(segment));
  return directory ? `under \`${directory}/\`` : null;
}
