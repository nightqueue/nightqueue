import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { dbPath } from "../src/config/paths.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { addJob, claimJobById } from "../src/memory/jobs.mjs";
import { writeRunnerPidfile } from "../src/queue/pidfile.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";
import { makeProject } from "../test-support/memory.mjs";

const REFUSAL = "a job is running - update after it finishes, or stop the runner first (nightshift queue run --stop)";
const WATCHER_PID = 4242;
const WORKER = "host:4242";

// Context that captures the output and answers `kill` only for the pids the test says are alive.
function makeCtx(env, alive = new Set()) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env: assertIsolatedEnv(env),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: { isTTY: false },
    stdout: new PassThrough(),
    killImpl: (pid) => {
      if (!alive.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
      return true;
    },
  };
  return { ctx, out, err };
}

// A host with a registered project, the queue every test of this file starts from.
function makeQueueHost(t, name) {
  const host = makeHostEnv(t, name);
  makeProject(t, host.env, "alpha");
  return host;
}

// Registers a watcher whose pid the test keeps alive.
function registerWatcher(env) {
  writeRunnerPidfile(
    { pid: WATCHER_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log" },
    env,
  );
  return new Set([WATCHER_PID]);
}

// Enqueues a job and claims it, which is what a runner holding a live lease looks like.
function claimedJob(env) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: 4 }, env);
  return id;
}

// Moves the lease of a job past the reclaim grace, which is how a runner that died looks from the outside.
function expireLease(env, id) {
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
}

test("update refuses while a watcher is registered, and touches nothing on the way out", async (t) => {
  const host = makeQueueHost(t, "update-guard-watcher");
  const alive = registerWatcher(host.env);

  const { ctx, err } = makeCtx(host.env, alive);
  assert.equal(await run(["update"], ctx), 1);
  assert.equal(err.some((line) => line.includes(REFUSAL)), true, err.join("\n"));
  assert.deepEqual(host.npmCalls(), [], "a refused update still reinstalled the runtime");
});

test("update refuses while a job holds a live lease", async (t) => {
  const host = makeQueueHost(t, "update-guard-running");
  claimedJob(host.env);

  const { ctx, err } = makeCtx(host.env);
  assert.equal(await run(["update"], ctx), 1);
  assert.equal(err.some((line) => line.includes(REFUSAL)), true, err.join("\n"));
  assert.deepEqual(host.npmCalls(), []);
});

test("a job left running by a runner that died never blocks the update", async (t) => {
  const host = makeQueueHost(t, "update-guard-orphan");
  const id = claimedJob(host.env);
  expireLease(host.env, id);
  assert.equal(openDb(host.env).prepare("SELECT status FROM jobs WHERE id = ?").get(id).status, "running");

  const { ctx, err } = makeCtx(host.env);
  assert.equal(await run(["update"], ctx), 0, err.join("\n"));
  assert.equal(err.join("\n").includes(REFUSAL), false);
  assert.equal(host.npmCalls().length > 0, true, "the update never reached npm");
});

test("--force overrides both refusals", async (t) => {
  const watcherHost = makeQueueHost(t, "update-guard-force-watcher");
  const alive = registerWatcher(watcherHost.env);
  const watcher = makeCtx(watcherHost.env, alive);
  assert.equal(await run(["update", "--force"], watcher.ctx), 0, watcher.err.join("\n"));
  assert.equal(watcherHost.npmCalls().length > 0, true);

  const runningHost = makeQueueHost(t, "update-guard-force-running");
  claimedJob(runningHost.env);
  const running = makeCtx(runningHost.env);
  assert.equal(await run(["update", "--force"], running.ctx), 0, running.err.join("\n"));
  assert.equal(runningHost.npmCalls().length > 0, true);
});

test("a queue database that cannot be read lets the update through, printing nothing about it", async (t) => {
  const host = makeQueueHost(t, "update-guard-unreadable");
  claimedJob(host.env);
  closeDb(host.env);
  writeFileSync(dbPath(host.env), "not a database");

  const { ctx, out, err } = makeCtx(host.env);
  assert.equal(await run(["update"], ctx), 0, err.join("\n"));
  assert.equal([...out, ...err].some((line) => line.includes(REFUSAL)), false);
});
