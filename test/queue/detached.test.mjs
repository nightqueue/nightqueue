import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { homeDir, runnerRegistryPath, runnersDir } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CHILD_PID = 4242;
const LIVE_PID = 5151;

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
  assert.equal(existsSync(runnerRegistryPath(CHILD_PID, env)), true, "the parent left the registration of the drain to a child that has not booted yet");
  const info = JSON.parse(readFileSync(runnerRegistryPath(CHILD_PID, env), "utf8"));
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

test("queue run --watch registers the watcher in the registry and says how to stop it", async (t) => {
  const env = makeQueueHome(t, "detached-watch");
  const calls = [];

  const ran = await runCli(env, ["queue", "run", "--watch"], { calls });

  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.stdout, "runner started (pid 4242, every 30 s) - stop with: nightshift queue run --stop");
  assert.deepEqual(calls[0].args.slice(1), ["queue", "run", "--foreground", "--watch", "30"]);
  const info = JSON.parse(readFileSync(runnerRegistryPath(CHILD_PID, env), "utf8"));
  assert.deepEqual(
    { pid: info.pid, mode: info.mode, intervalS: info.intervalS },
    { pid: CHILD_PID, mode: "watch", intervalS: 30 },
  );
  assert.match(info.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(info.logPath.startsWith(join(homeDir(env), "logs")), true);
});

test("a second watcher starts beside the first, and a stale registration never blocks a start", async (t) => {
  const env = makeQueueHome(t, "detached-watch-second");
  ensureHome(env);
  writeRunnerRecord({ pid: LIVE_PID, startedAt: "2026-09-08T21:00:00.000Z", mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const calls = [];

  const second = await runCli(env, ["queue", "run", "--watch", "10"], { calls, alive: new Set([LIVE_PID]) });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, "runner started (pid 4242, every 10 s) - stop with: nightshift queue run --stop");
  assert.equal(calls.length > 0, true, "the second watcher was never spawned");
  assert.equal(existsSync(runnerRegistryPath(LIVE_PID, env)), true, "the start cleared the registration of the live runner");
  assert.equal(JSON.parse(readFileSync(runnerRegistryPath(CHILD_PID, env), "utf8")).intervalS, 10);

  const listed = await runCli(env, ["queue", "status"], { alive: new Set([LIVE_PID, CHILD_PID]) });
  assert.deepEqual(
    listed.out.slice(0, 2).map((line) => line.split(",")[0]),
    [`runner: running (pid ${LIVE_PID}`, `runner: running (pid ${CHILD_PID}`],
    listed.stdout,
  );

  const third = await runCli(env, ["queue", "run", "--watch", "10"], { calls });
  assert.equal(third.code, 0, third.stderr);
  assert.equal(existsSync(runnerRegistryPath(LIVE_PID, env)), false, "the start left a registration no process answers for");
});

test("queue run --stop ends every registered runner, `--stop <pid>` ends one, and an unknown pid is refused", async (t) => {
  const env = makeQueueHome(t, "detached-stop");

  const absent = await runCli(env, ["queue", "run", "--stop"]);
  assert.equal(absent.code, 0, absent.stderr);
  assert.equal(absent.stdout, "runner is not running");

  writeRunnerRecord({ pid: CHILD_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  const stale = await runCli(env, ["queue", "run", "--stop"]);
  assert.equal(stale.code, 0, stale.stderr);
  assert.equal(stale.stdout, "runner was not running (stale registration removed)");
  assert.equal(existsSync(runnerRegistryPath(CHILD_PID, env)), false);

  writeRunnerRecord({ pid: CHILD_PID, startedAt: "2026-09-08T21:00:00.000Z", mode: "watch", intervalS: 30, logPath: "/tmp/a.log" }, env);
  writeRunnerRecord({ pid: LIVE_PID, startedAt: "2026-09-08T21:01:00.000Z", mode: "drain", intervalS: null, logPath: null }, env);
  const alive = new Set([CHILD_PID, LIVE_PID]);
  const one = await runCli(env, ["queue", "run", "--stop", String(CHILD_PID)], { alive });
  assert.equal(one.code, 0, one.stderr);
  assert.equal(one.stdout, `runner stopped (pid ${CHILD_PID})`);
  assert.equal(existsSync(runnerRegistryPath(CHILD_PID, env)), false);
  assert.equal(existsSync(runnerRegistryPath(LIVE_PID, env)), true, "stopping one runner ended the other one too");

  const unknown = await runCli(env, ["queue", "run", "--stop", "999999"], { alive });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /no runner is registered with pid 999999/);

  const all = await runCli(env, ["queue", "run", "--stop"], { alive });
  assert.equal(all.code, 0, all.stderr);
  assert.equal(all.stdout, `runner stopped (pid ${LIVE_PID})`);
  assert.equal(existsSync(runnerRegistryPath(LIVE_PID, env)), false);
});

test("queue status opens with one line per live runner, in the table and in the json", async (t) => {
  const env = makeQueueHome(t, "detached-status");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);

  const stopped = await runCli(env, ["queue", "status"]);
  assert.equal(stopped.out[0], "runner: stopped", stopped.stderr);
  const none = JSON.parse((await runCli(env, ["queue", "status", "--json"])).stdout);
  assert.equal(none.runner.running, false);
  assert.deepEqual(none.runners, []);

  const startedAt = "2026-09-08T21:04:11.000Z";
  writeRunnerRecord({ pid: CHILD_PID, startedAt, mode: "watch", intervalS: 30, logPath: "/tmp/a.log", detached: true }, env);
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
    detached: true,
  });
  assert.deepEqual(payload.runners, [payload.runner], "the deprecated `runner` key is not the first entry of `runners`");
  assert.equal(payload.jobs.length, 1);
  assert.equal(payload.counts.pending, 1);

  writeRunnerRecord({ pid: LIVE_PID, startedAt: "2026-09-08T21:05:00.000Z", mode: "drain", intervalS: null, logPath: null, detached: false }, env);
  const two = JSON.parse((await runCli(env, ["queue", "status", "--json"], { alive: new Set([CHILD_PID, LIVE_PID]) })).stdout);
  assert.deepEqual(two.runners.map((runner) => runner.pid), [CHILD_PID, LIVE_PID]);
  assert.deepEqual(two.runner, two.runners[0], "the alias stopped naming the first registered runner");

  const foreground = await runCli(env, ["queue", "status"], { alive: new Set([LIVE_PID]) });
  assert.match(foreground.out[0], new RegExp(`^runner: running \\(pid ${LIVE_PID}, drain, foreground, since `), foreground.stdout);

  const empty = await runCli(makeQueueHome(t, "detached-status-empty"), ["queue", "status"]);
  assert.deepEqual(empty.out, ["runner: stopped", "no jobs in the queue"]);
});

