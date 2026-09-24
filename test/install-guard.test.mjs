import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { runnersDir } from "../src/config/paths.mjs";
import { addJob, claimJobById } from "../src/memory/jobs.mjs";
import { writeRunnerRecord } from "../src/queue/registry.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";
import { makeDir, makeProject } from "../test-support/memory.mjs";

const CHECKOUT = fileURLToPath(new URL("../", import.meta.url));
const REFUSAL_TAIL =
  "the runtime cannot be replaced while it runs; stop it with nightqueue queue run --stop or wait for the queue to drain";
const RUNNER_PID = 5151;
const WORKER = "host:5151";

// The refusal, with whichever of the pid and the job the guard could name.
function refusal(label) {
  return `nightqueue: a runner is active (${label}) - ${REFUSAL_TAIL}`;
}

// Context that captures the output and answers `kill` only for the pids the test says are alive.
function makeCtx(env, { alive = new Set(), cwd } = {}) {
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
    ...(cwd ? { cwd } : {}),
  };
  return { ctx, out, err };
}

// A host with a registered project, the queue every test of this file starts from.
function makeQueueHost(t, name) {
  const host = makeHostEnv(t, name);
  makeProject(t, host.env, "alpha");
  return host;
}

// Registers a runner whose pid the test keeps alive.
function registerRunner(env, { runtimeDir = null } = {}) {
  writeRunnerRecord(
    { pid: RUNNER_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/a.log", runtimeDir },
    env,
  );
  return new Set([RUNNER_PID]);
}

// Enqueues a job and claims it, which is what a runner holding a live lease looks like.
function claimedJob(env) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: 4 }, env);
  return id;
}

test("setup refuses to replace the runtime while a runner is registered, and installs nothing", async (t) => {
  const host = makeQueueHost(t, "install-guard-setup");
  const alive = registerRunner(host.env);

  const { ctx, err } = makeCtx(host.env, { alive });
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 1);
  assert.deepEqual(err, [refusal(`pid ${RUNNER_PID}`)]);
  assert.deepEqual(host.npmCalls(), [], "a refused setup still reached npm");
  assert.equal(existsSync(host.runtimeCurrent), false, "a refused setup still swapped the runtime");
});

test("setup --from refuses under the same condition, before packing anything", async (t) => {
  const host = makeQueueHost(t, "install-guard-setup-from");
  const id = claimedJob(host.env);

  const { ctx, err } = makeCtx(host.env);
  assert.equal(await run(["setup", "--from", CHECKOUT, "--no-path", "--no-embedding"], ctx), 1);
  assert.deepEqual(err, [refusal(`job #${id}`)]);
  assert.deepEqual(host.npmCalls(), [], "a refused setup --from still reached npm");
});

test("init refuses while a runner holds a job, naming both the pid and the job", async (t) => {
  const host = makeQueueHost(t, "install-guard-init");
  const alive = registerRunner(host.env);
  const id = claimedJob(host.env);
  const cwd = makeDir(t, "install-guard-init-cwd");

  const { ctx, err } = makeCtx(host.env, { alive, cwd });
  assert.equal(await run(["init", "--no-path", "--no-embedding", "--no-gh"], ctx), 1);
  assert.deepEqual(err, [refusal(`pid ${RUNNER_PID} / job #${id}`)]);
  assert.deepEqual(host.npmCalls(), [], "a refused init still reached npm");
  assert.equal(existsSync(host.runtimeCurrent), false, "a refused init still swapped the runtime");
});

test("--force installs anyway and warns on stderr that the live runner may fail, naming the tree it loaded from", async (t) => {
  const host = makeQueueHost(t, "install-guard-force");
  const runtimeDir = "/tmp/runtime/versions/1.0.0-20260911T031500Z";
  const alive = registerRunner(host.env, { runtimeDir });

  const { ctx, out, err } = makeCtx(host.env, { alive });
  assert.equal(await run(["setup", "--force", "--no-path", "--no-embedding"], ctx), 0, err.join("\n"));
  assert.deepEqual(err, [
    `warning: --force is replacing the runtime while a runner is active (pid ${RUNNER_PID}, runtime ${runtimeDir}); the job it is running may fail`,
  ]);
  assert.ok(out.some((line) => line.startsWith("runtime: created")), out.join("\n"));
  assert.equal(existsSync(host.runtimeCurrent), true);
});

