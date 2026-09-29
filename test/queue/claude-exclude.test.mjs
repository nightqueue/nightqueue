import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ensureClaudeExcluded, isClaudeLocalPath } from "../../src/queue/claude-exclude.mjs";
import { BLOCK_CODES, preflight } from "../../src/queue/preflight.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";

const EXCLUDE_LINES = "/.claude/worktrees/\n/.claude/settings.local.json\n";

// Git environment that reads nothing of the machine's own ignore rules, so only the repository decides what is ignored.
const ISOLATED_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.excludesFile",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

// Runs real git in the isolated environment, in the shape the helper and the preflight take.
function isolatedGit({ args, cwd }) {
  return execFileSync("git", args, { cwd, env: ISOLATED_GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// Runs a git command of the test itself inside a repository.
function git(repo, ...args) {
  return isolatedGit({ args, cwd: repo });
}

// A real repository with one commit and no ignore rule for `.claude/`.
function makeRepo(t, name) {
  return initGitRepo(makeDir(t, name));
}

// The local exclude file of a repository.
function excludeFile(repo) {
  return join(repo, ".git", "info", "exclude");
}

// Writes a file inside a repository, creating its directory.
function writeIn(repo, path, text = "x\n") {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
}

// Makes the `.git/info` of a repository read-only for the rest of the test, restoring it afterwards.
function freezeExclude(t, repo) {
  const info = join(repo, ".git", "info");
  mkdirSync(info, { recursive: true });
  if (!existsSync(excludeFile(repo))) writeFileSync(excludeFile(repo), "");
  chmodSync(excludeFile(repo), 0o444);
  chmodSync(info, 0o555);
  t.after(() => {
    chmodSync(info, 0o755);
    chmodSync(excludeFile(repo), 0o644);
  });
}

// Runs the real preflight of a job of the registered repository, with real git and a `claude` that is always found.
function preflightOf(env, projectName) {
  const job = { id: 1, project: projectName, project_id: ensureProject(env, projectName), prompt: "fix it" };
  return preflight({ job, env, gitImpl: isolatedGit, resolveBinImpl: () => ({ bin: "/bin/true", via: "test" }) });
}

const READ_ONLY_SKIP = typeof process.getuid === "function" && process.getuid() === 0 ? "root writes through a read-only mode" : false;

test("the allowed Claude Code paths are the worktrees directory and settings.local.json, nothing else under .claude/", () => {
  assert.equal(isClaudeLocalPath(".claude/worktrees/fix+x/"), true);
  assert.equal(isClaudeLocalPath(".claude/settings.local.json"), true);
  for (const path of [".claude/", ".claude/commands/x.md", ".claude/settings.json", ".claude/worktrees", "src/.claude/worktrees/x/"]) {
    assert.equal(isClaudeLocalPath(path), false, `${path} was allowed`);
  }
});

test("a repository without the rules gets both lines once, and a worktree plus settings.local.json leave git status empty", (t) => {
  const repo = makeRepo(t, "exclude-add");
  assert.deepEqual(ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit }), { status: "added", file: join(repo, ".git", "info", "exclude"), lines: ["/.claude/worktrees/", "/.claude/settings.local.json"] });
  assert.deepEqual(ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit }), { status: "covered" });
  assert.equal(readFileSync(excludeFile(repo), "utf8").split("\n").filter((line) => line.startsWith("/.claude/")).length, 2, "a second ensure duplicated a line");

  git(repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "x"), "-b", "x");
  writeIn(repo, ".claude/settings.local.json", "{}\n");
  assert.equal(git(repo, "status", "--porcelain"), "", "the canonical checkout is dirty after the pipeline's worktree");
  assert.equal(readFileSync(excludeFile(repo), "utf8").includes("\n.claude/\n"), false, "the whole .claude/ was ignored");
});

test("the preflight writes the exclude before its dirty check, so the first job's worktree never dirties the checkout", (t) => {
  const env = makeHome(t, "exclude-preflight");
  const repo = makeRepo(t, "exclude-preflight-repo");
  registerCheckout(env, { path: repo, name: "alpha" });
  assert.equal(preflightOf(env, "alpha").ok, true);
  git(repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "job-1"), "-b", "job-1");
  assert.equal(git(repo, "status", "--porcelain"), "");
  assert.equal(preflightOf(env, "alpha").ok, true, "the second job was blocked by the first job's worktree");
  const text = readFileSync(excludeFile(repo), "utf8");
  assert.equal(text.split("\n").filter((line) => line === "/.claude/worktrees/").length, 1, "two preflights wrote the line twice");
});

