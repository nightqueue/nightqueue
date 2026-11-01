import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { jobLogPath, queuePausedPath, queueResumePath, runnerRegistryPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { clearOwnPause, inheritablePause, PAUSE_GRACE_S, PAUSE_POLL_MS, readOwnPause, recordOwnPause } from "../../src/queue/rate-limit.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { rateLimitExit, runCycle, runDrain } from "../../src/queue/runner.mjs";
import { extractRateLimitFromEventLine } from "../../src/queue/stream.mjs";
import { registerForegroundRunner } from "../../src/queue/start.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL, rateLimitEvent, systemInitEvent, toNdjson, recordedDone } from "../../test-support/streams.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";

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
  return addJob({ projectId: ensureProject(env, "alpha"), prompt: PROMPT }, env).id;
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
  const env = makeRunnerHome(t, "rate-limit-idle-survives", [{ stdout: limited, holdMs: silenceMs, tail: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const id = enqueue(env);

  assert.ok(silenceMs > idleTimeoutS * 1000, "the fixture does not keep the child silent longer than the idle timeout");
  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), idleTimeoutS, stopPollMs: 500 } });

  assert.deepEqual(cycle.processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }], "the silence of the limit ended the attempt");
  const row = getJob(id, env);
  assert.deepEqual({ status: row.status, attempts: row.attempts }, { status: "done", attempts: 1 });
  assert.equal(readOwnPause(env).pausedUntil, new Date((resetsAtS + PAUSE_GRACE_S) * 1000).toISOString(), "the event that fired armed no pause");
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /=== rate limit until \S+ @ \S+ ===/, "the job log says nothing about the wait");
});

// A registry that refuses the pause never costs the child its protection: that run lives in
// `test/queue/rate-limit-write-failure.test.mjs`, the named regression net of that break.

test("a runner waiting out its own limit never stops another runner of the same home from claiming", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-sibling-claims", [{ stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const sibling = process.pid + 1;
  const killImpl = killingOnly([process.pid, sibling]);
  const paused = { pausedAt: new Date().toISOString(), pausedUntil: new Date(Date.now() + 3600_000).toISOString(), resetsAt: new Date(Date.now() + 3540_000).toISOString(), type: "five_hour", utilization: 0.99 };
  writeRunnerRecord({ pid: sibling, startedAt: new Date().toISOString(), mode: "watch", rateLimit: paused }, env);
  const id = enqueue(env);
  const slept = [];

  const cycle = await runCycle({ env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: slicedSleep(slept), maintenanceImpl: keepRegistry } });

  assert.ok(inheritablePause(env, killImpl), "the fixture left no live pause on the other runner, so the test proves nothing");
  assert.equal(readOwnPause(env), null, "the pause of another runner was adopted by a runner that was already claiming");
  assert.deepEqual(slept, [], "a runner waited out a limit that belongs to another runner");
  assert.equal(cycle.processed[0].status, "done");
  assert.equal(getJob(id, env).status, "done");
});

test("a runner registered while a live runner of this home waits out a limit joins the wait instead of claiming", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-adoption", [{ stdout: doneStream(), runState: recordedDone(), exitCode: 0 }], { register: false });
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
      worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(),
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
  const env = makeRunnerHome(t, "rate-limit-drain-waits", [{ stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const id = enqueue(env);
  await hourLongPause(env);
  const slept = [];
  const sleepImpl = slicedSleep(slept, async (slice) => {
    if (slice === 3) await endOwnPause(env);
  });

  const passes = await runDrain({ intervalS: 7, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl } });

  assert.deepEqual(slept, [PAUSE_POLL_MS, PAUSE_POLL_MS, PAUSE_POLL_MS], "the drain did not wait the limit out one slice at a time");
  assert.deepEqual(passes.map((pass) => pass.reason), ["empty-queue"], "the drain exited on the rate limit instead of waiting for it");
  assert.deepEqual(passes[0].processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }], "the drain came back before the limit was over");
  assert.equal(getJob(id, env).status, "done");
});

test("a runner told to stop while it waits out a limit comes back within one slice, and says the limit is why it claimed nothing", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-stop-wakes", [{ stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const id = enqueue(env);
  await hourLongPause(env);
  const slept = [];

  const passes = await runDrain({
    intervalS: 7,
    env,
    deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: slicedSleep(slept, (slice) => (slice === 2 ? process.emit("SIGTERM") : undefined)) },
  });

  assert.equal(slept.length, 2, "the shutdown signal was swallowed by the wait instead of ending it on the next slice");
  assert.deepEqual(passes.map((pass) => pass.reason), ["rate-limited"], "a cycle that claimed nothing because of the limit reported another reason");
  assert.equal(passes[0].stopped, true);
  assert.deepEqual(passes[0].processed, []);
  assert.equal(getJob(id, env).status, "pending", "the job was claimed by a runner that was shutting down");
});

