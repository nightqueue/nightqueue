import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { getJob } from "../../src/memory/jobs.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

// Registers a real (and empty) git repository as a project of the home, the checkout `--run` needs to reach the fake `claude`.
function makeGitProject(t, env, name) {
  const path = makeDir(t, `repo-${name}`);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path]);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// A home with one registered git project and a fake `claude` that would answer if a run actually fired.
function makeCliHome(t, name) {
  const env = makeHome(t, name);
  const repo = makeGitProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), [{ stdout: doneStream(), exitCode: 0 }]);
  return { env, repo, planPath };
}

test("a prompt that only mentions --run without the -- escape never starts a job and keeps every word", (t) => {
  const { env, repo, planPath } = makeCliHome(t, "flag-swallow-run");
  const words = ["explain", "the", "--run", "flag", "to", "the", "team"];

  const added = runCli(env, ["queue", "add", ...words], { cwd: repo });

  assert.equal(added.status, 0, added.stderr);
  assert.equal(
    getJob(1, env).prompt,
    words.join(" "),
    "the persisted prompt lost a word the operator actually typed",
  );
  assert.equal(
    added.stdout.includes("running job"),
    false,
    "queue add ran the job in the foreground even though the operator never escaped --run with --",
  );
  assert.deepEqual(
    fakeCalls(planPath),
    [],
    "the fake claude was spawned even though --run inside the prompt was never meant as a flag",
  );
});

test("a prompt that only mentions --priority without the -- escape keeps the default priority and every word", (t) => {
  const { env, repo } = makeCliHome(t, "flag-swallow-priority");
  const words = ["remember", "to", "set", "--priority", "3", "as", "the", "default"];

  const added = runCli(env, ["queue", "add", ...words], { cwd: repo });

  assert.equal(added.status, 0, added.stderr);
  const job = getJob(1, env);
  assert.equal(
    job.prompt,
    words.join(" "),
    "the persisted prompt lost the words the operator actually typed",
  );
  assert.equal(
    job.priority,
    5,
    "the job priority silently changed even though the operator never meant to set --priority",
  );
});

test("--help is help only as the single argument of queue add; every other shape keeps today's meaning", (t) => {
  const { env, repo } = makeCliHome(t, "help-flag-collision");

  const midList = runCli(env, ["queue", "add", "explain", "the", "--help", "flag", "to", "me"], { cwd: repo });
  assert.equal(midList.status, 0, midList.stderr);
  assert.equal(getJob(1, env).prompt, "explain the --help flag to me", "a prompt mentioning --help lost a word");

  const quoted = runCli(env, ["queue", "add", "alpha", "fix the --help output"], { cwd: repo });
  assert.equal(quoted.status, 0, quoted.stderr);
  assert.equal(getJob(2, env).prompt, "fix the --help output");

  const bareToken = runCli(env, ["queue", "add", "help"], { cwd: repo });
  assert.equal(bareToken.status, 0, bareToken.stderr);
  assert.equal(getJob(3, env).prompt, "help", "the bare token `help` stopped being a prompt");

  const trailing = runCli(env, ["queue", "add", "alpha", "fix", "the", "--help"], { cwd: repo });
  assert.equal(trailing.status, 1, trailing.stdout);
  assert.match(trailing.stderr, /Unknown option '--help'/);

  const leading = runCli(env, ["queue", "add", "--help", "fix", "the", "worker"], { cwd: repo });
  assert.equal(leading.status, 1, leading.stdout);
  assert.match(leading.stderr, /Unknown option '--help'/);
});
