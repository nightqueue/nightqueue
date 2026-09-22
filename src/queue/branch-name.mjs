// The branch name a worktree mangles the `<type>/<slug>` of a run into.
export const WORKTREE_BRANCH_PREFIX = "worktree-";

// A branch name as a comparable text: trimmed, or "" when it is absent or not text.
function branchText(name) {
  return typeof name === "string" ? name.trim() : "";
}

// The branch prefix of a run whose worktree name carried no `<type>` to restore, read from the task type the run recorded.
function branchPrefix(type) {
  return type === "bug/error" ? "fix" : "feat";
}

// The name the branch of a run is published under: the `<type>/<slug>` the worktree mangled, or the one the run itself recorded.
export function publishedBranchName(current, { type, slug } = {}) {
  if (!current.startsWith(WORKTREE_BRANCH_PREFIX)) return current;
  const mangled = current.slice(WORKTREE_BRANCH_PREFIX.length);
  const separator = mangled.indexOf("+");
  return separator > 0 ? `${mangled.slice(0, separator)}/${mangled.slice(separator + 1)}` : `${branchPrefix(type)}/${slug}`;
}

// The worktree form of a published `<type>/<slug>` name, or null when the name has no such shape.
function worktreeBranchName(name) {
  const separator = name.indexOf("/");
  if (separator <= 0 || separator === name.length - 1) return null;
  return `${WORKTREE_BRANCH_PREFIX}${name.slice(0, separator)}+${name.slice(separator + 1)}`;
}

// Every name one branch of a run may carry: itself, its published form and its worktree form; empty when there is no name.
export function branchAliases(name, { type, slug } = {}) {
  const text = branchText(name);
  if (!text) return [];
  const aliases = new Set([text]);
  if (text.startsWith(WORKTREE_BRANCH_PREFIX) && (text.includes("+") || branchText(slug))) {
    aliases.add(publishedBranchName(text, { type, slug }));
  }
  const worktree = worktreeBranchName(text);
  if (worktree) aliases.add(worktree);
  return [...aliases];
}

// Tells whether two names are the same branch of a run, before or after `run pr` renamed it; an absent name is never equal to anything.
export function sameBranch(a, b, hints = {}) {
  const left = branchAliases(a, hints);
  if (left.length === 0) return false;
  const right = branchAliases(b, hints);
  return right.some((name) => left.includes(name));
}
