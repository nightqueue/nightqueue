import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { queuePausedPath } from "../../src/config/paths.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, gateStream, PR_URL, SLUG } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/shift.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function shift(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
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

// Path of the registered project of a home, the directory a `queue add` without project runs from.
function projectPath(env) {
  return loadConfig(env, { warn: () => {} }).projects.alpha.path;
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

test("queue add --help prints the job-cutting rule and the example, and enqueues nothing", (t) => {
  const env = makeCliHome(t, "cli-add-help");
  for (const flag of ["--help", "-h"]) {
    const helped = shift(env, ["queue", "add", flag]);
    assert.equal(helped.status, 0, helped.stderr);
    assert.ok(helped.stdout.includes("shift queue add [project] <prompt...>"), `\`${flag}\` did not print the usage line`);
    assert.ok(helped.stdout.includes("self-contained deliverable"), `\`${flag}\` did not print the rule`);
    assert.ok(helped.stdout.includes("numbered stages"), `\`${flag}\` did not print the rule`);
    assert.ok(
      helped.stdout.includes('shift queue add "Self-contained install. Stages: 1) runtime under ~/.nightshift;'),
      `\`${flag}\` did not print the example`,
    );
  }
  assert.equal(getJob(1, env), null, "the help enqueued a job");

  const queued = shift(env, ["queue", "add", "alpha", "fix the worker"], { cwd: makeDir(t, "cli-add-help-outside") });
  assert.equal(queued.status, 0, queued.stderr);
  assert.equal(getJob(1, env).prompt, "fix the worker");
});

test("queue add takes the registered NAME and reports the job it queued", (t) => {
  const env = makeCliHome(t, "cli-add");
  const outside = makeDir(t, "cli-add-outside");
  const queued = shift(env, ["queue", "add", "alpha", "fix the worker", "--priority", "2", "--timeout", "600"], { cwd: outside });
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /queued job #1 for project `alpha` \(priority 2, timeout 600s\)/);
  assert.equal(getJob(1, env).prompt, "fix the worker");

  const byPath = shift(env, ["queue", "add", "/tmp/alpha", "fix the worker"], { cwd: outside });
  assert.equal(byPath.status, 1);
  assert.match(byPath.stderr, /no project registered for .*; run `shift init` here, or pass the project NAME/);

  assert.equal(shift(env, ["queue", "add", "ghost", "fix it"], { cwd: outside }).status, 1);
  assert.match(shift(env, ["queue", "add", "alpha", "fix it", "--priority", "0"]).stderr, /`--priority` expects a positive integer/);
  assert.match(shift(env, ["queue", "add", "alpha"]).stderr, /missing argument; usage: shift queue add/);
});

test("queue add without a project takes the one of the current directory and joins the words of the prompt", (t) => {
  const env = makeCliHome(t, "cli-add-cwd");
  const repo = projectPath(env);
  const queued = shift(env, ["queue", "add", "fix", "the", "flaky", "worker"], { cwd: repo });
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /project `alpha` resolved from the current directory/);
  assert.match(queued.stdout, /queued job #1 for project `alpha`/);
  assert.equal(getJob(1, env).prompt, "fix the flaky worker");

  const escaped = shift(env, ["queue", "add", "--", "explain", "--run", "to", "me"], { cwd: repo });
  assert.equal(escaped.status, 0, escaped.stderr);
  assert.equal(getJob(2, env).prompt, "explain --run to me");
  assert.equal(escaped.stdout.includes("running job"), false, "a prompt that mentions --run ran the job");
});

test("queue add --run runs the job in the foreground and answers with its outcome", (t) => {
  const env = makeCliHome(t, "cli-add-run");
  const ran = shift(env, ["queue", "add", "alpha", "fix the worker", "--run"]);
  assert.equal(ran.status, 0, ran.stderr);
  assert.ok(
    ran.stdout.indexOf("queued job #1") < ran.stdout.indexOf("running job #1"),
    "the id has to be printed before the job runs",
  );
  assert.match(ran.stdout, /running job #1 in the foreground; follow the stream with `shift queue log 1 --follow`/);
  assert.match(ran.stdout, /job #1 done https:\/\/github\.com\/acme\/api\/pull\/42/);
  assert.equal(getJob(1, env).status, "done");
});

test("queue add --run exits 1 on any outcome other than done, and when the job never started", (t) => {
  const env = makeCliHome(t, "cli-add-run-gate", [{ stdout: gateStream(), exitCode: 0 }]);
  const gated = shift(env, ["queue", "add", "alpha", "fix the worker", "--run"]);
  assert.equal(gated.status, 1, gated.stdout);
  assert.match(gated.stdout, /job #1 gate/);
  assert.equal(getJob(1, env).status, "gate");

  claimJobById(addJob({ project: "alpha", prompt: "hold the only slot" }, env).id, { worker: "host:4242", cap: 4 }, env);
  const busy = shift(env, ["queue", "add", "alpha", "fix the parser", "--run"]);
  assert.equal(busy.status, 1, busy.stdout);
  assert.match(busy.stdout, /job #3 did not start \(project-busy\); it stays in the queue/);
  assert.equal(getJob(3, env).status, "pending");
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

test("queue cancel closes a gated job and the status still shows it with its note", (t) => {
  const env = makeCliHome(t, "cli-cancel-gate", [{ stdout: gateStream(), exitCode: 0 }]);
  const gated = shift(env, ["queue", "add", "alpha", "fix the worker", "--run"]);
  assert.equal(gated.status, 1, gated.stdout);
  assert.equal(getJob(1, env).status, "gate");
  const finishedAt = getJob(1, env).finished_at;

  const cancelled = shift(env, ["queue", "cancel", "1", "--reason", "the human said no"]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled job #1/);

  const row = getJob(1, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.finished_at, finishedAt, "the cancel overwrote the finish of the gated run");
  assert.equal(row.operator_note, "the human said no");
  assert.equal(JSON.parse(row.result).cancelledFrom, "gate");

  const status = shift(env, ["queue", "status", "1"]);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /status\s+cancelled/);
  assert.match(status.stdout, /operator_note\s+the human said no/);
});

test("queue cancel without --reason closes a gated job and keeps the note it already had", (t) => {
  const env = makeCliHome(t, "cli-cancel-note");
  const id = enqueue(env);
  openDb(env)
    .prepare("UPDATE jobs SET status = 'gate', finished_at = ?, operator_note = ? WHERE id = ?")
    .run("2020-01-01 00:00:00", "the human asked for changes", id);

  const cancelled = shift(env, ["queue", "cancel", String(id)]);
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.match(cancelled.stdout, /cancelled job #1/);

  const row = getJob(id, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.operator_note, "the human asked for changes", "the cancel without --reason erased the note of the gate");
  assert.equal(row.finished_at, "2020-01-01 00:00:00", "the cancel overwrote the finish of the gated run");
  assert.equal(JSON.parse(row.result).cancelledFrom, "gate");
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
