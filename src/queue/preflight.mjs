import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_MISSING_MESSAGE, resolveClaudeBin } from "./spawn.mjs";
import { checkoutOfJob } from "../memory/registry-access.mjs";
import { canonicalPath, parseWorktreeList, sameDir } from "./worktree.mjs";

// Every reason a job cannot start; the code is what the operator interface maps, never the message text.
export const BLOCK_CODES = {
  UNKNOWN_PROJECT: "unknown-project",
  MISSING_CHECKOUT: "missing-checkout",
  CLAUDE_MISSING: "claude-missing",
  DIRTY_CHECKOUT: "dirty-checkout",
  WRONG_BRANCH: "wrong-branch",
  STORE_UNAVAILABLE: "store-unavailable",
};

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const MAIN_BRANCHES = ["main", "master"];
const HEADS = "refs/heads/";

// The one untracked path of a checkout that never makes it dirty: the per-machine settings Claude Code writes.
export const HOST_LOCAL_SETTINGS = ".claude/settings.local.json";

// Reads git state of a checkout; no git command changes anything.
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
  return isUntrackedClaude(entry) && entry.path.endsWith("/");
}

// Whether a status entry makes the checkout dirty; only the untracked host-local settings file does not.
function isBlockingEntry({ xy, path }) {
  return !(xy === "??" && path === HOST_LOCAL_SETTINGS);
}

// The paths of a `git status --porcelain -z` output that make the checkout dirty; only the untracked host-local settings file does not.
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

// Whether a status entry is an untracked directory, the only shape a linked worktree nested in the checkout takes.
function isUntrackedDir({ xy, path }) {
  return xy === "??" && path.endsWith("/");
}

// The linked worktrees git registers for the checkout, or none when git refused to list them.
function linkedWorktrees(gitImpl, cwd) {
  const listed = gitRaw(gitImpl, cwd, ["worktree", "list", "--porcelain"]);
  return listed === null ? [] : parseWorktreeList(listed).slice(1);
}

// The short name of a `refs/heads/...` ref, or null for anything else.
function shortBranchOf(ref) {
  return typeof ref === "string" && ref.startsWith(HEADS) ? ref.slice(HEADS.length) : null;
}

// The kind of one untracked directory: `owned` when it is the registered worktree an open job's state names on its branch, `linked` when git registers it and no open job names it, else `other`.
function untrackedDirKind({ path, cwd, linked, openWorktrees }) {
  const abs = canonicalPath(join(cwd, path.slice(0, -1)));
  const registered = linked.find((candidate) => sameDir(candidate.path, abs));
  if (!registered) return "other";
  const owner = openWorktrees.get(abs);
  if (owner === undefined) return "linked";
  return owner.branch === null || shortBranchOf(registered.branch) === owner.branch ? "owned" : "other";
}

// The kind of each untracked directory among the entries, git's worktree list read once and only when there is one.
function classifyUntrackedDirs({ gitImpl, cwd, entries, openWorktrees }) {
  const dirs = entries.filter(isUntrackedDir);
  if (!dirs.length) return new Map();
  const linked = linkedWorktrees(gitImpl, cwd);
  return new Map(dirs.map(({ path }) => [path, untrackedDirKind({ path, cwd, linked, openWorktrees })]));
}

// The dirty-checkout message, naming the first paths that make it dirty and saying which of them are linked worktrees no open job owns.
function dirtyMessage(cwd, paths, kinds) {
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  const linked = paths.filter((path) => kinds.get(path) === "linked").map((path) => ` (${path} is a linked worktree of this repository that no open job owns - an interactive session's or a leftover: finish it and remove it, or ignore it in the project's tracked .gitignore)`);
  return `${cwd} has uncommitted changes (${paths.slice(0, 3).join(", ")}${more}); commit or clean it before the queue runs${linked.join("")}`;
}

// Checks that the canonical checkout is clean, because the pipeline creates its worktree from it; the registered worktree an open job still names there is not dirt until the job closes.
function checkCheckout({ gitImpl, cwd, openWorktrees }) {
  const entries = readStatusEntries(gitImpl, cwd);
  if (entries === null) return blocked(BLOCK_CODES.MISSING_CHECKOUT, `\`git status\` failed in ${cwd}; the checkout is not usable`);
  const blocking = entries.filter(isBlockingEntry);
  const kinds = classifyUntrackedDirs({ gitImpl, cwd, entries: blocking, openWorktrees });
  const dirty = blocking.filter(({ path }) => kinds.get(path) !== "owned").map(({ path }) => path);
  if (dirty.length) return blocked(BLOCK_CODES.DIRTY_CHECKOUT, dirtyMessage(cwd, dirty, kinds));
  const current = gitRead(gitImpl, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const expected = defaultBranch(gitImpl, cwd);
  if (current && current !== expected) {
    return blocked(BLOCK_CODES.WRONG_BRANCH, `${cwd} is on branch \`${current}\`, expected \`${expected}\``);
  }
  return { ok: true, cwd, branch: current ?? expected };
}

// Checks every precondition of a job before the spawn; a block stops the job at a gate, it is not an outcome.
export function preflight({ job, env = process.env, gitImpl = defaultGitImpl, existsImpl = existsSync, resolveBinImpl = resolveClaudeBin, openWorktrees = new Map() } = {}) {
  const name = String(job?.project ?? "");
  const checkout = checkoutOfJob(job, env);
  const project = checkout ? { name, path: checkout } : null;
  if (!project) return blocked(BLOCK_CODES.UNKNOWN_PROJECT, `unknown project \`${name}\`; register it with \`nightqueue project add\``);
  if (!existsImpl(project.path) || !existsImpl(join(project.path, ".git"))) {
    return blocked(BLOCK_CODES.MISSING_CHECKOUT, `checkout of \`${name}\` is missing at ${project.path}`);
  }
  if (!resolveBinImpl(env)?.bin) return blocked(BLOCK_CODES.CLAUDE_MISSING, CLAUDE_MISSING_MESSAGE);
  return checkCheckout({ gitImpl, cwd: project.path, openWorktrees: openWorktrees instanceof Map ? openWorktrees : new Map() });
}
