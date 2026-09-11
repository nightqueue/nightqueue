import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { homeDir, runnerPidPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { writeRunnerPidfile } from "../../src/queue/pidfile.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CHILD_PID = 4242;

// A spawn double: it records every call and answers with a child that has a pid and can be unreferenced.
function fakeSpawn(calls, { pid = CHILD_PID, fail = null } = {}) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    if (fail) throw fail;
    return { pid, unref: () => calls.push({ unref: true }) };
  };
}

// The error the system raises for a pid that is gone.
function noSuchProcess(pid) {
  return Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
}

// A kill double: it answers for the pids the test says are alive, dies on SIGTERM and never signals a real process.
function fakeKill(alive) {
  return (pid, signal) => {
    if (!alive.has(pid)) throw noSuchProcess(pid);
    if (signal === "SIGTERM") alive.delete(pid);
    return true;
  };
}

// Runs the CLI in this process, with the spawn and the kill of the test injected.
async function runCli(env, argv, { calls = [], alive = new Set(), spawnImpl = null } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    spawnImpl: spawnImpl ?? fakeSpawn(calls),
    killImpl: fakeKill(alive),
  };
  const code = await run(argv, ctx);
  return { code, out, err, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

// A home with one registered project and one pending job, the queue every test of this file starts from.
function makeQueueHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

test("queue run starts the runner detached, hands it `--foreground` and comes back at once", async (t) => {
  const env = makeQueueHome(t, "detached-run");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  const ran = await runCli(env, ["queue", "run", "--job", String(id)], { calls });

  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout, `job #${id} started (pid ${CHILD_PID}) - follow with: nightshift queue log ${id} --follow`);
  const spawned = calls[0];
  assert.equal(spawned.file, process.execPath);
  assert.deepEqual(spawned.args.slice(1), ["queue", "run", "--foreground", "--job", String(id)]);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.stdio[0], "ignore");
  assert.equal(Number.isInteger(spawned.options.stdio[1]), true, "the runner writes its output somewhere other than a file");
  assert.deepEqual(calls[1], { unref: true }, "the parent never let go of the detached child");
  assert.equal(getJob(id, env).status, "pending", "the parent claimed the job instead of leaving it to the child");
});

test("a run with no single job drains the queue detached, and `--max` reaches the child", async (t) => {
  const env = makeQueueHome(t, "detached-cycle");
  const calls = [];

  const ran = await runCli(env, ["queue", "run", "--max", "2"], { calls });

  assert.equal(ran.code, 0, ran.stderr);
  assert.match(ran.stdout, /^runner started \(pid 4242\) - draining the queue until nothing is pending; follow with: nightshift queue status --follow/);
  assert.equal(ran.stdout.includes(join(homeDir(env), "logs")), true, `the runner logs outside the home: ${ran.stdout}`);
  assert.deepEqual(calls[0].args.slice(1), ["queue", "run", "--foreground", "--max", "2", "--drain"]);
  assert.equal(existsSync(runnerPidPath(env)), true, "the parent left the registration of the drain to a child that has not booted yet");
  const info = JSON.parse(readFileSync(runnerPidPath(env), "utf8"));
  assert.deepEqual(
    { pid: info.pid, mode: info.mode, jobId: info.jobId },
    { pid: CHILD_PID, mode: "drain", jobId: null },
    "the drain was registered under something other than the pid of the child that runs it",
  );
  assert.equal(typeof info.runtimeDir, "string", "the registration does not name the tree the runner loaded from");
});

