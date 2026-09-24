import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const STATUS_LINE_RE = /^(PASSED|FAILED|SKIPPED) (\S+) (\d+\.\d+)s$/;
const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "nightqueue",
  GIT_AUTHOR_EMAIL: "nightqueue@example.invalid",
  GIT_COMMITTER_NAME: "nightqueue",
  GIT_COMMITTER_EMAIL: "nightqueue@example.invalid",
};

// Commits everything the fixture wrote, so the working tree the checks see is clean.
function commitAll(cwd) {
  execFileSync("git", ["-C", cwd, "add", "-A"]);
  execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"], { env: { ...process.env, ...GIT_IDENTITY } });
}

// The status of every check of the block, keyed by check name.
function statuses(stdout) {
  const entries = stdout.split("\n").filter((line) => STATUS_LINE_RE.test(line)).map((line) => STATUS_LINE_RE.exec(line));
  return new Map(entries.map((match) => [match[2], match[1]]));
}

// A workspace-root fixture: a root package.json declaring `workspaces` but no scripts of its own, and one member package that carries a real `test` script.
function makeMonorepoFixture(t) {
  const cwd = makeDir(t, "verify-monorepo");
  initGitRepo(cwd);
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "root", version: "1.0.0", private: true, workspaces: ["packages/*"] }, null, 2)}\n`);
  writeFileSync(join(cwd, "package-lock.json"), "");
  mkdirSync(join(cwd, "packages", "app"), { recursive: true });
  writeFileSync(join(cwd, "packages", "app", "package.json"), `${JSON.stringify({ name: "app", version: "1.0.0", scripts: { test: "node --test" } }, null, 2)}\n`);
  commitAll(cwd);
  return cwd;
}

// Runs `nightqueue verify` in the fixture as a real subprocess, with no fake package manager on PATH (the break needs none: detectChecks never even tries the workspace member).
function runVerify(t, cwd) {
  const env = makeHome(t, "verify-monorepo-caller");
  const result = spawnSync(process.execPath, [CLI, "verify"], { cwd, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `the CLI failed to spawn: ${result.error}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("a workspace root with no scripts of its own must not skip the `test` check when a member package carries a real test script", (t) => {
  const cwd = makeMonorepoFixture(t);

  const result = runVerify(t, cwd);

  const byName = statuses(result.stdout);
  assert.notEqual(byName.get("test"), "SKIPPED", `expected the workspace member's test script to be discovered and run, got:\n${result.stdout}`);
  assert.equal(result.code, 0, result.stderr);
});