test("queue status never answers `stopped` for a registry it could not read, and `--json` and `--stop` refuse outright", async (t) => {
  const env = makeQueueHome(t, "detached-status-unreadable");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);
  ensureHome(env);
  writeFileSync(runnersDir(env), "not a directory");

  const text = await runCli(env, ["queue", "status"]);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.out[0], /^runner: unknown - the runner registry cannot be listed \(ENOTDIR/, text.stdout);

  const json = await runCli(env, ["queue", "status", "--json"]);
  assert.equal(json.code, 1);
  assert.match(json.stderr, /the runner registry cannot be listed/);
  assert.equal(json.stdout, "", "`--json` answered for a registry it could not read");

  const stop = await runCli(env, ["queue", "run", "--stop"]);
  assert.equal(stop.code, 1);
  assert.match(stop.stderr, /the runner registry cannot be listed/);
});

test("a single-job start that would claim nothing reports what it waits for, spawns nothing and leaves the job pending", async (t) => {
  const env = makeQueueHome(t, "detached-waiting");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  for (const prompt of ["hold the first slot", "hold the second slot"]) {
    claimJobById(addJob({ project: "alpha", prompt }, env).id, { worker: `host:${prompt.length}`, cap: 4 }, env);
  }
  const calls = [];

  const waiting = await runCli(env, ["queue", "run", "--job", String(id)], { calls });

  assert.equal(waiting.code, 0, waiting.stderr);
  assert.deepEqual(waiting.out, [`job #${id} waiting: concurrency cap reached`, "2 of 2 jobs already running"]);
  assert.deepEqual(calls, [], "a start that claims nothing spawned a runner anyway");
  assert.equal(existsSync(runnersDir(env)), false, "a start that spawned nothing still registered a runner");
  assert.equal(getJob(id, env).status, "pending");

  const unknown = await runCli(env, ["queue", "run", "--job", "999"], { calls });
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown job `999`/);

  const watching = await runCli(env, ["queue", "run", "--watch", "5"], { calls });
  assert.equal(watching.code, 0, watching.stderr);
  assert.match(watching.stdout, /^runner started/, "a watcher refused to start under a full ceiling, which is exactly what it is there to wait out");
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
