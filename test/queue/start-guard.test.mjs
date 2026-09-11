import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { lockPath } from "../../src/config/lock.mjs";
import { runnerPidPath, runtimeVersionsDir } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { packageRoot } from "../../src/host/paths.mjs";
import { addJob, cancelJob, getJob } from "../../src/memory/jobs.mjs";
import { writeRunnerPidfile } from "../../src/queue/pidfile.mjs";
import { guardRunnerStart, registerForegroundRunner } from "../../src/queue/start.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const STARTER = fileURLToPath(new URL("../../test-support/runner-starter.mjs", import.meta.url));
const BARRIER_MS = 400;
const HOLD_MS = 1500;
const LIVE_PID = 4242;
const CHILD_PID = 5252;
const BUSY_ONCE = `runner already active (pid ${LIVE_PID}, once) - it will pick the job up`;
const ADVISORY = "the live runner runs one job only - start the batch again once it exits: nightshift queue run";

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
  return writeRunnerPidfile({ pid: LIVE_PID, startedAt: new Date().toISOString(), intervalS: null, logPath: null, jobId: null, ...info }, env);
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

test("two real processes starting a runner at the same instant: exactly one of them owns the queue", async (t) => {
  const env = makeQueueHome(t, "start-race");
  const startAt = Date.now() + BARRIER_MS;

  const results = await Promise.all([starterAsync(env, { mode: "drain", startAt }), starterAsync(env, { mode: "drain", startAt })]);

  const starts = results.map((result) => {
    assert.equal(result.code, 0, `starter exited ${result.code}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim());
  });
  const winners = starts.filter((start) => start.started);
  assert.equal(winners.length, 1, `both processes started a runner: ${JSON.stringify(starts)}`);
  const loser = starts.find((start) => !start.started);
  assert.deepEqual(
    { pid: loser.pid, mode: loser.mode },
    { pid: winners[0].pid, mode: "drain" },
    "the refused start did not name the runner that had just won",
  );
  assert.equal(JSON.parse(readFileSync(runnerPidPath(env), "utf8")).pid, winners[0].pid, "the pidfile registers a runner nobody started");
});

test("every start path is refused while a runner is live, spawns nothing and exits 0", async (t) => {
  const env = makeQueueHome(t, "start-guard-paths");
  const alive = new Set([LIVE_PID]);
  registerRunner(env, { mode: "once", jobId: 1 });
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  const refusals = [
    { argv: ["queue", "run"], advisory: true },
    { argv: ["queue", "run", "--watch", "10"], advisory: true },
    { argv: ["queue", "run", "--job", String(id)], advisory: false },
    { argv: ["queue", "run", "--foreground"], advisory: true },
    { argv: ["queue", "run", "--job", String(id), "--foreground"], advisory: false },
    { argv: ["queue", "add", "alpha", "fix the parser", "--run"], advisory: false },
  ];
  for (const { argv, advisory } of refusals) {
    const refused = await runCli(env, argv, { calls, alive });
    const label = argv.join(" ");
    assert.equal(refused.code, 0, `\`${label}\` did not exit 0: ${refused.stderr}`);
    assert.equal(refused.out.includes(BUSY_ONCE), true, `\`${label}\` did not refuse: ${refused.stdout}`);
    assert.equal(refused.out.includes(ADVISORY), advisory, `\`${label}\` got the wrong advisory: ${refused.stdout}`);
  }
  assert.deepEqual(calls, [], "a refused start spawned a runner anyway");
  assert.equal(getJob(id, env).status, "pending", "a refused single-job start moved the job the live runner must claim");

  cancelJob(id, { reason: "not needed" }, env);
  const retried = await runCli(env, ["queue", "retry", String(id), "--run"], { calls, alive });
  assert.equal(retried.code, 0, retried.stderr);
  assert.equal(retried.out.includes(BUSY_ONCE), true, `\`queue retry --run\` did not refuse: ${retried.stdout}`);
  assert.deepEqual(calls, [], "`queue retry --run` spawned a runner while one was live");
  assert.equal(getJob(id, env).status, "pending", "the retried job is not pending, so the live runner will never claim it");
});

test("a single-job start registers a `once` runner carrying the job and the tree it loaded from", async (t) => {
  const env = makeQueueHome(t, "start-once-registration");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;

  const started = await runCli(env, ["queue", "run", "--job", String(id)]);

  assert.equal(started.code, 0, started.stderr);
  const info = JSON.parse(readFileSync(runnerPidPath(env), "utf8"));
  assert.deepEqual(
    { pid: info.pid, mode: info.mode, jobId: info.jobId, runtimeDir: info.runtimeDir },
    { pid: CHILD_PID, mode: "once", jobId: id, runtimeDir: packageRoot() },
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

test("the child of a start never refuses itself, and never takes the lock its parent may still hold", async (t) => {
  const env = makeQueueHome(t, "start-self-exemption");
  const registered = registerRunner(env, { pid: process.pid, mode: "drain", runtimeDir: packageRoot() });
  mkdirSync(lockPath(env), { recursive: true });
  t.after(() => rmSync(lockPath(env), { recursive: true, force: true }));

  const guard = await registerForegroundRunner({ env, killImpl: (pid) => pid === process.pid });

  assert.deepEqual({ ok: guard.ok, self: guard.self, pid: guard.pid }, { ok: true, self: true, pid: process.pid });
  assert.equal(
    JSON.parse(readFileSync(runnerPidPath(env), "utf8")).startedAt,
    registered.startedAt,
    "the child rewrote the registration its parent had just written for it",
  );
});

test("a registration no live process answers for never blocks a start, and is cleared on the way", (t) => {
  const env = makeQueueHome(t, "start-stale-registration");
  registerRunner(env, { mode: "drain" });

  const guard = guardRunnerStart({ env, killImpl: fakeKill(new Set()) });

  assert.deepEqual({ ok: guard.ok, pid: guard.pid }, { ok: true, pid: null });
  assert.equal(existsSync(runnerPidPath(env)), false, "the stale registration survived the guard that let the start through");
});
