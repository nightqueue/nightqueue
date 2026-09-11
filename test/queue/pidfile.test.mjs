import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { test } from "node:test";
import { runnerPidPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import {
  removeOwnRunnerPidfile,
  removeRunnerPidfile,
  runnerPidfileState,
  runnerView,
  stopRunner,
  STOP_POLL_MS,
  STOP_TIMEOUT_MS,
  writeRunnerPidfile,
} from "../../src/queue/pidfile.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const WATCHER = { pid: 4242, startedAt: "2026-09-08T21:04:11.000Z", mode: "watch", intervalS: 30, logPath: "/tmp/runner.log" };

// A kill double: it answers for the pids the test says are alive and never signals a real process.
function fakeKill(alive, signals = []) {
  return (pid, signal) => {
    signals.push([pid, signal]);
    if (alive.has(pid)) return true;
    throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
  };
}

// Writes the pidfile of the test by hand, the shape a runner of another process would have left.
function writePidfile(env, content) {
  ensureHome(env);
  writeFileSync(runnerPidPath(env), typeof content === "string" ? content : `${JSON.stringify(content)}\n`);
}

test("the pidfile of a live runner reads back with its five fields, and is gone once removed", (t) => {
  const env = makeHome(t, "pidfile-alive");
  writeRunnerPidfile(WATCHER, env);

  const state = runnerPidfileState(env, fakeKill(new Set([WATCHER.pid])));
  assert.equal(state.status, "alive");
  assert.equal(typeof state.info.uptimeS, "number", "the registration carries the boot witness the classification reads");
  assert.deepEqual(state.info, { ...WATCHER, uptimeS: state.info.uptimeS });
  assert.deepEqual(runnerView(state), {
    running: true,
    pid: 4242,
    mode: "watch",
    jobId: null,
    intervalS: 30,
    startedAt: "2026-09-08T21:04:11.000Z",
    logPath: "/tmp/runner.log",
    runtimeDir: null,
  });

  removeRunnerPidfile(env);
  assert.equal(existsSync(runnerPidPath(env)), false);
  assert.equal(runnerPidfileState(env, fakeKill(new Set())).status, "missing");
});

test("a live pid whose registration precedes this boot is stale; one written inside this boot, or with no witness at all, is alive", (t) => {
  const env = makeHome(t, "pidfile-boot-witness");
  const answersForTheWatcher = fakeKill(new Set([WATCHER.pid]));

  writePidfile(env, { ...WATCHER, uptimeS: Math.round(uptime()) + 3600 });
  assert.equal(runnerPidfileState(env, answersForTheWatcher).status, "stale", "an uptime above the current one can only come from an earlier boot session");

  writePidfile(env, { ...WATCHER, uptimeS: 0 });
  assert.equal(runnerPidfileState(env, answersForTheWatcher).status, "alive", "a registration written inside this boot session was misread as obsolete");

  writePidfile(env, WATCHER);
  assert.equal(runnerPidfileState(env, answersForTheWatcher).status, "alive", "without a witness nothing proves the registration is obsolete");
});

test("a runner nobody answers for is stale, and every state but `alive` reads as stopped", (t) => {
  const env = makeHome(t, "pidfile-stale");
  writePidfile(env, WATCHER);

  const stale = runnerPidfileState(env, fakeKill(new Set()));
  assert.equal(stale.status, "stale");
  assert.equal(stale.info.pid, WATCHER.pid);

  const stopped = { running: false, pid: null, mode: null, jobId: null, intervalS: null, startedAt: null, logPath: null, runtimeDir: null };
  for (const state of [stale, runnerPidfileState(makeHome(t, "pidfile-none"), fakeKill(new Set()))]) {
    assert.deepEqual(runnerView(state), stopped, `the state \`${state.status}\` was read as a running runner`);
  }
});

test("a pidfile that is not JSON, or carries no usable pid, is unreadable and never signals anything", (t) => {
  const signals = [];
  for (const [name, content] of [
    ["broken", "{not json"],
    ["no-pid", { startedAt: WATCHER.startedAt }],
    ["negative", { ...WATCHER, pid: -1 }],
    ["string", { ...WATCHER, pid: "4242" }],
  ]) {
    const env = makeHome(t, `pidfile-${name}`);
    writePidfile(env, content);
    const state = runnerPidfileState(env, fakeKill(new Set(), signals));
    assert.equal(state.status, "unreadable", `\`${name}\` was not read as unreadable`);
    assert.ok(state.error, `\`${name}\` gave no reason`);
    assert.equal(runnerView(state).running, false);
  }
  assert.deepEqual(signals, [], "an unreadable pidfile made the runtime signal a process");
});

test("a runner only clears its OWN registration: the pidfile of another process is left untouched", (t) => {
  const env = makeHome(t, "pidfile-ownership");
  writePidfile(env, { ...WATCHER, pid: process.pid + 1 });
  assert.equal(removeOwnRunnerPidfile(env), false, "a runner removed the pidfile of another process");
  assert.equal(existsSync(runnerPidPath(env)), true);

  writePidfile(env, { ...WATCHER, pid: process.pid });
  assert.equal(removeOwnRunnerPidfile(env), true);
  assert.equal(existsSync(runnerPidPath(env)), false);

  assert.equal(removeOwnRunnerPidfile(env), false, "removing a pidfile that is not there was an error");
});

test("stop answers for the four outcomes and only removes the pidfile of a runner that is gone", async (t) => {
  const absent = makeHome(t, "stop-absent");
  assert.deepEqual(await stopRunner({ env: absent, killImpl: fakeKill(new Set()) }), { outcome: "absent", pid: null });

  const stale = makeHome(t, "stop-stale");
  writePidfile(stale, WATCHER);
  assert.deepEqual(await stopRunner({ env: stale, killImpl: fakeKill(new Set()) }), { outcome: "stale", pid: 4242 });
  assert.equal(existsSync(runnerPidPath(stale)), false);

  const stopping = makeHome(t, "stop-stopped");
  writePidfile(stopping, WATCHER);
  const alive = new Set([WATCHER.pid]);
  const signals = [];
  const dying = (pid, signal) => {
    const answer = fakeKill(alive, signals)(pid, signal);
    if (signal === "SIGTERM") alive.delete(pid);
    return answer;
  };
  const slept = [];
  assert.deepEqual(
    await stopRunner({ env: stopping, killImpl: dying, sleepImpl: async (ms) => slept.push(ms) }),
    { outcome: "stopped", pid: 4242 },
  );
  assert.equal(existsSync(runnerPidPath(stopping)), false);
  assert.deepEqual(slept, [STOP_POLL_MS], "the stop polled more than once for a runner that died at once");
  assert.deepEqual(signals, [[4242, 0], [4242, "SIGTERM"], [4242, 0]], "the stop signalled something else than a probe and a SIGTERM");
});

test("a runner that refuses to die keeps its pidfile, after polling for the whole timeout", async (t) => {
  const env = makeHome(t, "stop-refuses");
  writePidfile(env, WATCHER);
  const slept = [];

  const stopped = await stopRunner({
    env,
    killImpl: fakeKill(new Set([WATCHER.pid])),
    sleepImpl: async (ms) => slept.push(ms),
  });

  assert.deepEqual(stopped, { outcome: "alive", pid: 4242 });
  assert.equal(existsSync(runnerPidPath(env)), true, "the stop removed the pidfile of a runner that is still alive");
  assert.equal(slept.length, STOP_TIMEOUT_MS / STOP_POLL_MS);
});

test("a runner that dies between the read and the signal is treated as stale, never as a failure", async (t) => {
  const env = makeHome(t, "stop-race");
  writePidfile(env, WATCHER);
  const alive = new Set([WATCHER.pid]);

  const stopped = await stopRunner({
    env,
    killImpl: (pid, signal) => {
      if (signal === "SIGTERM") alive.delete(pid);
      return fakeKill(alive)(pid, signal);
    },
    sleepImpl: async () => {},
  });

  assert.deepEqual(stopped, { outcome: "stale", pid: 4242 });
  assert.equal(existsSync(runnerPidPath(env)), false);
});
