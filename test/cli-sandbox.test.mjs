import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { makeDir } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const PROBE = fileURLToPath(new URL("../test-support/sandbox-probe.mjs", import.meta.url));

// Runs `nightqueue sandbox` as a real subprocess, with the given args after `sandbox` and env/cwd for the caller.
function runSandbox(t, args, { env, cwd } = {}) {
  const parentHome = makeDir(t, "sandbox-parent-home");
  const parentClaudeDir = makeDir(t, "sandbox-parent-claude");
  const baseEnv = {
    ...process.env,
    NIGHTQUEUE_HOME: parentHome,
    CLAUDE_CONFIG_DIR: parentClaudeDir,
    NIGHTQUEUE_SANDBOX_PROBE_OTHER: "kept-across-the-spawn",
    ...env,
  };
  const result = spawnSync(process.execPath, [CLI, "sandbox", ...args], { cwd, env: baseEnv, encoding: "utf8" });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, parentHome, parentClaudeDir };
}

// The probe's own JSON report, parsed out of the sandboxed command's stdout.
function probeReport(stdout) {
  const line = stdout.trim().split("\n").at(-1);
  return JSON.parse(line);
}

test("the wrapped command sees a throwaway home and host config that exist during the run, differ from the caller's and inherit the rest", (t) => {
  const cwd = makeDir(t, "sandbox-cwd");

  const result = runSandbox(t, [process.execPath, PROBE], { cwd });
  const report = probeReport(result.stdout);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(report.homeExists, true, "NIGHTQUEUE_HOME must exist while the command runs");
  assert.equal(report.claudeConfigDirExists, true, "CLAUDE_CONFIG_DIR must exist while the command runs");
  assert.notEqual(report.home, result.parentHome, "the sandbox must not hand the caller's own NIGHTQUEUE_HOME to the command");
  assert.notEqual(report.claudeConfigDir, result.parentClaudeDir, "the sandbox must not hand the caller's own CLAUDE_CONFIG_DIR");
  assert.equal(report.other, "kept-across-the-spawn", "an arbitrary env var must be inherited");
  assert.equal(realpathSync(report.cwd), realpathSync(cwd), "the current directory must be inherited");
  assert.equal(existsSync(report.home), false, "the throwaway NIGHTQUEUE_HOME must be gone once the command returns");
  assert.equal(existsSync(report.claudeConfigDir), false, "the throwaway CLAUDE_CONFIG_DIR must be gone once the command returns");
});

test("the child's own exit code and stderr pass through unchanged, and the throwaway home is still removed on failure", (t) => {
  const result = runSandbox(t, [process.execPath, PROBE, "7"], { env: { NIGHTQUEUE_SANDBOX_PROBE_STDERR: "boom from the child" } });
  const report = probeReport(result.stdout);

  assert.equal(result.code, 7, result.stderr);
  assert.match(result.stderr, /boom from the child/);
  assert.equal(existsSync(report.home), false, "the throwaway home must be removed even when the command fails");
  assert.equal(existsSync(report.claudeConfigDir), false, "the throwaway host config must be removed even when the command fails");
});

test("a flag of the wrapped command reaches it instead of being consumed by nightqueue", (t) => {
  const result = runSandbox(t, [process.execPath, "--version"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.version);
});

test("empty argv is a usage error", (t) => {
  const result = runSandbox(t, []);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /nightqueue sandbox <command> \[args\.\.\.\]/);
});

test("a command that cannot be spawned exits 127 with a message on stderr", (t) => {
  const result = runSandbox(t, ["nightqueue-sandbox-command-that-does-not-exist"]);

  assert.equal(result.code, 127);
  assert.match(result.stderr, /nightqueue-sandbox-command-that-does-not-exist/);
});
