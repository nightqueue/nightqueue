import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { queuePausedPath } from "../../src/config/paths.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL, SLUG } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/shift.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function shift(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// Registers a real (and empty) git repository as a project of the home.
function makeGitProject(t, env, name) {
  const path = makeDir(t, `repo-${name}`);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path]);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// A home with a registered git project and the fake `claude` the runner will spawn.
function makeCliHome(t, name, attempts = [{ stdout: doneStream(), exitCode: 0 }]) {
  const env = makeHome(t, name);
  makeGitProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return env;
}

// Enqueues one job of the test project straight in the database.
function enqueue(env, prompt = "fix the worker") {
  return addJob({ project: "alpha", prompt }, env).id;
}

test("--help lists the queue commands next to the ones that were already there", (t) => {
  const env = makeCliHome(t, "cli-help");
  const result = shift(env, ["--help"]);
  assert.equal(result.status, 0);
  for (const line of ["queue add", "queue status", "queue run", "queue cancel", "queue pause", "queue log"]) {
    assert.ok(result.stdout.includes(line), `\`${line}\` is missing from the help`);
  }
});

test("queue add takes the registered NAME, never a path, and reports the job it queued", (t) => {
  const env = makeCliHome(t, "cli-add");
  const queued = shift(env, ["queue", "add", "alpha", "fix the worker", "--priority", "2", "--timeout", "600"]);
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /queued job #1 for project `alpha` \(priority 2, timeout 600s\)/);
  assert.equal(getJob(1, env).prompt, "fix the worker");

  const byPath = shift(env, ["queue", "add", "/tmp/alpha", "fix the worker"]);
  assert.equal(byPath.status, 1);
  assert.match(byPath.stderr, /pass the registered project NAME, not a path/);

  assert.equal(shift(env, ["queue", "add", "ghost", "fix it"]).status, 1);
  assert.match(shift(env, ["queue", "add", "alpha", "fix it", "--priority", "0"]).stderr, /`--priority` expects a positive integer/);
  assert.match(shift(env, ["queue", "add", "alpha"]).stderr, /missing argument; usage: shift queue add/);
});

test("queue status --json answers with the jobs and the counts, and never with the prompt", (t) => {
  const env = makeCliHome(t, "cli-status");
  const first = enqueue(env, "fix the worker");
  const second = enqueue(env, "fix the parser");

  const listed = shift(env, ["queue", "status", "--json"]);
  assert.equal(listed.status, 0, listed.stderr);
  const payload = JSON.parse(listed.stdout);
  assert.deepEqual(payload.jobs.map((job) => job.id), [second, first]);
  assert.equal("prompt" in payload.jobs[0], false, "the CLI printed the prompt of a job");
  assert.deepEqual(payload.counts, { pending: 2, running: 0, done: 0, gate: 0, failed: 0, cancelled: 0 });

  const one = JSON.parse(shift(env, ["queue", "status", String(first), "--json"]).stdout);
  assert.deepEqual({ id: one.job.id, status: one.job.status, project: one.job.project }, { id: first, status: "pending", project: "alpha" });
  assert.equal(JSON.parse(shift(env, ["queue", "status", "--limit", "1", "--json"]).stdout).jobs.length, 1);

  const table = shift(env, ["queue", "status"]);
  assert.match(table.stdout, /#1\s+pending\s+alpha/);
  assert.match(table.stdout, /pending=2/);
  assert.match(shift(env, ["queue", "status", "99"]).stderr, /unknown job `99`/);
});

test("the queue runs a job end to end: add, run, status and log", (t) => {
  const env = makeCliHome(t, "cli-smoke");
  assert.equal(shift(env, ["queue", "add", "alpha", "fix the worker"]).status, 0);

  const ran = shift(env, ["queue", "run", "--job", "1"]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /job #1 done https:\/\/github\.com\/acme\/api\/pull\/42/);

  const job = JSON.parse(shift(env, ["queue", "status", "1", "--json"]).stdout).job;
  assert.deepEqual({ status: job.status, pr: job.pr_url, slug: job.slug }, { status: "done", pr: PR_URL, slug: SLUG });
  assert.ok(job.notice_md, "the finished job kept no notice");

  const log = shift(env, ["queue", "log", "1"]);
  assert.equal(log.status, 0, log.stderr);
  assert.match(log.stdout, /=== attempt 1 @ /);
  assert.match(log.stdout, /"type":"result"/);
  assert.match(shift(env, ["queue", "log", "2"]).stderr, /no log for job `2`/);
});

test("queue run --dry only reports, and pause stops the claiming until resume", (t) => {
  const env = makeCliHome(t, "cli-pause");
  const id = enqueue(env);

  const dry = JSON.parse(shift(env, ["queue", "run", "--dry", "--json"]).stdout);
  assert.deepEqual(
    { dry: dry.dry, next: dry.next, active: dry.active, paused: dry.paused, heartbeatS: dry.heartbeatS },
    { dry: true, next: id, active: 0, paused: false, heartbeatS: 5 },
  );
  assert.match(shift(env, ["queue", "run", "--dry"]).stdout, /heartbeat {7}5s/, "the operator cannot see the heartbeat it can tune");
  assert.equal(getJob(id, env).status, "pending");

  assert.equal(shift(env, ["queue", "pause"]).status, 0);
  assert.equal(existsSync(queuePausedPath(env)), true);
  assert.match(shift(env, ["queue", "run"]).stdout, /nothing to run \(paused\)/);
  assert.equal(getJob(id, env).status, "pending");

  assert.equal(shift(env, ["queue", "resume"]).status, 0);
  assert.equal(existsSync(queuePausedPath(env)), false);
  assert.match(shift(env, ["queue", "run"]).stdout, /job #1 done/);
});

test("queue cancel takes a pending job and refuses one that is running under a live lease", (t) => {
  const env = makeCliHome(t, "cli-cancel");
  const pending = enqueue(env, "fix the worker");
  const running = enqueue(env, "fix the parser");
  claimJobById(running, { worker: "host:4242", cap: 4 }, env);

  const refused = shift(env, ["queue", "cancel", String(running)]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /is running with a live lease on worker `host:4242`/);
  assert.equal(getJob(running, env).status, "running");

  const cancelled = shift(env, ["queue", "cancel", String(pending), "--reason", "no longer needed"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled job #1/);
  assert.equal(getJob(pending, env).status, "cancelled");
  assert.match(shift(env, ["queue", "cancel", "99"]).stderr, /unknown job `99`/);
});

test("an unrecognized token is always an error, and never falls through to running the whole queue", (t) => {
  const env = makeCliHome(t, "cli-argv");
  const id = enqueue(env);

  const cases = [
    [["queue"], /unknown queue subcommand ``/],
    [["queue", "bogus"], /unknown queue subcommand `bogus`/],
    [["queue", "run", "--bogus"], /--bogus/],
    [["queue", "run", "--job", "abc"], /`--job` expects a positive integer/],
    [["queue", "run", "1"], /unexpected argument `1`/],
    [["queue", "status", "1", "2"], /unexpected argument `2`/],
    [["queue", "cancel"], /missing argument/],
  ];
  for (const [args, message] of cases) {
    const result = shift(env, args);
    assert.equal(result.status, 1, `\`${args.join(" ")}\` did not fail: ${result.stdout}`);
    assert.match(result.stderr, message);
    assert.equal(result.stdout, "", `\`${args.join(" ")}\` printed something on stdout`);
  }
  assert.equal(getJob(id, env).status, "pending", "a refused command still claimed a job");
});
