import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath, queuePausedPath, queueResumePath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { clearOwnPause, inheritablePause, PAUSE_GRACE_S, PAUSE_POLL_MS, readOwnPause, recordOwnPause } from "../../src/queue/rate-limit.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { runCycle, runDrain } from "../../src/queue/runner.mjs";
import { registerForegroundRunner } from "../../src/queue/start.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL, rateLimitEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const PROMPT = "fix the worker";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// A home with one registered project, the fake `claude` and the registration this process writes its own pause into.
function makeRunnerHome(t, name, attempts, { register = true } = {}) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  if (register) writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain" }, env);
  return env;
}

// A pid probe that answers for the given processes and reports every other one as gone.
function killingOnly(pids) {
  const alive = new Set(pids);
  return (pid) => {
    if (alive.has(pid)) return true;
    throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
  };
}

// A cycle upkeep that prunes nothing, because the sibling of these fixtures is a pid only the injected probe says is alive.
async function keepRegistry() {
  return { warning: null, pruned: [], ms: 0 };
}

// Enqueues one job of the test project.
function enqueue(env) {
  return addJob({ project: "alpha", prompt: PROMPT }, env).id;
}

// The pause this runner would have armed for a limit that resets in an hour.
function hourLongPause(env) {
  const resetsAt = new Date(Date.now() + 3600_000);
  return recordOwnPause(
    {
      pausedAt: new Date().toISOString(),
      pausedUntil: new Date(resetsAt.getTime() + PAUSE_GRACE_S * 1000).toISOString(),
      resetsAt: resetsAt.toISOString(),
      type: "five_hour",
      utilization: 0.99,
    },
    env,
  );
}

// Ends the pause of this runner the way the limit running out does: the clear names the very pause on record.
function endOwnPause(env) {
  return clearOwnPause(env, readOwnPause(env));
}

// A sleep double that records every slice the runner waits and lets the test change the world between two of them.
function slicedSleep(slept, onSlice = () => {}) {
  return async (ms) => {
    slept.push(ms);
    await onSlice(slept.length);
  };
}

test("a rate limit event mid stream keeps the child alive through a silence longer than the idle timeout, and the job still ends done", async (t) => {
  const idleTimeoutS = 0.7;
  const silenceMs = 2000;
  const resetsAtS = Math.floor(Date.now() / 1000) + 3600;
  const limited = toNdjson([systemInitEvent({}), rateLimitEvent({ status: "rejected", resetsAt: resetsAtS })]);
  const env = makeRunnerHome(t, "rate-limit-idle-survives", [{ stdout: limited, holdMs: silenceMs, tail: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);

  assert.ok(silenceMs > idleTimeoutS * 1000, "the fixture does not keep the child silent longer than the idle timeout");
  const cycle = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit(), idleTimeoutS, stopPollMs: 500 } });

  assert.deepEqual(cycle.processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }], "the silence of the limit ended the attempt");
  const row = getJob(id, env);
  assert.deepEqual({ status: row.status, attempts: row.attempts }, { status: "done", attempts: 1 });
  assert.equal(readOwnPause(env).pausedUntil, new Date((resetsAtS + PAUSE_GRACE_S) * 1000).toISOString(), "the event that fired armed no pause");
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /=== rate limit until \S+ @ \S+ ===/, "the job log says nothing about the wait");
});

// A registry that refuses the pause never costs the child its protection: that run lives in
// `test/queue/rate-limit-write-failure.poc.test.mjs`, the named regression net of that break.

test("a runner waiting out its own limit never stops another runner of the same home from claiming", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-sibling-claims", [{ stdout: doneStream(), exitCode: 0 }]);
  const sibling = process.pid + 1;
  const killImpl = killingOnly([process.pid, sibling]);
  const paused = { pausedAt: new Date().toISOString(), pausedUntil: new Date(Date.now() + 3600_000).toISOString(), resetsAt: new Date(Date.now() + 3540_000).toISOString(), type: "five_hour", utilization: 0.99 };
  writeRunnerRecord({ pid: sibling, startedAt: new Date().toISOString(), mode: "watch", rateLimit: paused }, env);
  const id = enqueue(env);
  const slept = [];

  const cycle = await runCycle({ env, deps: { gitImpl: fakeGit(), sleepImpl: slicedSleep(slept), maintenanceImpl: keepRegistry } });

  assert.ok(inheritablePause(env, killImpl), "the fixture left no live pause on the other runner, so the test proves nothing");
  assert.equal(readOwnPause(env), null, "the pause of another runner was adopted by a runner that was already claiming");
  assert.deepEqual(slept, [], "a runner waited out a limit that belongs to another runner");
  assert.equal(cycle.processed[0].status, "done");
  assert.equal(getJob(id, env).status, "done");
});

