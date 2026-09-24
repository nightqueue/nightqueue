import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { initGitRepo } from "./git.mjs";
import { makeDir } from "./memory.mjs";

// A git environment that depends on nothing of the machine: no global or system configuration, and an identity of its own.
export function gitVars() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "nightqueue",
    GIT_AUTHOR_EMAIL: "nightqueue@example.invalid",
    GIT_COMMITTER_NAME: "nightqueue",
    GIT_COMMITTER_EMAIL: "nightqueue@example.invalid",
  };
}

// Runs git in the hermetic environment of the tests, never with the configuration of the host.
export function git(args) {
  return execFileSync("git", args, { encoding: "utf8", env: { ...process.env, ...gitVars() } });
}

// A checkout whose `main` is published to a local bare remote: a real git that never leaves the temp directory.
export function publishedCheckout(t, name) {
  const remote = join(makeDir(t, `${name}-origin`), "origin.git");
  git(["-c", "init.defaultBranch=main", "init", "--bare", "-q", remote]);
  const checkout = initGitRepo(makeDir(t, `${name}-checkout`));
  git(["-C", checkout, "remote", "add", "origin", remote]);
  git(["-C", checkout, "push", "-q", "-u", "origin", "main"]);
  return { remote, checkout };
}

// Adds a linked worktree under `<checkout>/.claude/worktrees/<name>` on a branch of its own, with one commit, pushed with `-u` unless the test says otherwise.
export function addWorktree(checkout, name, { push = true } = {}) {
  const path = join(checkout, ".claude", "worktrees", name);
  const branch = `worktree-${name}`;
  mkdirSync(join(checkout, ".claude", "worktrees"), { recursive: true });
  git(["-C", checkout, "worktree", "add", "-q", "-b", branch, path, "main"]);
  git(["-C", path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", `work of ${name}`]);
  if (push) git(["-C", path, "push", "-q", "-u", "origin", branch]);
  return { path, branch };
}

// Leaves an uncommitted file in a worktree.
export function makeDirty(path) {
  writeFileSync(join(path, "uncommitted.txt"), "work in progress\n");
}

// Locks a worktree the way a Claude Code session does, naming the pid that holds it.
export function lockWorktree(checkout, path, pid) {
  git(["-C", checkout, "worktree", "lock", "--reason", `claude agent agent-1 (pid ${pid})`, path]);
}

// A pid that belonged to a process which has already exited.
export function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

// The local branches of a checkout, by short name.
export function localBranches(checkout) {
  return git(["-C", checkout, "branch", "--list", "--format=%(refname:short)"]).split("\n").filter(Boolean);
}

// The linked worktrees git registers for a checkout, as the paths git prints.
export function registeredWorktrees(checkout) {
  return git(["-C", checkout, "worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .slice(1)
    .map((line) => line.slice("worktree ".length));
}
