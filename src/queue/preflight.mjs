import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectByName } from "../config/projects.mjs";
import { loadConfig } from "../config/store.mjs";
import { CLAUDE_MISSING_MESSAGE, resolveClaudeBin } from "./spawn.mjs";

// Every reason a job cannot start; the code is what the operator interface maps, never the message text.
export const BLOCK_CODES = {
  UNKNOWN_PROJECT: "unknown-project",
  MISSING_CHECKOUT: "missing-checkout",
  CLAUDE_MISSING: "claude-missing",
  DIRTY_CHECKOUT: "dirty-checkout",
  WRONG_BRANCH: "wrong-branch",
};

const GIT_TIMEOUT_MS = 5000;
const MAIN_BRANCHES = ["main", "master"];

// Reads git state of a checkout; the runner never runs a git command that changes anything.
export function defaultGitImpl({ args, cwd }) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] });
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

// Checks that the canonical checkout is clean, because the pipeline creates its worktree from it.
function checkCheckout(gitImpl, cwd) {
  const status = gitRead(gitImpl, cwd, ["status", "--porcelain"]);
  if (status === null) return blocked(BLOCK_CODES.MISSING_CHECKOUT, `\`git status\` failed in ${cwd}; the checkout is not usable`);
  if (status) return blocked(BLOCK_CODES.DIRTY_CHECKOUT, `${cwd} has uncommitted changes; commit or clean it before the queue runs`);
  const current = gitRead(gitImpl, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const expected = defaultBranch(gitImpl, cwd);
  if (current && current !== expected) {
    return blocked(BLOCK_CODES.WRONG_BRANCH, `${cwd} is on branch \`${current}\`, expected \`${expected}\``);
  }
  return { ok: true, cwd, branch: current ?? expected };
}

// Checks every precondition of a job before the spawn; a block returns the job to the queue, it is not an outcome.
export function preflight({ job, env = process.env, gitImpl = defaultGitImpl, existsImpl = existsSync, resolveBinImpl = resolveClaudeBin } = {}) {
  const name = String(job?.project ?? "");
  const project = projectByName(loadConfig(env, { warn: () => {} }), name);
  if (!project) return blocked(BLOCK_CODES.UNKNOWN_PROJECT, `unknown project \`${name}\`; register it with \`nightqueue project add\``);
  if (!existsImpl(project.path) || !existsImpl(join(project.path, ".git"))) {
    return blocked(BLOCK_CODES.MISSING_CHECKOUT, `checkout of \`${name}\` is missing at ${project.path}`);
  }
  if (!resolveBinImpl(env)?.bin) return blocked(BLOCK_CODES.CLAUDE_MISSING, CLAUDE_MISSING_MESSAGE);
  return checkCheckout(gitImpl, project.path);
}