test("queue add --run and queue retry --run start the same detached runner", async (t) => {
  const env = makeQueueHome(t, "detached-add-run");
  const calls = [];

  const added = await runCli(env, ["queue", "add", "alpha", "fix the worker", "--run"], { calls });

  assert.equal(added.code, 0, added.stderr);
  assert.match(added.stdout, /queued job #1 for project `alpha`/);
  assert.match(added.stdout, /job #1 started \(pid 4242\) - follow with: nightshift queue log 1 --follow/);
  assert.deepEqual(calls[0].args.slice(1), ["queue", "run", "--foreground", "--job", "1"]);

  const cancelled = await runCli(env, ["queue", "cancel", "1", "--reason", "not needed"]);
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const retried = await runCli(env, ["queue", "retry", "1", "--run"], { calls });
  assert.equal(retried.code, 0, retried.stderr);
  assert.match(retried.stdout, /job #1 started \(pid 4242\) - follow with: nightshift queue log 1 --follow/);
  assert.deepEqual(calls[2].args.slice(1), ["queue", "run", "--foreground", "--job", "1"]);
});

test("a spawn that fails exits 1 with its reason and never runs the job in this process instead", async (t) => {
  const env = makeQueueHome(t, "detached-spawn-fails");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  const ran = await runCli(env, ["queue", "run", "--job", String(id)], {
    spawnImpl: fakeSpawn(calls, { fail: new Error("no fork left") }),
  });

  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /nightshift: could not start the detached runner: no fork left/);
  assert.equal(ran.stdout, "", "the failed start still told the operator a runner was up");
  assert.equal(getJob(id, env).status, "pending", "the job moved even though no runner ever started");
});

test("a child that comes back without a pid is a refusal, not a runner nobody can find", async (t) => {
  const env = makeQueueHome(t, "detached-no-pid");
  const calls = [];

  const ran = await runCli(env, ["queue", "run"], { spawnImpl: fakeSpawn(calls, { pid: null }) });

  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /did not report a pid/);
});

test("queue run --watch registers the watcher in the pidfile and says how to stop it", async (t) => {
  const env = makeQueueHome(t, "detached-watch");
  const calls = [];

  const ran = await runCli(env, ["queue", "run", "--watch"], { calls });

  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout, "runner started (pid 4242, every 30 s) - stop with: nightshift queue run --stop");
  assert.deepEqual(calls[0].args.slice(1), ["queue", "run", "--foreground", "--watch", "30"]);
  const info = JSON.parse(readFileSync(runnerPidPath(env), "utf8"));
  assert.deepEqual(
    { pid: info.pid, mode: info.mode, intervalS: info.intervalS },
    { pid: CHILD_PID, mode: "watch", intervalS: 30 },
  );
  assert.match(info.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(info.logPath.startsWith(join(homeDir(env), "logs")), true);
});

test("a second watcher is refused while the first is alive, and a stale pidfile never blocks a start", async (t) => {
  const env = makeQueueHome(t, "detached-watch-guard");
  ensureHome(env);
  writeRunnerPidfile({ pid: CHILD_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const calls = [];

  const refused = await runCli(env, ["queue", "run", "--watch", "10"], { calls, alive: new Set([CHILD_PID]) });
  assert.equal(refused.code, 0, refused.stderr);
  assert.equal(refused.stdout, "runner already active (pid 4242, watch) - it will pick the job up");
  assert.deepEqual(calls, [], "the guard let a second watcher be spawned");

  const started = await runCli(env, ["queue", "run", "--watch", "10"], { calls });
  assert.equal(started.code, 0, started.stderr);
  assert.equal(started.stdout, "runner started (pid 4242, every 10 s) - stop with: nightshift queue run --stop");
  assert.equal(JSON.parse(readFileSync(runnerPidPath(env), "utf8")).intervalS, 10);
});

test("queue run --stop covers a live runner, a stale pidfile and no runner at all", async (t) => {
  const env = makeQueueHome(t, "detached-stop");

  const absent = await runCli(env, ["queue", "run", "--stop"]);
  assert.equal(absent.code, 0, absent.stderr);
  assert.equal(absent.stdout, "runner is not running");

  writeRunnerPidfile({ pid: CHILD_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const stale = await runCli(env, ["queue", "run", "--stop"]);
  assert.equal(stale.code, 0, stale.stderr);
  assert.equal(stale.stdout, "runner was not running (stale pidfile removed)");
  assert.equal(existsSync(runnerPidPath(env)), false);

  writeRunnerPidfile({ pid: CHILD_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const alive = new Set([CHILD_PID]);
  const stopped = await runCli(env, ["queue", "run", "--stop"], { alive });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(stopped.stdout, `runner stopped (pid ${CHILD_PID})`);
  assert.equal(existsSync(runnerPidPath(env)), false);
});

test("queue status opens with the state of the runner, in the table and in the json", async (t) => {
  const env = makeQueueHome(t, "detached-status");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);

  const stopped = await runCli(env, ["queue", "status"]);
  assert.equal(stopped.out[0], "runner: stopped", stopped.stderr);
  assert.equal(JSON.parse((await runCli(env, ["queue", "status", "--json"])).stdout).runner.running, false);

  const startedAt = "2026-09-08T21:04:11.000Z";
  writeRunnerPidfile({ pid: CHILD_PID, startedAt, mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const alive = new Set([CHILD_PID]);

  const table = await runCli(env, ["queue", "status"], { alive });
  assert.equal(table.out[0], `runner: running (pid ${CHILD_PID}, watch every 30 s, since ${startedAt})`);
  assert.match(table.stdout, /#1\s+○ pending\s+-\s+-\s+alpha/, "the runner line took the place of the table");

  const payload = JSON.parse((await runCli(env, ["queue", "status", "--json"], { alive })).stdout);
  assert.deepEqual(payload.runner, {
    running: true,
    pid: CHILD_PID,
    mode: "watch",
    jobId: null,
    intervalS: 30,
    startedAt,
    logPath: "/tmp/a.log",
    runtimeDir: null,
  });
  assert.equal(payload.jobs.length, 1);
  assert.equal(payload.counts.pending, 1);

  const empty = await runCli(makeQueueHome(t, "detached-status-empty"), ["queue", "status"]);
  assert.deepEqual(empty.out, ["runner: stopped", "no jobs in the queue"]);
});

test("`--foreground` never spawns anything, and `--dry` keeps reporting without a runner", async (t) => {
  const env = makeQueueHome(t, "detached-foreground");
  const calls = [];

  const dry = await runCli(env, ["queue", "run", "--dry"], { calls });
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /^paused {10}false/);

  const foreground = await runCli(env, ["queue", "run", "--foreground"], { calls });
  assert.equal(foreground.code, 0, foreground.stderr);
  assert.match(foreground.stdout, /nothing to run \(empty-queue\)/);
  assert.deepEqual(calls, [], "a foreground run spawned a detached runner anyway");
});
