import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir, makeHome } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightshift.mjs", import.meta.url));
const FAKE_PM = fileURLToPath(new URL("../test-support/fake-pm.mjs", import.meta.url));
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

// A fixture repository declaring a `lint` check, the one check `nightshift verify` narrows to `--files` when it can.
function makeFixture(t) {
  const cwd = makeDir(t, "verify-files-ignored");
  initGitRepo(cwd);
  writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { lint: "eslint" } }, null, 2)}\n`);
  writeFileSync(join(cwd, "package-lock.json"), "");
  commitAll(cwd);
  return cwd;
}

// Installs the fake package manager, invoked through a generated shim (fake-pm.mjs itself is not chmod'd executable).
function installFakePm(t) {
  const dir = makeDir(t, "verify-files-ignored-pm");
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
function runVerify(t, cwd, args) {
  const pm = installFakePm(t);
  const env = makeHome(t, "verify-files-ignored-caller");
  env.PATH = `${pm.dir}:${env.PATH ?? ""}`;
  env.NIGHTSHIFT_FAKE_PM_LOG = pm.log;
  env.NIGHTSHIFT_FAKE_PM_SCRIPTS = JSON.stringify({ lint: { exit: 0 } });
  const result = spawnSync(process.execPath, [CLI, "verify", ...args], { cwd, env, encoding: "utf8" });
  assert.equal(result.error, undefined, `the CLI failed to spawn: ${result.error}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, calls: readCalls(pm.log) };
}

test("`--scope full --files <path>` either refuses the combination or says the flag was ignored, never silently drops it", (t) => {
  const cwd = makeFixture(t);

  const withoutFiles = runVerify(t, cwd, ["--scope", "full"]);
  const withFiles = runVerify(t, cwd, ["--scope", "full", "--files", "somefile.js"]);

  const lintCallArgs = withFiles.calls.find((call) => call.args.includes("lint"))?.args ?? [];
  assert.equal(lintCallArgs.includes("somefile.js"), false, "the file was not actually passed to the check either way");
  // A measured duration is not part of the verdict, so it is normalised before the blocks are compared.
  const withoutDurations = (block) => block.replace(/ \d+\.\d+s$/gm, " <duration>");
  assert.equal(
    withoutDurations(withFiles.stdout),
    withoutDurations(withoutFiles.stdout),
    "sanity: the printed block is identical with and without --files",
  );

  const flaggedIgnored = /--files/i.test(withFiles.stderr);
  const refused = withFiles.code !== 0;
  assert.ok(
    flaggedIgnored || refused,
    "nightshift verify must tell the caller --files was discarded under --scope full (stderr note) or refuse the combination (non-zero exit); it currently does neither and silently runs the full, unnarrowed scope",
  );
});
