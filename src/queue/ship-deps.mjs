import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ghPrChecks, ghPrDetail, ghPrDiffNames, ghPrMerge } from "../host/gh.mjs";
import { runGitAsync } from "../host/git.mjs";
import { runNpmAsync } from "../host/npm.mjs";

export const SHIP_WORKER_ENV = "NIGHTSHIFT_SHIP_WORKER";

// Runs git with the ship's abort signal wired into the child, never rejecting.
function runGitSignalled(args, { cwd, timeoutMs, signal, env }) {
  const execFileImpl = (file, argv, options, callback) => execFile(file, argv, { ...options, signal }, callback);
  return runGitAsync({ args, cwd, env, timeoutMs, execFileImpl: signal ? execFileImpl : execFile });
}

// Waits the given time, ending early when the signal aborts.
export function sleep(ms, signal) {
  return new Promise((done) => {
    if (signal?.aborted) return done();
    const timer = setTimeout(finish, Math.max(0, ms));
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      done();
    }
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

// The `scripts.test` of the package.json of a directory, or null when there is none.
function readTestScript(dir) {
  try {
    const script = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))?.scripts?.test;
    return typeof script === "string" && script.trim() ? script : null;
  } catch {
    return null;
  }
}

// Links the checkout's node_modules into a throwaway worktree, when the checkout has one and the worktree has none.
function linkNodeModules(checkout, dir) {
  const source = join(checkout, "node_modules");
  const target = join(dir, "node_modules");
  if (!existsSync(source) || existsSync(target)) return false;
  symlinkSync(source, target, "dir");
  return true;
}

// The environment the ship's test suite runs in: the ship's own, without the lease token.
function testEnv(env) {
  const own = { ...env };
  delete own[SHIP_WORKER_ENV];
  return own;
}

// The real gh, git, npm and filesystem a ship works through; the only place a ship spawns anything.
export function defaultShipDeps(env = process.env) {
  return {
    git: (args, options = {}) => runGitSignalled(args, { ...options, env }),
    gh: {
      prDetail: (url, options = {}) => ghPrDetail(url, { ...options, env }),
      prChecks: (url, options = {}) => ghPrChecks(url, { ...options, env }),
      prMerge: (url, options = {}) => ghPrMerge(url, { ...options, env }),
      prDiffNames: (url, options = {}) => ghPrDiffNames(url, { ...options, env }),
    },
    fs: {
      exists: (path) => existsSync(path),
      makeTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      linkNodeModules,
      readTestScript,
    },
    runTest: ({ cwd, timeoutMs, signal }) => runNpmAsync(["test"], { cwd, env: testEnv(env), timeoutMs, signal }),
    sleep,
  };
}
