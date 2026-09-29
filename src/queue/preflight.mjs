import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_MISSING_MESSAGE, resolveClaudeBin } from "./spawn.mjs";
import { ensureClaudeExcluded, isClaudeLocalPath } from "./claude-exclude.mjs";
import { checkoutOfJob } from "../memory/registry-access.mjs";

// Every reason a job cannot start; the code is what the operator interface maps, never the message text.
export const BLOCK_CODES = {
  UNKNOWN_PROJECT: "unknown-project",
  MISSING_CHECKOUT: "missing-checkout",
  CLAUDE_MISSING: "claude-missing",
  DIRTY_CHECKOUT: "dirty-checkout",
  WRONG_BRANCH: "wrong-branch",
};

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAIN_BRANCHES = ["main", "master"];

// Reads git state of a checkout; no git command changes anything, the only write is two lines of the local `.git/info/exclude`.
export function defaultGitImpl({ args, cwd }) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER_BYTES, stdio: ["ignore", "pipe", "ignore"] });
}

// A blocked preflight, with the code the runner writes into `result` and a message for the operator.
function blocked(code, message) {
  return { ok: false, code, message };
}

// Runs a read-only git command, returning its trimmed output or null when git refused to answer.
function gitRead(gitImpl, cwd, args) {
  try {
    return String(gitImpl({ args, cwd }) ?? "").trim();
  } catch {
    return null;
  }
}

// Default branch of the checkout, taken from origin/HEAD and falling back to `main`.
function defaultBranch(gitImpl, cwd) {
  const head = gitRead(gitImpl, cwd, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const suffix = head?.startsWith("origin/") ? head.slice("origin/".length) : "";
  return suffix || MAIN_BRANCHES[0];
}

// Runs a read-only git command, returning its untrimmed output or null when git refused to answer.
function gitRaw(gitImpl, cwd, args) {
  try {
    return String(gitImpl({ args, cwd }) ?? "");
  } catch {
    return null;
  }
}

// The entries of a `git status --porcelain -z` output, the second path of a rename or copy skipped.
function statusEntries(raw) {
  const tokens = String(raw ?? "").split("\0");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.trim()) continue;
    const xy = token.slice(0, 2);
    if (/[RC]/.test(xy)) index += 1;
    entries.push({ xy, path: token.slice(3).replace(/\n$/, "") });
  }
  return entries;
}

// Whether a status entry is an untracked path under `.claude/`.
function isUntrackedClaude({ xy, path }) {
  return xy === "??" && path.startsWith(".claude/");
}

// Whether a status entry is an untracked `.claude/` directory git collapsed, which may hide paths the filter must see.
function isCollapsedClaudeDir(entry) {
  return isUntrackedClaude(entry) && entry.path.endsWith("/") && !isClaudeLocalPath(entry.path);
}

// Whether a status entry makes the checkout dirty; an untracked Claude Code local path does not.
function isBlockingEntry({ xy, path }) {
  return !(xy === "??" && isClaudeLocalPath(path));
}

// The paths of a `git status --porcelain -z` output that make the checkout dirty; an untracked Claude Code local path does not.
export function blockingStatusPaths(raw) {
  return statusEntries(raw).filter(isBlockingEntry).map(({ path }) => path);
}

// The status entries of the checkout, untracked directories collapsed except under `.claude/`, or null when git refused to answer.
function readStatusEntries(gitImpl, cwd) {
  const outside = gitRaw(gitImpl, cwd, ["status", "--porcelain", "-z"]);
  if (outside === null) return null;
  const entries = statusEntries(outside);
  if (!entries.some(isCollapsedClaudeDir)) return entries;
  const inside = gitRaw(gitImpl, cwd, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ".claude/"]);
  if (inside === null) return null;
  return [...entries.filter((entry) => !isUntrackedClaude(entry)), ...statusEntries(inside).filter(isUntrackedClaude)];
}

// The dirty-checkout message, naming the first paths that make it dirty.
function dirtyMessage(cwd, paths) {
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `${cwd} has uncommitted changes (${paths.slice(0, 3).join(", ")}${more}); commit or clean it before the queue runs`;
}

// Checks that the canonical checkout is clean, because the pipeline creates its worktree from it.
function checkCheckout(gitImpl, cwd) {
  const entries = readStatusEntries(gitImpl, cwd);
  if (entries === null) return blocked(BLOCK_CODES.MISSING_CHECKOUT, `\`git status\` failed in ${cwd}; the checkout is not usable`);
  const dirty = entries.filter(isBlockingEntry).map(({ path }) => path);
  if (dirty.length) return blocked(BLOCK_CODES.DIRTY_CHECKOUT, dirtyMessage(cwd, dirty));
  const current = gitRead(gitImpl, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const expected = defaultBranch(gitImpl, cwd);
  if (current && current !== expected) {
    return blocked(BLOCK_CODES.WRONG_BRANCH, `${cwd} is on branch \`${current}\`, expected \`${expected}\``);
  }
  return { ok: true, cwd, branch: current ?? expected };
}

// Keeps the Claude Code local paths out of the checkout's git status; a failure of this step never blocks a job.
function ensureExcludeQuietly(ensureExcludeImpl, gitImpl, cwd) {
  try {
    ensureExcludeImpl({ cwd, gitImpl });
  } catch {
    return;
  }
}

// Checks every precondition of a job before the spawn; a block stops the job at a gate, it is not an outcome.
export function preflight({
  job,
  env = process.env,
  gitImpl = defaultGitImpl,
  existsImpl = existsSync,
  resolveBinImpl = resolveClaudeBin,
  ensureExcludeImpl = ensureClaudeExcluded,
} = {}) {
  const name = String(job?.project ?? "");
  const checkout = checkoutOfJob(job, env);
  const project = checkout ? { name, path: checkout } : null;
  if (!project) return blocked(BLOCK_CODES.UNKNOWN_PROJECT, `unknown project \`${name}\`; register it with \`nightqueue project add\``);
  if (!existsImpl(project.path) || !existsImpl(join(project.path, ".git"))) {
    return blocked(BLOCK_CODES.MISSING_CHECKOUT, `checkout of \`${name}\` is missing at ${project.path}`);
  }
  if (!resolveBinImpl(env)?.bin) return blocked(BLOCK_CODES.CLAUDE_MISSING, CLAUDE_MISSING_MESSAGE);
  ensureExcludeQuietly(ensureExcludeImpl, gitImpl, project.path);
  return checkCheckout(gitImpl, project.path);
}
