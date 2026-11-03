import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { frozenInstall } from "../src/cli/frozen-install.mjs";
import { stageable } from "../src/cli/run-publish.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome, makeProject } from "../test-support/memory.mjs";

// A git environment that depends on nothing of the machine: no global or system configuration, and an identity of its own.
function gitVars() {
  return {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "nightqueue",
    GIT_AUTHOR_EMAIL: "nightqueue@example.invalid",
    GIT_COMMITTER_NAME: "nightqueue",
    GIT_COMMITTER_EMAIL: "nightqueue@example.invalid",
  };
}

// A home with one registered project, the queue table ready and a git that reads no configuration of the host.
function makeQueue(t, name) {
  const env = { ...makeHome(t, name), ...gitVars() };
  makeProject(t, env, "alpha");
  return env;
}

// Writes a file of the repository, creating the directory it lives in.
function writeIn(repo, path, body = "content\n") {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
  return join(repo, path);
}

// A repository whose base branch carries a manifest and its lockfile, with the worktree then changing the files named in `changes`.
function repoWithLockedBase(t, name, changes) {
  const env = makeQueue(t, name);
  const repo = initGitRepo(makeDir(t, name));
  writeIn(repo, "package.json", '{"name":"x"}\n');
  writeIn(repo, "package-lock.json", "{}\n");
  writeIn(repo, "yarn.lock", "# yarn\n");
  execFileSync("git", ["-C", repo, "add", "."], { env: { ...process.env, ...env } });
  execFileSync("git", ["-C", repo, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base"], { env: { ...process.env, ...env } });
  for (const [path, body] of Object.entries(changes)) writeIn(repo, path, body);
  return { env, repo };
}

// An installer that records what it was asked and answers a fixed result, so no unit test installs from the network.
function fakeInstaller(result) {
  const calls = [];
  return { calls, install: (request) => (calls.push(request.manager), result) };
}

test("a publish set with a changed manifest, a changed lockfile and a green frozen install includes the lockfile", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-green", { "package.json": '{"name":"x","devDependencies":{"y":"1"}}\n', "package-lock.json": '{"y":1}\n' });
  const { install, calls } = fakeInstaller({ ok: true, command: "npm ci --ignore-scripts", tail: "" });

  const result = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });

  assert.deepEqual(result.refused, []);
  assert.deepEqual(result.paths, ["package.json", "package-lock.json"]);
  assert.deepEqual(calls, ["npm"]);
});

test("a changed manifest with an unchanged lockfile is refused with the manager's own install command, and no install runs", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-same", { "package.json": '{"name":"x","devDependencies":{"y":"1"}}\n' });
  const { install, calls } = fakeInstaller({ ok: true, command: "npm ci", tail: "" });

  const npm = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });
  assert.equal(npm.refused[0].reason, "manifest changed but the lockfile did not: run npm install");
  const yarn = stageable({ cwd: repo, listed: ["package.json", "yarn.lock"], extras: [], env, install });
  assert.equal(yarn.refused[0].reason, "manifest changed but the lockfile did not: run yarn install");
  assert.deepEqual(calls, []);
});

test("a changed lockfile without a changed manifest is refused as a dependency lockfile", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-alone", { "package-lock.json": '{"y":1}\n' });
  const { install, calls } = fakeInstaller({ ok: true, command: "npm ci", tail: "" });

  const alone = stageable({ cwd: repo, listed: ["package-lock.json"], extras: [], env, install });
  assert.deepEqual(alone.refused.map((entry) => entry.reason), ["a dependency lockfile"]);
  const unchangedManifest = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });
  assert.deepEqual(unchangedManifest.refused.map((entry) => entry.reason), ["a dependency lockfile"]);
  assert.deepEqual(calls, []);
});

test("a manifest and a lockfile whose frozen install fails are refused with the tail of the output", (t) => {
  const { env, repo } = repoWithLockedBase(t, "lock-red", { "package.json": '{"name":"x","dependencies":{"y":"1"}}\n', "package-lock.json": '{"y":1}\n' });
  const { install } = fakeInstaller({ ok: false, command: "npm ci --ignore-scripts", tail: "npm error missing: y@1 from lock file" });

  const result = stageable({ cwd: repo, listed: ["package.json", "package-lock.json"], extras: [], env, install });

  assert.deepEqual(result.paths, []);
  assert.equal(result.refused[0].reason, "`npm ci --ignore-scripts` failed: npm error missing: y@1 from lock file");
});

test("the frozen install of a yarn pair runs yarn, under the run's Bash default timeout, and reports pass, fail and the tail", (t) => {
  const env = makeHome(t, "frozen-install");
  const seen = [];
  const spawnWith = (result) => (file, args, options) => (seen.push({ file, args, cwd: options.cwd, timeout: options.timeout }), result);

  const green = frozenInstall({ manager: "yarn", cwd: "/w", env, spawnSyncImpl: spawnWith({ status: 0, stdout: "ok", stderr: "" }) });
  const red = frozenInstall({ manager: "pnpm", cwd: "/w", env, spawnSyncImpl: spawnWith({ status: 1, stdout: "", stderr: "a\nb\nERR_PNPM_OUTDATED_LOCKFILE\n" }) });
  const missing = frozenInstall({ manager: "bun", cwd: "/w", env, spawnSyncImpl: spawnWith({ status: null, error: { message: "spawn bun ENOENT" } }) });

  assert.equal(green.ok, true);
  assert.deepEqual(seen[0], { file: "yarn", args: ["install", "--frozen-lockfile", "--ignore-scripts"], cwd: "/w", timeout: 900000 });
  assert.deepEqual([red.ok, red.tail], [false, "a | b | ERR_PNPM_OUTDATED_LOCKFILE"]);
  assert.deepEqual([missing.ok, missing.tail], [false, "spawn bun ENOENT"]);
});
