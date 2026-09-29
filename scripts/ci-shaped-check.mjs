#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const DEFAULT_TIMEOUT_S = 300;
const INSTALL_TIMEOUT_MS = 120000;

// Runs one command in `cwd` with its output on ours, and answers whether it succeeded.
function step({ command, args, cwd, env, timeoutMs }) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", timeout: timeoutMs });
  if (result.error) console.error(`ci-shaped-check: \`${command} ${args.join(" ")}\` did not finish: ${result.error.message}`);
  return result.status === 0;
}

// Clones the committed HEAD of the worktree into a fresh directory, so nothing uncommitted comes along.
function cloneHead(worktree, target, env) {
  return step({ command: "git", args: ["clone", "--quiet", worktree, target], cwd: tmpdir(), env, timeoutMs: INSTALL_TIMEOUT_MS });
}

// Makes the dependencies available offline: the worktree's node_modules by symlink, else `npm ci --offline`.
function linkDependencies({ worktree, clone, env }) {
  const modules = join(worktree, "node_modules");
  if (existsSync(modules)) {
    symlinkSync(modules, join(clone, "node_modules"));
    return true;
  }
  return step({ command: "npm", args: ["ci", "--offline"], cwd: clone, env, timeoutMs: INSTALL_TIMEOUT_MS });
}

// Runs the suite of the clone under the suite timeout, with HOME pointed at a fresh directory.
function runCheck({ worktree, timeoutS }) {
  const scratch = mkdtempSync(join(tmpdir(), "nq-ci-shaped-"));
  const clone = join(scratch, "repo");
  const env = { ...process.env, HOME: join(scratch, "home"), CI: "true" };
  try {
    if (!cloneHead(worktree, clone, env)) return "could not clone the HEAD of the worktree";
    if (!linkDependencies({ worktree, clone, env })) return "dependencies are not available offline";
    return step({ command: "npm", args: ["test"], cwd: clone, env, timeoutMs: timeoutS * 1000 }) ? null : "the suite failed in the clean clone";
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Entry point: `node scripts/ci-shaped-check.mjs [--worktree <path>] [--timeout-s <n>]`; exit 0 when the committed HEAD passes the suite alone.
function main() {
  const { values } = parseArgs({ options: { worktree: { type: "string" }, "timeout-s": { type: "string" } } });
  const timeoutS = Number(values["timeout-s"] ?? DEFAULT_TIMEOUT_S);
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    console.error("ci-shaped-check: --timeout-s must be a positive number");
    return 2;
  }
  const failure = runCheck({ worktree: resolve(values.worktree ?? process.cwd()), timeoutS });
  console.log(failure ? `CI-SHAPED: FAILED (${failure})` : "CI-SHAPED: PASSED");
  return failure ? 1 : 0;
}

process.exitCode = main();
