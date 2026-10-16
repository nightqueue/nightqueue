import path from "node:path";
import { UserError } from "../config/errors.mjs";

const FORBIDDEN_REF_TEXT = /[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|\/\.|\.lock(\/|$)/;

// A queued text trimmed, or null when it is absent or blank.
function trimmedOrNull(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new UserError(`expected a text starting point, got \`${String(value)}\``);
  return value.trim() === "" ? null : value.trim();
}

// Whether a name is a valid branch name by the rules of `git check-ref-format --branch`.
export function isValidBranchName(name) {
  if (typeof name !== "string" || name === "" || name === "@") return false;
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith(".")) return false;
  if (name.endsWith("/") || name.endsWith(".")) return false;
  return !FORBIDDEN_REF_TEXT.test(name);
}

// Requires a start branch, when given, to be a valid branch name.
function requireBranchName(name) {
  if (name === null || isValidBranchName(name)) return name;
  throw new UserError(`invalid start branch \`${name}\`; expected a valid git branch name`);
}

// Requires a start worktree, when given, to be an absolute path.
function requireAbsoluteWorktree(worktree) {
  if (worktree === null || path.isAbsolute(worktree)) return worktree;
  throw new UserError(`invalid start worktree \`${worktree}\`; expected an absolute path`);
}

// The starting point a job is queued with, checked by syntax only: a branch, a worktree, or neither.
export function startPoint({ startBranch, startWorktree } = {}) {
  const branch = trimmedOrNull(startBranch);
  const worktree = trimmedOrNull(startWorktree);
  if (branch !== null && worktree !== null) throw new UserError("give either a start branch or a start worktree, not both");
  return { startBranch: requireBranchName(branch), startWorktree: requireAbsoluteWorktree(worktree) };
}
