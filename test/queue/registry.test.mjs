import assert from "node:assert/strict";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { test } from "node:test";
import { legacyRunnerPidPath, runnerRegistryPath, runnersDir } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import {
  findRunnerRecord,
  listRunnerRecords,
  liveRunners,
  pruneDeadRunners,
  removeOwnRunnerRecord,
  runnerView,
  stopAllRunners,
  stopRunner,
  STOPPED_RUNNER,
  STOP_POLL_MS,
  STOP_TIMEOUT_MS,
  writeRunnerRecord,
} from "../../src/queue/registry.mjs";
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

// Writes one registration by hand, the shape a runner of another process would have left.
function writeRecord(env, content, pid = content?.pid) {
  ensureHome(env);
  mkdirSync(runnersDir(env), { recursive: true });
  writeFileSync(runnerRegistryPath(pid, env), typeof content === "string" ? content : `${JSON.stringify(content)}\n`);
}

// The single record of a home, which most of these tests register exactly one of.
function onlyRecord(env, killImpl) {
  const records = listRunnerRecords(env, killImpl);
  assert.equal(records.length, 1, `expected one registration, got ${records.length}`);
  return records[0];
}

test("the registration of a live runner reads back with its fields, and is gone once removed", (t) => {
  const env = makeHome(t, "registry-alive");
  writeRunnerRecord({ ...WATCHER, detached: true }, env);

  const record = onlyRecord(env, fakeKill(new Set([WATCHER.pid])));
  assert.equal(record.status, "alive");
  assert.equal(record.path, runnerRegistryPath(WATCHER.pid, env), "the record was not written under the pid it names");
  assert.equal(typeof record.info.uptimeS, "number", "the registration carries the boot witness the classification reads");
  assert.deepEqual(runnerView(record), {
    running: true,
    pid: 4242,
    mode: "watch",
    jobId: null,
    intervalS: 30,
    startedAt: "2026-09-08T21:04:11.000Z",
    logPath: "/tmp/runner.log",
    runtimeDir: null,
    detached: true,
    pausedUntil: null,
    rateLimit: null,
  });

  assert.deepEqual(pruneDeadRunners(env, fakeKill(new Set())), [runnerRegistryPath(WATCHER.pid, env)]);
  assert.equal(existsSync(runnerRegistryPath(WATCHER.pid, env)), false);
  assert.deepEqual(listRunnerRecords(env, fakeKill(new Set())), []);
});

test("any number of runners register, and only the live ones are listed as running", (t) => {
  const env = makeHome(t, "registry-many");
  writeRunnerRecord({ ...WATCHER, pid: 101, startedAt: "2026-09-08T21:00:00.000Z" }, env);
  writeRunnerRecord({ ...WATCHER, pid: 202, mode: "drain", intervalS: null, startedAt: "2026-09-08T21:01:00.000Z" }, env);
  writeRunnerRecord({ ...WATCHER, pid: 303, startedAt: "2026-09-08T21:02:00.000Z" }, env);

  const alive = fakeKill(new Set([101, 202]));
  assert.deepEqual(listRunnerRecords(env, alive).map((record) => [record.info.pid, record.status]), [
    [101, "alive"],
    [202, "alive"],
    [303, "stale"],
  ]);
  assert.deepEqual(liveRunners(env, alive).map((runner) => runner.pid), [101, 202]);
  assert.equal(findRunnerRecord(202, env, alive).info.mode, "drain");
  assert.equal(findRunnerRecord(999, env, alive), null);
});