test("`queue resume` reaches a runner that is already waiting, and a stamp older than the pause never does", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-resume", [{ stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const first = enqueue(env);
  await hourLongPause(env);
  writeFileSync(queueResumePath(env), `${new Date(Date.now() - 60_000).toISOString()}\n`);
  const stale = [];

  const ignored = await runCycle({
    jobId: first,
    env,
    deps: {
      worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(),
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
      worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(),
      sleepImpl: slicedSleep(fresh, () => writeFileSync(queueResumePath(env), `${new Date().toISOString()}\n`)),
    },
  });

  assert.equal(fresh.length, 1, "the runner did not notice the resume on its next slice");
  assert.equal(readOwnPause(env), null, "the runner kept a pause the operator resumed past");
  assert.equal(resumed.processed[0].status, "done");
});

test("`queue pause` wins over a rate limit wait, and an explicit --job claim still obeys it", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-manual-pause", [{ stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const id = enqueue(env);
  await hourLongPause(env);
  ensureHome(env);
  writeFileSync(queuePausedPath(env), `${new Date().toISOString()}\n`);
  const slept = [];

  const manual = await runCycle({ env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: slicedSleep(slept) } });
  const drained = await runDrain({ intervalS: 7, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: slicedSleep(slept) } });

  assert.deepEqual(slept, [], "a queue the operator paused by hand slept until the reset instead of stopping now");
  assert.equal(manual.reason, "paused");
  assert.deepEqual(drained.map((pass) => pass.reason), ["paused"], "the drain no longer exits on the manual pause");
  assert.equal(getJob(id, env).status, "pending");

  const byJob = [];
  const claimed = await runCycle({
    jobId: id,
    env,
    deps: {
      worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(),
      sleepImpl: slicedSleep(byJob, async (slice) => {
        if (slice === 2) await endOwnPause(env);
      }),
    },
  });

  assert.equal(byJob.length, 2, "an explicit --job claim bypassed the rate limit gate the way it bypasses the sentinel");
  assert.equal(claimed.processed[0].status, "done");
});

const RESETS_AT_S = Math.floor(Date.now() / 1000) + 3600;
const RESETS_AT_ISO = new Date(RESETS_AT_S * 1000).toISOString();
const REJECTED = rateLimitEvent({ status: "rejected", resetsAt: RESETS_AT_S });
const ALLOWED = rateLimitEvent({ status: "allowed", resetsAt: RESETS_AT_S });
const WARNED = rateLimitEvent({ status: "allowed_warning", fiveHour: 0.95 });
const HOLD_MS = 1500;

// The stream of a session that reported these rate limit events.
function limitStream(...events) {
  return toNdjson([systemInitEvent({}), ...events]);
}

// What the runner knows of an attempt whose stream reported these events, in the shape `rateLimitExit` reads.
function factsOf(...events) {
  const infos = events.map((event) => extractRateLimitFromEventLine(JSON.stringify(event)));
  return { rateLimit: infos.at(-1) ?? null, pause: null };
}

// Runs one job through a real cycle against the given fake attempts; the attempt's own clock never sleeps for real.
async function runLimited(t, name, attempts) {
  const env = makeRunnerHome(t, name, attempts);
  const id = enqueue(env);
  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });
  return { env, id, cycle };
}

// Starts one job and answers once the pause its stream armed is on the registration, with the cycle still running.
async function untilPauseArmed(t, name, attempts) {
  const env = makeRunnerHome(t, name, attempts);
  const id = enqueue(env);
  const running = runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });
  for (let poll = 0; poll < 200 && !readOwnPause(env); poll += 1) await delay(10);
  assert.ok(readOwnPause(env), "the rejection armed no pause, so the test proves nothing");
  return { env, id, running };
}

test("rateLimitExit parks only on a last event that is rejected, and only after a process that failed on its own", () => {
  const failed = { exitCode: 1 };
  assert.equal(rateLimitExit(failed, factsOf(REJECTED)), RESETS_AT_ISO);
  assert.equal(rateLimitExit(failed, factsOf(WARNED, REJECTED)), RESETS_AT_ISO);
  assert.equal(rateLimitExit(failed, factsOf(REJECTED, ALLOWED)), null);
  assert.equal(rateLimitExit(failed, factsOf(REJECTED, WARNED)), null);
  assert.equal(rateLimitExit(failed, factsOf(WARNED)), null);
  assert.equal(rateLimitExit(failed, factsOf()), null);
  assert.equal(rateLimitExit(failed, { rateLimit: { status: "rejected" }, pause: null }), null, "a rejection with no known reset has nothing to park until");
  for (const process of [{ exitCode: 0 }, { exitCode: 1, timedOut: true }, { exitCode: 1, idleTimedOut: true }, { exitCode: 1, stopped: true }, { exitCode: 1, spawnError: "ENOENT" }]) {
    assert.equal(rateLimitExit(process, factsOf(REJECTED)), null, `parked after ${JSON.stringify(process)}`);
  }
});