test("the refusal counts every registered runner, naming each live pid and each tree `--force` would replace", async (t) => {
  const host = makeQueueHost(t, "install-guard-two-runners");
  const second = RUNNER_PID + 1;
  const firstRuntime = "/tmp/runtime/versions/1.0.0-20260911T031500Z";
  const secondRuntime = "/tmp/runtime/versions/1.1.0-20260912T031500Z";
  writeRunnerRecord({ pid: RUNNER_PID, startedAt: "2026-09-08T21:00:00.000Z", mode: "watch", intervalS: 30, logPath: null, runtimeDir: firstRuntime }, host.env);
  writeRunnerRecord({ pid: second, startedAt: "2026-09-08T21:01:00.000Z", mode: "drain", intervalS: null, logPath: null, runtimeDir: secondRuntime }, host.env);
  const alive = new Set([RUNNER_PID, second]);

  const refused = makeCtx(host.env, { alive });
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], refused.ctx), 1);
  assert.deepEqual(refused.err, [refusal(`pid ${RUNNER_PID} / pid ${second}`)], "the refusal named only one of the live runners");

  const forced = makeCtx(host.env, { alive });
  assert.equal(await run(["setup", "--force", "--no-path", "--no-embedding"], forced.ctx), 0, forced.err.join("\n"));
  assert.deepEqual(forced.err, [
    `warning: --force is replacing the runtime while a runner is active (pid ${RUNNER_PID} / pid ${second}, runtime ${firstRuntime}, runtime ${secondRuntime}); the job it is running may fail`,
  ]);

  const stillAlive = makeCtx(host.env, { alive: new Set([second]) });
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], stillAlive.ctx), 1, "the refusal stopped at the first runner that had died");
  assert.deepEqual(stillAlive.err, [refusal(`pid ${second}`)]);
});

test("--force never turns the install into a registry install", async (t) => {
  const host = makeQueueHost(t, "install-guard-force-source");
  const alive = registerRunner(host.env);

  const { ctx, err } = makeCtx(host.env, { alive });
  assert.equal(await run(["setup", "--force", "--no-path", "--no-embedding"], ctx), 0, err.join("\n"));
  const specs = host.npmCalls().filter((call) => call[0] === "install").map((call) => call.at(-1));
  assert.deepEqual(specs.map((spec) => spec.endsWith(".tgz")), [true], `--force asked the registry: ${specs.join(" ")}`);
});

test("the install refuses while the runner registry cannot be listed, and --force is still the way through", async (t) => {
  const host = makeQueueHost(t, "install-guard-registry-unreadable");
  rmSync(runnersDir(host.env), { recursive: true, force: true });
  writeFileSync(runnersDir(host.env), "not a directory");

  const refused = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], refused.ctx), 1);
  assert.match(refused.err.join("\n"), /the runner registry cannot be listed \(ENOTDIR.*\), so a live runner may be invisible - /);
  assert.deepEqual(host.npmCalls(), [], "a setup refused over an unreadable registry still reached npm");

  const forced = makeCtx(host.env);
  assert.equal(await run(["setup", "--force", "--no-path", "--no-embedding"], forced.ctx), 0, forced.err.join("\n"));
  assert.match(forced.err.join("\n"), /^warning: --force is replacing the runtime although the runner registry cannot be listed/);
  assert.equal(existsSync(host.runtimeCurrent), true);
});

test("a home with no queue database installs without ever mentioning the refusal", async (t) => {
  const host = makeHostEnv(t, "install-guard-no-database");

  const { ctx, out, err } = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 0, err.join("\n"));
  assert.equal([...out, ...err].some((line) => line.includes(REFUSAL_TAIL)), false, [...out, ...err].join("\n"));
  assert.ok(out.includes(`home: created (${host.home}, 0700)`), out.join("\n"));
});