test("a live pid whose registration precedes this boot is stale; one written inside this boot, or with no witness at all, is alive", (t) => {
  const env = makeHome(t, "registry-boot-witness");
  const answersForTheWatcher = fakeKill(new Set([WATCHER.pid]));

  writeRecord(env, { ...WATCHER, uptimeS: Math.round(uptime()) + 3600 });
  assert.equal(onlyRecord(env, answersForTheWatcher).status, "stale", "an uptime above the current one can only come from an earlier boot session");

  writeRecord(env, { ...WATCHER, uptimeS: 0 });
  assert.equal(onlyRecord(env, answersForTheWatcher).status, "alive", "a registration written inside this boot session was misread as obsolete");

  writeRecord(env, WATCHER);
  assert.equal(onlyRecord(env, answersForTheWatcher).status, "alive", "without a witness nothing proves the registration is obsolete");
});

test("a runner nobody answers for is stale, and every state but `alive` reads as stopped", (t) => {
  const env = makeHome(t, "registry-stale");
  writeRecord(env, WATCHER);

  const stale = onlyRecord(env, fakeKill(new Set()));
  assert.equal(stale.status, "stale");
  assert.equal(stale.info.pid, WATCHER.pid);

  for (const record of [stale, { status: "foreign" }, null]) {
    assert.deepEqual(runnerView(record), STOPPED_RUNNER, "a state other than `alive` was read as a running runner");
  }
});

test("a record that is not JSON, carries no usable pid or names another pid than its own file is unreadable and never signals anything", (t) => {
  const signals = [];
  for (const [name, content, pid] of [
    ["broken", "{not json", 11],
    ["no-pid", { startedAt: WATCHER.startedAt }, 12],
    ["negative", { ...WATCHER, pid: -1 }, 13],
    ["string", { ...WATCHER, pid: "4242" }, 14],
    ["mismatch", { ...WATCHER, pid: 4242 }, 15],
  ]) {
    const env = makeHome(t, `registry-${name}`);
    writeRecord(env, content, pid);
    const record = onlyRecord(env, fakeKill(new Set(), signals));
    assert.equal(record.status, "unreadable", `\`${name}\` was not read as unreadable`);
    assert.ok(record.error, `\`${name}\` gave no reason`);
    assert.equal(runnerView(record).running, false);
  }
  assert.deepEqual(signals, [], "an unreadable registration made the runtime signal a process");
});

test("a runner only clears its OWN registration: the record of another process is left untouched", (t) => {
  const env = makeHome(t, "registry-ownership");
  writeRecord(env, { ...WATCHER, pid: process.pid + 1 }, process.pid);
  assert.equal(removeOwnRunnerRecord(env), false, "a runner removed the registration of another process");
  assert.equal(existsSync(runnerRegistryPath(process.pid, env)), true);

  writeRecord(env, { ...WATCHER, pid: process.pid });
  assert.equal(removeOwnRunnerRecord(env), true);
  assert.equal(existsSync(runnerRegistryPath(process.pid, env)), false);

  assert.equal(removeOwnRunnerRecord(env), false, "removing a registration that is not there was an error");
});

test("a prune never removes a record that was rewritten between the read and the removal", (t) => {
  const env = makeHome(t, "registry-prune-race");
  writeRecord(env, WATCHER);
  // The probe is the moment the classification is made: a fresh registration landing on the same pid right there
  // is exactly the same-boot reuse the prune must not erase.
  const rewritingProbe = (pid) => {
    writeRecord(env, { ...WATCHER, startedAt: new Date().toISOString() });
    throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
  };

  assert.deepEqual(pruneDeadRunners(env, rewritingProbe), [], "a prune erased a registration written after the classification");
  assert.equal(existsSync(runnerRegistryPath(WATCHER.pid, env)), true);
});

