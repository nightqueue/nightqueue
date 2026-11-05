import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { neutralGit, salvageRegistered, salvageUnreadable } from "../src/cli/doctor-salvage.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir } from "../test-support/memory.mjs";
import { git, publishedCheckout } from "../test-support/worktrees.mjs";

// The salvage seam over the real subprocess, shaped like doctor's command runner.
function run(file, args, options = {}) {
  const result = spawnSync(file, args, { encoding: "utf8", ...options });
  return { ok: !result.error && result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

// A clean real checkout whose config defines one hostile filter per name.
function checkoutWithFilters(t, name, filterNames) {
  const { checkout } = publishedCheckout(t, name);
  const marker = join(makeDir(t, `${name}-marker`), "ran");
  for (const filter of filterNames) git(["-C", checkout, "config", `filter.${filter}.clean`, `touch '${marker}'; cat`]);
  return { checkout, marker };
}

test("neutralGit blanks every configured filter, a name with dots or an equals sign included", (t) => {
  const { checkout, marker } = checkoutWithFilters(t, "salvage-names", ["a.b", "x=y"]);
  writeFileSync(join(checkout, ".gitattributes"), "*.txt filter=a.b\n*.md filter=x=y\n");
  writeFileSync(join(checkout, "one.txt"), "1\n");
  writeFileSync(join(checkout, "two.md"), "2\n");

  const neutral = neutralGit({ run, env: process.env, dir: checkout });
  const added = neutral.git(["add", "-A"]);

  assert.equal(added.ok, true, added.stderr);
  assert.equal(existsSync(marker), false, "a configured filter ran through the neutral runner");
});

test("neutralGit answers git's reason when the directory is not a git checkout", (t) => {
  const neutral = neutralGit({ run, env: process.env, dir: join(makeDir(t, "salvage-plain"), "missing") });
  assert.match(neutral.error, /^git config --list failed/);
});

test("salvageRegistered writes no directory for a clean worktree, and salvageUnreadable none for a bare .git link", (t) => {
  const { checkout } = publishedCheckout(t, "salvage-clean");
  const dest = join(makeDir(t, "salvage-clean-dest"), "out");
  const neutral = neutralGit({ run, env: process.env, dir: checkout });

  assert.deepEqual(salvageRegistered({ git: neutral.git, run, dir: checkout, dest }), { saved: [], dest: null });
  assert.equal(existsSync(dest), false);

  const linkOnly = join(makeDir(t, "salvage-link"), "dir");
  mkdirSync(linkOnly);
  writeFileSync(join(linkOnly, ".git"), "gitdir: /nowhere\n");
  assert.deepEqual(salvageUnreadable({ run, dir: linkOnly, dest }), { saved: [], dest: null });
});

test("salvageRegistered writes the patch, the untracked archive and head.txt of a dirty worktree", (t) => {
  const { checkout } = publishedCheckout(t, "salvage-dirty");
  writeFileSync(join(checkout, "-C"), "a name tar must not read as an option\n");
  const dest = join(makeDir(t, "salvage-dirty-dest"), "out");
  const neutral = neutralGit({ run, env: process.env, dir: checkout });

  const result = salvageRegistered({ git: neutral.git, run, dir: checkout, dest });

  assert.deepEqual(result, { saved: ["untracked.tar.gz"], dest });
  assert.match(run("tar", ["-tzf", join(dest, "untracked.tar.gz")]).stdout, /-C/);
  assert.match(readFileSync(join(dest, "head.txt"), "utf8"), /^branch main\nhead [0-9a-f]{40}\n$/);
});

// Salvages a checkout and answers the result with the entries of its archive.
function salvageListing(t, checkout, name) {
  const dest = join(makeDir(t, `${name}-dest`), "out");
  const neutral = neutralGit({ run, env: process.env, dir: checkout });
  const result = salvageRegistered({ git: neutral.git, run, dir: checkout, dest });
  const archive = join(dest, "untracked.tar.gz");
  const entries = existsSync(archive) ? run("tar", ["-tzf", archive]).stdout.split("\n").filter(Boolean) : [];
  return { result, entries };
}

test("salvageRegistered archives an ignored file but not a wholly ignored directory", (t) => {
  const { checkout } = publishedCheckout(t, "salvage-ignored");
  writeFileSync(join(checkout, ".gitignore"), ".env.local\nnode_modules/\n");
  git(["-C", checkout, "add", ".gitignore"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "ignore"]);
  writeFileSync(join(checkout, ".env.local"), "SECRET=1\n");
  mkdirSync(join(checkout, "node_modules"));
  writeFileSync(join(checkout, "node_modules", "dep.js"), "x\n");

  const { result, entries } = salvageListing(t, checkout, "salvage-ignored");

  assert.deepEqual(result.saved, ["untracked.tar.gz"], result.error);
  assert.ok(entries.includes("./.env.local"), entries.join("\n"));
  assert.ok(!entries.some((entry) => entry.includes("node_modules")), entries.join("\n"));
});

test("salvageRegistered archives a submodule with an uncommitted edit and skips a clean one", (t) => {
  const { checkout } = publishedCheckout(t, "salvage-submodule");
  const source = initGitRepo(join(makeDir(t, "salvage-sub-src"), "sub"));
  writeFileSync(join(source, "lib.txt"), "original\n");
  git(["-C", source, "add", "lib.txt"]);
  git(["-C", source, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "lib"]);
  for (const path of ["dirty", "clean"]) git(["-C", checkout, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, path]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "submodules"]);
  writeFileSync(join(checkout, "dirty", "lib.txt"), "uncommitted\n");

  const { result, entries } = salvageListing(t, checkout, "salvage-submodule");

  assert.deepEqual(result.saved, ["untracked.tar.gz"], result.error);
  assert.ok(entries.includes("./dirty/lib.txt"), entries.join("\n"));
  assert.ok(!entries.some((entry) => entry.startsWith("./clean")), entries.join("\n"));
});

test("salvageRegistered stores a unicode name with the bytes git reports", (t) => {
  const { checkout } = publishedCheckout(t, "salvage-unicode");
  const name = "café.txt";
  writeFileSync(join(checkout, name), "x\n");

  const { entries } = salvageListing(t, checkout, "salvage-unicode");

  assert.deepEqual(entries.map((entry) => Buffer.from(entry).toString("hex")), [Buffer.from(`./${name}`).toString("hex")]);
});