test("rateLimitExit prefers the pause the attempt holds, which may run further than the last rejection", () => {
  const held = { resetsAt: "2099-01-01T00:00:00.000Z" };
  assert.equal(rateLimitExit({ exitCode: 1 }, { ...factsOf(REJECTED), pause: held }), held.resetsAt);
  assert.equal(rateLimitExit({ exitCode: 1 }, { ...factsOf(ALLOWED), pause: held }), null, "a held pause parked an attempt whose last event was not a rejection");
});

test("a rejection then a non-zero exit parks the job at the reset", async (t) => {
  const { env, id, cycle } = await runLimited(t, "rate-limit-last-rejected", [{ stdout: limitStream(REJECTED), exitCode: 1 }]);

  assert.deepEqual(cycle.processed, [{ id, status: "rate-limited", attempts: 1, notBefore: RESETS_AT_ISO }]);
  assert.equal(getJob(id, env).status, "pending");
});

test("a rejection the provider took back with `allowed` does not park a non-zero exit, and the pause is gone from the registration", async (t) => {
  const { env, id, cycle } = await runLimited(t, "rate-limit-taken-back", [{ stdout: limitStream(REJECTED, ALLOWED), exitCode: 1 }]);

  const row = getJob(id, env);
  assert.equal(cycle.processed[0].status, "failed", "the stale rejection parked the job");
  assert.deepEqual({ status: row.status, notBefore: row.not_before, notice: row.notice_md }, { status: "failed", notBefore: null, notice: "the session exited with code 1" });
  assert.equal(readOwnPause(env), null, "`allowed` left the registration holding the pause, in line order or not");
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /=== rate limit until \S+ @ \S+ ===/, "the fixture armed no pause, so the clear proves nothing");
});

test("a warning at the threshold then a non-zero exit is classified, not parked, and the warning's pause keeps holding", async (t) => {
  const { env, id, cycle } = await runLimited(t, "rate-limit-warning-exit", [{ stdout: limitStream(WARNED), exitCode: 1 }]);

  assert.equal(cycle.processed[0].status, "failed", "a warning parked a failure it did not cause");
  assert.equal(getJob(id, env).notice_md, "the session exited with code 1");
  assert.ok(readOwnPause(env), "the warning armed no pause, so it stopped protecting the next claim");
});

test("`allowed_warning` never clears a pause the attempt holds", async (t) => {
  const { env } = await runLimited(t, "rate-limit-warning-keeps", [{ stdout: limitStream(REJECTED, WARNED), exitCode: 1 }]);

  assert.equal(readOwnPause(env)?.resetsAt, RESETS_AT_ISO);
});

test("`allowed` in an attempt that armed nothing leaves the pause on record alone", async (t) => {
  const env = makeRunnerHome(t, "rate-limit-allowed-no-pause", [{ stdout: limitStream(), holdMs: HOLD_MS, tail: limitStream(ALLOWED), exitCode: 1 }]);
  const id = enqueue(env);
  const running = runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });
  for (let poll = 0; poll < 200 && getJob(id, env).status !== "running"; poll += 1) await delay(10);
  assert.equal(getJob(id, env).status, "running", "the job never started, so the test proves nothing");
  await hourLongPause(env);
  const onRecord = readOwnPause(env);

  await running;

  assert.deepEqual(readOwnPause(env), onRecord, "`allowed` cleared a pause this attempt never held");
});

test("`allowed` never clears a newer pause a concurrent job armed over this attempt's one", async (t) => {
  const stdout = limitStream(REJECTED);
  const { env, running } = await untilPauseArmed(t, "rate-limit-concurrent-pause", [{ stdout, holdMs: HOLD_MS, tail: limitStream(ALLOWED), exitCode: 1 }]);
  await hourLongPause(env);
  const newer = readOwnPause(env);

  await running;

  assert.deepEqual(readOwnPause(env), newer, "the clear wiped a pause it was not decided from");
});

test("a clear the registration refuses is one line of the job log, and costs the run nothing", async (t) => {
  const stdout = limitStream(REJECTED);
  const { env, id, running } = await untilPauseArmed(t, "rate-limit-clear-refused", [{ stdout, holdMs: HOLD_MS, tail: limitStream(ALLOWED), exitCode: 1 }]);
  rmSync(runnerRegistryPath(process.pid, env), { force: true });

  const cycle = await running;

  assert.equal(cycle.processed[0].status, "failed");
  const refusals = readFileSync(jobLogPath(id, env), "utf8").split("\n").filter((line) => line.startsWith("the rate limit pause could not be cleared"));
  assert.equal(refusals.length, 1, "the failed clear was swallowed or said twice");
});