test("stop answers for the four outcomes and only removes the record of a runner that is gone", async (t) => {
  const absent = makeHome(t, "stop-absent");
  assert.deepEqual(await stopAllRunners({ env: absent, killImpl: fakeKill(new Set()) }), [{ outcome: "absent", pid: null }]);

  const stale = makeHome(t, "stop-stale");
  writeRecord(stale, WATCHER);
  assert.deepEqual(await stopRunner({ pid: 4242, env: stale, killImpl: fakeKill(new Set()) }), { outcome: "stale", pid: 4242 });
  assert.equal(existsSync(runnerRegistryPath(WATCHER.pid, stale)), false);

  const stopping = makeHome(t, "stop-stopped");
  writeRecord(stopping, WATCHER);
  const alive = new Set([WATCHER.pid]);
  const signals = [];
  const dying = (pid, signal) => {
    const answer = fakeKill(alive, signals)(pid, signal);
    if (signal === "SIGTERM") alive.delete(pid);
    return answer;
  };
  const slept = [];
  assert.deepEqual(
    await stopAllRunners({ env: stopping, killImpl: dying, sleepImpl: async (ms) => slept.push(ms) }),
    [{ outcome: "stopped", pid: 4242 }],
  );
  assert.equal(existsSync(runnerRegistryPath(WATCHER.pid, stopping)), false);
  assert.deepEqual(slept, [STOP_POLL_MS], "the stop polled more than once for a runner that died at once");
  assert.deepEqual(signals, [[4242, 0], [4242, "SIGTERM"], [4242, 0]], "the stop signalled something else than a probe and a SIGTERM");
});

test("a runner that refuses to die keeps its registration, after polling for the whole timeout", async (t) => {
  const env = makeHome(t, "stop-refuses");
  writeRecord(env, WATCHER);
  const slept = [];

  const stopped = await stopRunner({
    pid: 4242,
    env,
    killImpl: fakeKill(new Set([WATCHER.pid])),
    sleepImpl: async (ms) => slept.push(ms),
  });

  assert.deepEqual(stopped, { outcome: "alive", pid: 4242 });
  assert.equal(existsSync(runnerRegistryPath(WATCHER.pid, env)), true, "the stop removed the registration of a runner that is still alive");
  assert.equal(slept.length, STOP_TIMEOUT_MS / STOP_POLL_MS);
});

test("a runner that dies between the read and the signal is treated as stale, never as a failure", async (t) => {
  const env = makeHome(t, "stop-race");
  writeRecord(env, WATCHER);
  const alive = new Set([WATCHER.pid]);

  const stopped = await stopRunner({
    pid: 4242,
    env,
    killImpl: (pid, signal) => {
      if (signal === "SIGTERM") alive.delete(pid);
      return fakeKill(alive)(pid, signal);
    },
    sleepImpl: async () => {},
  });

  assert.deepEqual(stopped, { outcome: "stale", pid: 4242 });
  assert.equal(existsSync(runnerRegistryPath(WATCHER.pid, env)), false);
});

test("stopping one pid leaves the other runners registered, and an unknown pid is refused", async (t) => {
  const env = makeHome(t, "stop-one");
  writeRunnerRecord({ ...WATCHER, pid: 101 }, env);
  writeRunnerRecord({ ...WATCHER, pid: 202 }, env);
  const alive = new Set([101, 202]);
  const dying = (pid, signal) => {
    const answer = fakeKill(alive)(pid, signal);
    if (signal === "SIGTERM") alive.delete(pid);
    return answer;
  };

  const stopped = await stopRunner({ pid: 101, env, killImpl: dying, sleepImpl: async () => {} });

  assert.deepEqual(stopped, { outcome: "stopped", pid: 101 });
  assert.equal(existsSync(runnerRegistryPath(101, env)), false);
  assert.equal(existsSync(runnerRegistryPath(202, env)), true, "stopping one runner removed the registration of another");
  await assert.rejects(() => stopRunner({ pid: 999, env, killImpl: dying, sleepImpl: async () => {} }), /no runner is registered with pid 999/);
});