test("an exclude file with no trailing newline gets the lines on lines of their own", (t) => {
  const repo = makeRepo(t, "exclude-newline");
  writeFileSync(excludeFile(repo), "foo");
  ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit });
  ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit });
  assert.equal(readFileSync(excludeFile(repo), "utf8"), `foo\n${EXCLUDE_LINES}`);
});

test("only the line git does not already cover is appended", (t) => {
  const repo = makeRepo(t, "exclude-partial");
  writeFileSync(join(repo, ".gitignore"), ".claude/worktrees/\n");
  const outcome = ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit });
  assert.deepEqual(outcome.lines, ["/.claude/settings.local.json"]);
});

test("a .gitignore negation that wins over the exclude is reported as overridden and never duplicates the line", (t) => {
  const repo = makeRepo(t, "exclude-overridden");
  writeFileSync(join(repo, ".gitignore"), "!/.claude/worktrees/\n");
  assert.equal(ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit }).status, "added");
  assert.equal(ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit }).status, "overridden");
  assert.equal(readFileSync(excludeFile(repo), "utf8").split("\n").filter((line) => line === "/.claude/worktrees/").length, 1);
});

test("a git that does not answer check-ignore writes nothing and never throws", (t) => {
  const repo = makeDir(t, "exclude-unknown");
  const silent = () => {
    throw new Error("git is gone");
  };
  assert.deepEqual(ensureClaudeExcluded({ cwd: repo, gitImpl: silent }), { status: "unknown" });
  assert.equal(existsSync(join(repo, "info")), false);
});

test("a linked worktree used as the checkout writes to the exclude of the main repository", (t) => {
  const repo = makeRepo(t, "exclude-linked");
  const linked = join(makeDir(t, "exclude-linked-wt"), "wt");
  git(repo, "worktree", "add", "-q", linked, "-b", "linked");
  assert.equal(ensureClaudeExcluded({ cwd: linked, gitImpl: isolatedGit }).status, "added");
  assert.ok(readFileSync(excludeFile(repo), "utf8").endsWith(EXCLUDE_LINES), "the lines did not land in the main repository's exclude");
});

test("a read-only .git passes the preflight with only the allowed .claude/ paths untracked, and any other .claude/ path still blocks", { skip: READ_ONLY_SKIP }, (t) => {
  const env = makeHome(t, "exclude-readonly");
  const repo = makeRepo(t, "exclude-readonly-repo");
  registerCheckout(env, { path: repo, name: "alpha" });
  freezeExclude(t, repo);
  git(repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "x"), "-b", "x");
  writeIn(repo, ".claude/settings.local.json", "{}\n");
  assert.deepEqual(ensureClaudeExcluded({ cwd: repo, gitImpl: isolatedGit }).status, "unwritable");
  assert.equal(git(repo, "status", "--porcelain"), "?? .claude/\n", "git collapses the untracked .claude/ into one entry");

  assert.equal(preflightOf(env, "alpha").ok, true, "the allowed .claude/ paths blocked the job");

  writeIn(repo, ".claude/commands/x.md");
  const blocked = preflightOf(env, "alpha");
  assert.deepEqual({ ok: blocked.ok, code: blocked.code }, { ok: false, code: BLOCK_CODES.DIRTY_CHECKOUT });
  assert.match(blocked.message, /\(\.claude\/commands\/x\.md\)/);
});

test("a large untracked tree outside .claude/ is reported dirty-checkout, never missing-checkout", (t) => {
  const env = makeHome(t, "exclude-large-tree");
  const repo = makeRepo(t, "exclude-large-tree-repo");
  registerCheckout(env, { path: repo, name: "alpha" });
  const tree = join(repo, "vendor");
  mkdirSync(tree);
  const pad = "x".repeat(60);
  for (let index = 0; index < 20000; index += 1) writeFileSync(join(tree, `${pad}-${index}.txt`), "");
  const blocked = preflightOf(env, "alpha");
  assert.deepEqual({ ok: blocked.ok, code: blocked.code }, { ok: false, code: BLOCK_CODES.DIRTY_CHECKOUT });
  assert.match(blocked.message, /\(vendor\/\)/);
});

test("a tracked .claude/ file that was modified still blocks the preflight", (t) => {
  const env = makeHome(t, "exclude-tracked");
  const repo = makeRepo(t, "exclude-tracked-repo");
  registerCheckout(env, { path: repo, name: "alpha" });
  writeIn(repo, ".claude/settings.json", "{}\n");
  git(repo, "add", ".claude/settings.json");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "settings");
  writeIn(repo, ".claude/settings.json", '{"a":1}\n');
  const blocked = preflightOf(env, "alpha");
  assert.deepEqual({ ok: blocked.ok, code: blocked.code }, { ok: false, code: BLOCK_CODES.DIRTY_CHECKOUT });
  assert.match(blocked.message, /\.claude\/settings\.json/);
});
