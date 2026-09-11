import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { getJob } from "../../src/memory/jobs.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

// Registers a real (and empty) git repository as a project of the home.
function makeGitProject(t, env, name) {
  const path = makeDir(t, `repo-${name}`);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path]);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// A home with a registered git project, the CWD `queue add` resolves the project from.
function makeCliHome(t, name) {
  const env = makeHome(t, name);
  const repo = makeGitProject(t, env, "alpha");
  return { env, repo };
}

// H1: `--tier` immediately followed by another recognized flag, with no real tier value typed in between.
// node:util's `parseArgs` refuses this as an ambiguous option argument instead of swallowing `--run` as the tier's
// value — the CLI names `--tier` as the culprit and suggests `--tier=-XYZ` to disambiguate, and queues nothing.
test("`queue add --tier --run \"...\"` refuses instead of swallowing `--run` as the tier value", (t) => {
  const { env, repo } = makeCliHome(t, "tier-swallow-h1");

  const result = runCli(env, ["queue", "add", "--tier", "--run", "fix thing"], { cwd: repo });

  assert.equal(result.status, 1, `expected a refusal, got: ${result.stdout}`);
  assert.match(result.stderr, /nightshift: Option '--tier' argument is ambiguous\./);
  assert.match(result.stderr, /Did you forget to specify the option argument for '--tier'\?/);
  assert.equal(getJob(1, env), null, "an ambiguous `--tier` still queued a job");
});