test("a stop of every runner reports one line each, ends the live one and never lets a foreign record take the others hostage", async (t) => {
  const env = makeHome(t, "stop-all-mixed");
  writeRunnerRecord({ ...WATCHER, pid: 101, startedAt: "2026-09-08T21:00:00.000Z" }, env);
  writeRunnerRecord({ ...WATCHER, pid: 202, startedAt: "2026-09-08T21:01:00.000Z" }, env);
  writeRunnerRecord({ ...WATCHER, pid: 303, startedAt: "2026-09-08T21:02:00.000Z" }, env);
  const alive = new Set([101]);
  const killImpl = (pid, signal) => {
    if (pid === 202) throw Object.assign(new Error(`kill EPERM ${pid}`), { code: "EPERM" });
    if (!alive.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
    if (signal === "SIGTERM") alive.delete(pid);
    return true;
  };

  const reports = await stopAllRunners({ env, killImpl, sleepImpl: async () => {} });

  assert.deepEqual(reports.map((report) => [report.outcome, report.pid]), [
    ["stopped", 101],
    ["foreign", 202],
    ["stale", 303],
  ]);
  assert.equal(existsSync(runnerRegistryPath(202, env)), true, "the registration of another user was removed");
  await assert.rejects(
    () => stopRunner({ pid: 202, env, killImpl, sleepImpl: async () => {} }),
    /process of another user/,
    "`--stop <pid>` aimed at a foreign registration must still refuse",
  );
});

test("a legacy `runner.pid` is listed, stopped and pruned, and no write ever recreates it", async (t) => {
  const env = makeHome(t, "registry-legacy");
  ensureHome(env);
  writeFileSync(legacyRunnerPidPath(env), `${JSON.stringify({ ...WATCHER, pid: 4242 })}\n`);

  const listed = onlyRecord(env, fakeKill(new Set([4242])));
  assert.equal(listed.legacy, true, "the legacy pidfile was not adopted by the registry");
  assert.deepEqual(liveRunners(env, fakeKill(new Set([4242]))).map((runner) => runner.pid), [4242]);

  const alive = new Set([4242]);
  const dying = (pid, signal) => {
    const answer = fakeKill(alive)(pid, signal);
    if (signal === "SIGTERM") alive.delete(pid);
    return answer;
  };
  assert.deepEqual(await stopAllRunners({ env, killImpl: dying, sleepImpl: async () => {} }), [{ outcome: "stopped", pid: 4242 }]);
  assert.equal(existsSync(legacyRunnerPidPath(env)), false, "the stop left the legacy pidfile behind");

  writeRunnerRecord({ ...WATCHER, pid: 4242 }, env);
  assert.equal(existsSync(legacyRunnerPidPath(env)), false, "a registration wrote the legacy pidfile again");
});

test("the registry directory is created closed to group and others", (t) => {
  const env = makeHome(t, "registry-mode");
  writeRunnerRecord(WATCHER, env);

  assert.equal(statSync(runnersDir(env)).mode & 0o077, 0, "the registry directory is open to group or others");
});

test("a registry directory that is simply not there stays an empty registry, and one that cannot be listed never becomes one", async (t) => {
  const env = makeHome(t, "registry-unreadable");
  ensureHome(env);
  assert.deepEqual(listRunnerRecords(env), [], "a home where no runner ever started is not an empty registry");
  assert.deepEqual(liveRunners(env), []);
  assert.deepEqual(await stopAllRunners({ env, sleepImpl: async () => {} }), [{ outcome: "absent", pid: null }]);

  writeFileSync(runnersDir(env), "not a directory");
  const [failure] = listRunnerRecords(env);
  assert.equal(failure.status, "unreadable", "a registry that cannot be listed is not a visible state");
  assert.equal(failure.path, runnersDir(env));
  assert.match(failure.error, /ENOTDIR/);
  assert.deepEqual(pruneDeadRunners(env), [], "a prune erased something of a registry it could not even list");
  await assert.rejects(() => stopAllRunners({ env, sleepImpl: async () => {} }), /cannot be listed/);
  await assert.rejects(() => stopRunner({ pid: 4242, env, sleepImpl: async () => {} }), /cannot be listed/);
});
