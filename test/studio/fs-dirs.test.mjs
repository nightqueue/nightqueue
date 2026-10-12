import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { listDirs, repoFacts } from "../../src/studio/fs-dirs.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { makeDir } from "../../test-support/memory.mjs";

// A temp HOME with plain folders, a dotfolder, a file, a git repository and a linked worktree of it, plus a temp dir outside it.
function fixtureHome(t) {
  const home = realpathSync(makeDir(t, "fs-home"));
  const outside = realpathSync(makeDir(t, "fs-outside"));
  mkdirSync(join(home, "Code", "plain"), { recursive: true });
  mkdirSync(join(home, ".hidden"));
  writeFileSync(join(home, "notes.txt"), "x");
  const repo = initGitRepo(join(home, "Code", "api"));
  execFileSync("git", ["-C", repo, "worktree", "add", "-q", "--detach", join(home, "Code", "api-wt")]);
  return { home, outside, repo, env: { HOME: home } };
}

// Asserts a listing call is refused with the given status and code.
function assertRefused(call, status, code) {
  assert.throws(call, (err) => err.status === status && err.code === code);
}

test("the default path is the home: dotfolders and files are skipped, and the home has no parent", (t) => {
  const { home, env } = fixtureHome(t);
  const listing = listDirs({ path: undefined, env });
  assert.equal(listing.path, home);
  assert.equal(listing.parent, null);
  assert.deepEqual(listing.entries.map((entry) => entry.name), ["Code"]);
  assert.equal(listing.truncated, false);
});

test("entries carry the git flag, the registered project and the main checkout of a linked worktree", (t) => {
  const { home, repo, env } = fixtureHome(t);
  const projects = [{ id: "p1", name: "api", path: repo }];
  const listing = listDirs({ path: join(home, "Code"), env, projects });
  assert.equal(listing.parent, home);
  const byName = Object.fromEntries(listing.entries.map((entry) => [entry.name, entry]));
  assert.deepEqual(Object.keys(byName), ["api", "api-wt", "plain"]);
  assert.deepEqual(byName.api, { name: "api", path: repo, git: true, registeredAs: { id: "p1", name: "api" } });
  assert.deepEqual(byName["api-wt"].worktreeOf, { path: repo, project: "api" });
  assert.equal(byName.plain.git, false);
});

test("`~/x` expands to the home", (t) => {
  const { home, env } = fixtureHome(t);
  assert.equal(listDirs({ path: "~/Code", env }).path, join(home, "Code"));
});

test("a path outside the home, a `..` escape and a symlink out of the home are 403; the symlink is not listed", (t) => {
  const { home, outside, env } = fixtureHome(t);
  symlinkSync(outside, join(home, "Code", "escape"));
  symlinkSync(join(home, "Code", "plain"), join(home, "Code", "inside-link"));
  assertRefused(() => listDirs({ path: outside, env }), 403, "outside-home");
  assertRefused(() => listDirs({ path: `${home}/..`, env }), 403, "outside-home");
  assertRefused(() => listDirs({ path: "~/../..", env }), 403, "outside-home");
  assertRefused(() => listDirs({ path: join(home, "Code", "escape"), env }), 403, "outside-home");
  const names = listDirs({ path: join(home, "Code"), env }).entries.map((entry) => entry.name);
  assert.equal(names.includes("escape"), false);
  assert.equal(names.includes("inside-link"), true);
});

test("a missing path is 404, a file is 422 and a relative path is a usage error", (t) => {
  const { home, env } = fixtureHome(t);
  assertRefused(() => listDirs({ path: join(home, "nope"), env }), 404, "not-found");
  assertRefused(() => listDirs({ path: join(home, "notes.txt"), env }), 422, "not-a-directory");
  assert.throws(() => listDirs({ path: "Code", env }), /not an absolute path/);
});

test("repo facts name the main checkout of a worktree, its branch and a suggested name; a plain folder is 422", async (t) => {
  const { home, repo, env } = fixtureHome(t);
  const facts = await repoFacts({ path: join(home, "Code", "api-wt"), env, store: null });
  assert.equal(facts.mainCheckout, repo);
  assert.deepEqual(facts.worktreeOf, { path: repo, project: null });
  assert.equal(facts.branch, "main");
  assert.equal(facts.origin, null);
  assert.deepEqual(facts.suggested, { name: "api", key: null });
  await assert.rejects(repoFacts({ path: join(home, "Code", "plain"), env, store: null }), (err) => err.code === "not-a-git-repo");
});
