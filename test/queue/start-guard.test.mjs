import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { lockPath } from "../../src/config/lock.mjs";
import { runnerRegistryPath, runtimeVersionsDir } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { packageRoot } from "../../src/host/paths.mjs";
import { addJob, cancelJob, getJob } from "../../src/memory/jobs.mjs";
import { liveRunners, writeRunnerRecord } from "../../src/queue/registry.mjs";
import { registerForegroundRunner } from "../../src/queue/start.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const STARTER = fileURLToPath(new URL("../../test-support/runner-starter.mjs", import.meta.url));
const BARRIER_MS = 400;
const HOLD_MS = 1500;
const LIVE_PID = 4242;
const CHILD_PID = 5252;

// A spawn double: it records every call and answers with a child that has a pid and can be unreferenced.
function fakeSpawn(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: CHILD_PID, unref: () => {} };
  };
}

// A kill double: it answers for the pids the test says are alive and never signals a real process.
function fakeKill(alive) {
  return (pid) => {
    if (!alive.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
    return true;
  };
}

// Runs the CLI in this process, with the spawn and the kill of the test injected.
async function runCli(env, argv, { calls = [], alive = new Set() } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    spawnImpl: fakeSpawn(calls),
    killImpl: fakeKill(alive),
  };
  const code = await run(argv, ctx);
  return { code, out, err, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

// A home with one registered project, the queue every test of this file starts from.
function makeQueueHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Registers a runner of the given mode, as the process that started it would have.
function registerRunner(env, info) {
  ensureHome(env);
  return writeRunnerRecord({ pid: LIVE_PID, startedAt: new Date().toISOString(), intervalS: null, logPath: null, jobId: null, ...info }, env);
}

// Runs one starter as a real child process, so two starts really cross inside the filesystem and not inside one heap.
function starterAsync(env, { mode, startAt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [STARTER, mode, String(startAt), String(HOLD_MS)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("two real processes starting a runner at the same instant: both start and both are registered", async (t) => {
  const env = makeQueueHome(t, "start-race");
  const startAt = Date.now() + BARRIER_MS;

  const results = await Promise.all([starterAsync(env, { mode: "drain", startAt }), starterAsync(env, { mode: "drain", startAt })]);

  const starts = results.map((result) => {
    assert.equal(result.code, 0, `starter exited ${result.code}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim());
  });
  assert.deepEqual(starts.map((start) => start.started), [true, true], `a start was refused: ${JSON.stringify(starts)}`);
  for (const start of starts) {
    assert.equal(JSON.parse(readFileSync(runnerRegistryPath(start.pid, env), "utf8")).pid, start.pid, "a runner that started is not in the registry");
  }
});

test("every start path registers its runner while another one is live, and none of them is refused", async (t) => {
  const env = makeQueueHome(t, "start-paths");
  const alive = new Set([LIVE_PID]);
  registerRunner(env, { mode: "drain" });
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  for (const argv of [
    ["queue", "run"],
    ["queue", "run", "--watch", "10"],
    ["queue", "run", "--job", String(id)],
  ]) {
    const started = await runCli(env, argv, { calls, alive });
    const label = argv.join(" ");
    assert.equal(started.code, 0, `\`${label}\` did not exit 0: ${started.stderr}`);
    assert.match(started.stdout, /started \(pid 5252/, `\`${label}\` was refused: ${started.stdout}`);
  }
  assert.equal(calls.length, 3, "a start spawned nothing while another runner was live");
  assert.equal(existsSync(runnerRegistryPath(LIVE_PID, env)), true, "a start cleared the registration of the live runner");

  cancelJob(id, { reason: "not needed" }, env);
  const retried = await runCli(env, ["queue", "retry", String(id), "--run"], { calls, alive });
  assert.equal(retried.code, 0, retried.stderr);
  assert.match(retried.stdout, /job #1 started \(pid 5252\)/, retried.stdout);
  assert.equal(getJob(id, env).status, "pending", "the retried job is not pending, so no runner will ever claim it");
});

test("a single-job start registers a `once` runner carrying the job and the tree it loaded from", async (t) => {
  const env = makeQueueHome(t, "start-once-registration");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;

  const started = await runCli(env, ["queue", "run", "--job", String(id)]);

  assert.equal(started.code, 0, started.stderr);
  const info = JSON.parse(readFileSync(runnerRegistryPath(CHILD_PID, env), "utf8"));
  assert.deepEqual(
    { pid: info.pid, mode: info.mode, jobId: info.jobId, detached: info.detached, runtimeDir: info.runtimeDir },
    { pid: CHILD_PID, mode: "once", jobId: id, detached: true, runtimeDir: packageRoot() },
  );

  const status = await runCli(env, ["queue", "status"], { alive: new Set([CHILD_PID]) });
  assert.equal(
    status.out[0],
    `runner: running (pid ${CHILD_PID}, once, job #${id}, runtime ${packageRoot()}, since ${info.startedAt})`,
    "`queue status` does not show the single-job runner the way it was registered",
  );
});

test("a runner of a version directory of this home is named by that directory alone", async (t) => {
  const env = makeQueueHome(t, "start-runtime-label");
  const version = "1.4.2-20260911T031500Z";
  registerRunner(env, { mode: "drain", runtimeDir: join(runtimeVersionsDir(env), version, "node_modules", "pkg") });

  const status = await runCli(env, ["queue", "status"], { alive: new Set([LIVE_PID]) });

  assert.match(status.out[0], new RegExp(`^runner: running \\(pid ${LIVE_PID}, drain, runtime ${version}, since `));
});

test("the child of a start never registers itself again, and never takes the lock its parent may still hold", async (t) => {
  const env = makeQueueHome(t, "start-self-exemption");
  const registered = registerRunner(env, { pid: process.pid, mode: "drain", runtimeDir: packageRoot() });
  mkdirSync(lockPath(env), { recursive: true });
  t.after(() => rmSync(lockPath(env), { recursive: true, force: true }));

  const guard = await registerForegroundRunner({ env, killImpl: (pid) => pid === process.pid });

  assert.deepEqual({ registered: guard.registered, self: guard.self, pid: guard.pid }, { registered: true, self: false, pid: process.pid });
  assert.equal(
    JSON.parse(readFileSync(runnerRegistryPath(process.pid, env), "utf8")).startedAt,
    registered.startedAt,
    "the child rewrote the registration its parent had just written for it",
  );
});

test("a registration no live process answers for never blocks a start, and is cleared on the way", async (t) => {
  const env = makeQueueHome(t, "start-stale-registration");
  registerRunner(env, { mode: "drain" });

  const started = await runCli(env, ["queue", "run", "--watch", "10"]);

  assert.equal(started.code, 0, started.stderr);
  assert.deepEqual(liveRunners(env, fakeKill(new Set([CHILD_PID]))).map((runner) => runner.pid), [CHILD_PID]);
  assert.equal(existsSync(runnerRegistryPath(LIVE_PID, env)), false, "the stale registration survived the start that pruned it");
});