test("a runner registered while a live runner of this home waits out a limit joins the wait instead of claiming", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-adoption", [{ stdout: doneStream(), exitCode: 0 }], { register: false });
  const sibling = process.pid + 1;
  const resetsAt = new Date(Date.now() + 3600_000);
  const paused = { pausedAt: new Date().toISOString(), pausedUntil: new Date(resetsAt.getTime() + PAUSE_GRACE_S * 1000).toISOString(), resetsAt: resetsAt.toISOString(), type: "five_hour", utilization: 0.99 };
  writeRunnerRecord({ pid: sibling, startedAt: new Date().toISOString(), mode: "watch", rateLimit: paused }, env);
  const id = enqueue(env);

  await registerForegroundRunner({ env, killImpl: killingOnly([process.pid, sibling]) });

  assert.equal(readOwnPause(env)?.pausedUntil, paused.pausedUntil, "a runner born during the pause of a live sibling did not adopt it");
  const slept = [];
  const cycle = await runCycle({
    env,
    deps: {
      gitImpl: fakeGit(),
      sleepImpl: slicedSleep(slept, async (slice) => {
        if (slice === 2) await endOwnPause(env);
      }),
    },
  });

  assert.equal(slept.length, 2, "the fresh runner claimed at once instead of joining the wait");
  assert.equal(cycle.processed[0].status, "done");
  assert.equal(getJob(id, env).status, "done");
});

test("a drain does not exit while this runner waits out a rate limit: it waits in slices and claims once the limit is over", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-drain-waits", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  await hourLongPause(env);
  const slept = [];
  const sleepImpl = slicedSleep(slept, async (slice) => {
    if (slice === 3) await endOwnPause(env);
  });

  const passes = await runDrain({ intervalS: 7, env, deps: { gitImpl: fakeGit(), sleepImpl } });

  assert.deepEqual(slept, [PAUSE_POLL_MS, PAUSE_POLL_MS, PAUSE_POLL_MS], "the drain did not wait the limit out one slice at a time");
  assert.deepEqual(passes.map((pass) => pass.reason), ["empty-queue"], "the drain exited on the rate limit instead of waiting for it");
  assert.deepEqual(passes[0].processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }], "the drain came back before the limit was over");
  assert.equal(getJob(id, env).status, "done");
});

test("a runner told to stop while it waits out a limit comes back within one slice, and says the limit is why it claimed nothing", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-stop-wakes", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  await hourLongPause(env);
  const slept = [];

  const passes = await runDrain({
    intervalS: 7,
    env,
    deps: { gitImpl: fakeGit(), sleepImpl: slicedSleep(slept, (slice) => (slice === 2 ? process.emit("SIGTERM") : undefined)) },
  });

  assert.equal(slept.length, 2, "the shutdown signal was swallowed by the wait instead of ending it on the next slice");
  assert.deepEqual(passes.map((pass) => pass.reason), ["rate-limited"], "a cycle that claimed nothing because of the limit reported another reason");
  assert.equal(passes[0].stopped, true);
  assert.deepEqual(passes[0].processed, []);
  assert.equal(getJob(id, env).status, "pending", "the job was claimed by a runner that was shutting down");
});

test("`queue resume` reaches a runner that is already waiting, and a stamp older than the pause never does", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-resume", [{ stdout: doneStream(), exitCode: 0 }]);
  const first = enqueue(env);
  await hourLongPause(env);
  writeFileSync(queueResumePath(env), `${new Date(Date.now() - 60_000).toISOString()}\n`);
  const stale = [];

  const ignored = await runCycle({
    jobId: first,
    env,
    deps: {
      gitImpl: fakeGit(),
      sleepImpl: slicedSleep(stale, async (slice) => {
        if (slice === 3) await endOwnPause(env);
      }),
    },
  });

  assert.equal(stale.length, 3, "a resume asked for BEFORE the pause was armed cleared it anyway");
  assert.equal(ignored.processed[0].status, "done");

  const second = enqueue(env);
  await hourLongPause(env);
  const fresh = [];

  const resumed = await runCycle({
    jobId: second,
    env,
    deps: {
      gitImpl: fakeGit(),
      sleepImpl: slicedSleep(fresh, () => writeFileSync(queueResumePath(env), `${new Date().toISOString()}\n`)),
    },
  });

  assert.equal(fresh.length, 1, "the runner did not notice the resume on its next slice");
  assert.equal(readOwnPause(env), null, "the runner kept a pause the operator resumed past");
  assert.equal(resumed.processed[0].status, "done");
});

test("`queue pause` wins over a rate limit wait, and an explicit --job claim still obeys it", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-manual-pause", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  await hourLongPause(env);
  ensureHome(env);
  writeFileSync(queuePausedPath(env), `${new Date().toISOString()}\n`);
  const slept = [];

  const manual = await runCycle({ env, deps: { gitImpl: fakeGit(), sleepImpl: slicedSleep(slept) } });
  const drained = await runDrain({ intervalS: 7, env, deps: { gitImpl: fakeGit(), sleepImpl: slicedSleep(slept) } });

  assert.deepEqual(slept, [], "a queue the operator paused by hand slept until the reset instead of stopping now");
  assert.equal(manual.reason, "paused");
  assert.deepEqual(drained.map((pass) => pass.reason), ["paused"], "the drain no longer exits on the manual pause");
  assert.equal(getJob(id, env).status, "pending");

  const byJob = [];
  const claimed = await runCycle({
    jobId: id,
    env,
    deps: {
      gitImpl: fakeGit(),
      sleepImpl: slicedSleep(byJob, async (slice) => {
        if (slice === 2) await endOwnPause(env);
      }),
    },
  });

  assert.equal(byJob.length, 2, "an explicit --job claim bypassed the rate limit gate the way it bypasses the sentinel");
  assert.equal(claimed.processed[0].status, "done");
});
