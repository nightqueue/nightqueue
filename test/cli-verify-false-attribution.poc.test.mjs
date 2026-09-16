import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

// H2 (Group B): MISSING_DEPS_RE matches anywhere in combined stdout+stderr,
// so a check that legitimately fails on unrelated output containing the
// phrase "command not found" gets mislabeled "dependencies not installed"
// instead of reporting its real failure reason.

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));
const FAKE_PM = fileURLToPath(new URL("../test-support/fake-pm.mjs", import.meta.url));
const NEVER_INSTALLS = "dependencies not installed — nightshift verify never installs";
const REAL_FAILURE = 'FAIL: expected "command not found" in error output';
const STATUS_LINE_RE = /^(PASSED|FAILED|SKIPPED) (\S+) (\d+\.\d+)s$/;
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "nightshift",
  GIT_AUTHOR_EMAIL: "nightshift@example.invalid",
  GIT_COMMITTER_NAME: "nightshift",
  GIT_COMMITTER_EMAIL: "nightshift@example.invalid",
};

// Commits everything the fixture wrote, so the working tree the checks see is clean.
function commitAll(cwd) {
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"], { env: { ...process.env, ...GIT_IDENTITY } });
}

// A fixture repository: a real git repo carrying one package.json and its npm lockfile.
function makeFixture(t, name, { scripts = {} } = {}) {
  const cwd = makeDir(t, `verify-${name}`);
  initGitRepo(cwd);
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name, version: "1.0.0", scripts }, null, 2)}\n`);
  writeFileSync(join(cwd, "package-lock.json"), "");
  commitAll(cwd);
  return cwd;
}

// Installs the fake package manager under npm's name, on a directory of its own, plus the log the test reads back.
function installFakePm(t) {
  const dir = makeDir(t, "verify-pm");
  const shim = ["#!/usr/bin/env node", `import(${JSON.stringify(FAKE_PM)});`, ""].join("\n");
  writeFileSync(join(dir, "npm"), shim, { mode: 0o755 });
  return { dir, log: join(dir, "calls.jsonl") };
}

// The calls the fake package manager recorded, one per invocation.
function readCalls(log) {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// Runs `nightshift verify` in the fixture as a real subprocess, with the fake package manager first on PATH.
function runVerify(t, cwd, { outcomes = {}, args = [] } = {}) {
  const pm = installFakePm(t);
  const env = { ...makeHome(t, "verify-caller") };
  env.PATH = `${pm.dir}:${env.PATH ?? ""}`;
  env.NIGHTSHIFT_FAKE_PM_LOG = pm.log;
  env.NIGHTSHIFT_FAKE_PM_SCRIPTS = JSON.stringify(outcomes);
  const result = spawnSync(process.execPath, [CLI, "verify", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `the CLI failed to spawn: ${result.error}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, env, calls: readCalls(pm.log) };
}

// The status of every check of the block, keyed by check name.
function statuses(stdout) {
  const entries = stdout.split("\n").filter((line) => STATUS_LINE_RE.test(line)).map((line) => STATUS_LINE_RE.exec(line));
  return new Map(entries.map((match) => [match[2], match[1]]));
}

// The snippet lines printed under one check of the block.
function snippetOf(stdout, name) {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => STATUS_LINE_RE.exec(line)?.[2] === name);
  if (start === -1) return [];
  const snippet = [];
  for (const line of lines.slice(start + 1)) {
    if (STATUS_LINE_RE.test(line)) break;
    if (line.startsWith("  ")) snippet.push(line.slice(2));
  }
  return snippet;
}

test("a test script that fails on its own unrelated assertion, whose message happens to contain \"command not found\", is reported with its real failure reason, not the never-installed reason", (t) => {
  const cwd = makeFixture(t, "false-attribution", { scripts: { test: "node --test" } });
  const outcomes = { test: { stdout: REAL_FAILURE, exit: 1 } };

  const result = runVerify(t, cwd, { outcomes });

  assert.equal(statuses(result.stdout).get("test"), "FAILED");
  assert.equal(result.code, 1);
  const snippet = snippetOf(result.stdout, "test");
  assert.equal(snippet.includes(NEVER_INSTALLS), false, `expected the real failure reason, got: ${JSON.stringify(snippet)}`);
  assert.equal(snippet[0], REAL_FAILURE, `expected the check's own output as the reason, got: ${JSON.stringify(snippet)}`);
});
