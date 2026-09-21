import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { runnerRegistryPath } from "../../src/config/paths.mjs";
import { addJob, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { PAUSE_GRACE_S, recordOwnPause } from "../../src/queue/rate-limit.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { runCycle, runWatch, WATCH_INTERVAL_DEFAULT_S } from "../../src/queue/runner.mjs";
import { registerForegroundRunner } from "../../src/queue/start.mjs";
import { resolveWindow } from "../../src/queue/window.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL } from "../../test-support/streams.mjs";

const PROMPT = "fix the worker";

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// A home with one registered project and the fake `claude`, ready to run one job to `done`.
function makeRunnerHome(t, name, attempts = [{ stdout: doneStream(), exitCode: 0 }]) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return env;
}

// Enqueues one job of the test project.
function enqueue(env) {
  return addJob({ project: "alpha", prompt: PROMPT }, env).id;
}

// A sleep double that records every slice it was asked to wait, running the given hook on each one; the hook can end the wait early.
function slicedSleep(slept, onSlice = () => {}) {
  return async (ms) => {
    slept.push(ms);
    await onSlice(slept.length);
  };
}

test("`--from` in the future: the runner claims nothing and, told to stop while it waits, ends with reason `outside-window`", async (t) => {
  const env = makeRunnerHome(t, "window-before-stop");
  const id = enqueue(env);
  const nowMs = Date.UTC(2024, 0, 1, 10, 0);
  const window = { fromMs: nowMs + 3600_000, untilMs: nowMs + 7200_000 };
  const slept = [];

  const cycle = await runCycle({
    env,
    window,
    deps: {
      gitImpl: fakeGit(),
      nowImpl: () => nowMs,
      sleepImpl: slicedSleep(slept, (slice) => (slice === 2 ? process.emit("SIGTERM") : undefined)),
    },
  });

  assert.equal(slept.length, 2, "the shutdown signal was not noticed on the next slice of the wait");
  assert.equal(cycle.reason, "outside-window");
  assert.deepEqual(cycle.processed, [], "a runner waiting for its window to open claimed a job anyway");
  assert.equal(cycle.stopped, true);
  assert.equal(getJob(id, env).status, "pending");
});

test("started already inside the window works immediately: no wait, the job is claimed and runs to done", async (t) => {
  const env = makeRunnerHome(t, "window-inside-immediate");
  const id = enqueue(env);
  const nowMs = Date.UTC(2024, 0, 1, 21, 0);
  const window = { fromMs: nowMs, untilMs: nowMs + 3600_000 };
  const slept = [];

  const cycle = await runCycle({ env, window, deps: { gitImpl: fakeGit(), nowImpl: () => nowMs, sleepImpl: slicedSleep(slept) } });

  assert.deepEqual(slept, [], "a window already open still made the runner wait before claiming");
  assert.deepEqual(cycle.processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }]);
  assert.equal(getJob(id, env).status, "done");
});

test("at `until` the runner stops claiming, reports `window-closed` with the count of jobs left pending, and a running job is never interrupted", async (t) => {
  const env = makeRunnerHome(t, "window-closes-pending");
  const first = enqueue(env);
  const second = enqueue(env);
  let nowMs = Date.UTC(2024, 0, 1, 3, 59, 0);
  const untilMs = Date.UTC(2024, 0, 1, 4, 0, 0);
  const window = { fromMs: nowMs - 3600_000, untilMs };

  const cycle = await runCycle({
    env,
    window,
    deps: {
      gitImpl: fakeGit(),
      nowImpl: () => nowMs,
      sleepImpl: async () => {},
      finishJobImpl: (id, outcome) => {
        // The window's `until` arrives only once the in-flight job has already finished, proving it was never cut short.
        nowMs = untilMs;
        return finishJob(id, outcome, env);
      },
    },
  });

  assert.deepEqual(cycle.processed, [{ id: first, status: "done", prUrl: PR_URL, attempts: 1 }], "a second job was claimed after the window had already closed");
  assert.equal(cycle.reason, "window-closed");
  assert.equal(cycle.windowClosedAt, untilMs);
  assert.equal(cycle.pending, 1, "the job left in the queue was not counted");
  assert.equal(getJob(first, env).status, "done", "the job running when the window closed was interrupted");
  assert.equal(getJob(second, env).status, "pending");
});

test("a rate-limit wait inside the window is cut at `until`: the runner never sleeps past it and closes the window instead of waiting for the reset", async (t) => {
  const env = makeRunnerHome(t, "window-cuts-rate-limit");
  const id = enqueue(env);
  // The pause itself is checked against the REAL clock (`pauseGate` never reads the injected `now`), so it is armed
  // a real hour out - long enough that, absent the cut, this wait would still be going when the test times out.
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "watch" }, env);
  const resetsAt = new Date(Date.now() + 3600_000);
  await recordOwnPause(
    {
      pausedAt: new Date().toISOString(),
      pausedUntil: new Date(resetsAt.getTime() + PAUSE_GRACE_S * 1000).toISOString(),
      resetsAt: resetsAt.toISOString(),
      type: "five_hour",
      utilization: 0.99,
    },
    env,
  );
  let nowMs = Date.UTC(2024, 0, 1, 3, 55);
  const untilMs = Date.UTC(2024, 0, 1, 4, 0);
  const window = { fromMs: nowMs - 3600_000, untilMs };
  const slept = [];

  const cycle = await runCycle({
    env,
    window,
    deps: {
      gitImpl: fakeGit(),
      nowImpl: () => nowMs,
      sleepImpl: slicedSleep(slept, () => {
        nowMs = untilMs;
      }),
    },
  });

  assert.equal(slept.length, 1, "the rate-limit wait kept slicing past the window's `until` instead of being cut there");
  assert.equal(cycle.reason, "window-closed", "the cycle waited for the reset instead of closing the window it had already reached");
  assert.equal(getJob(id, env).status, "pending");
});

// A local instant built from calendar fields, so the window it resolves to reads against whatever timezone the test runs under.
function local(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

test("the watch loop stops on `window-closed` once `until` arrives between two passes, and reports the exact closing line", async (t) => {
  const env = makeRunnerHome(t, "window-watch-stops");
  const id = enqueue(env);
  let nowMs = local(2024, 1, 1, 3, 30);
  const untilMs = local(2024, 1, 1, 4, 0);

  const passes = await runWatch({
    env,
    intervalS: 7,
    from: "03:00",
    until: "04:00",
    onCycle: () => {
      // The window is resolved once, at the start of the watch; time passing between two passes is simulated here.
      nowMs = untilMs;
    },
    deps: { gitImpl: fakeGit(), nowImpl: () => nowMs, sleepImpl: async () => {} },
  });

  assert.equal(passes.length, 2, "the watch did not stop right on the pass that saw the window close");
  assert.equal(passes[0].processed[0]?.status, "done", "the job pending when the window was still open was never run");
  assert.equal(passes[1].reason, "window-closed");
  assert.equal(passes[1].pending, 0, "the job the first pass already finished was still counted as pending");
  assert.equal(getJob(id, env).status, "done");
});

// A spawn double: records every call and answers with a child that has a pid and can be unreferenced.
function fakeSpawn(calls) {
  return (file, args) => {
    calls.push({ file, args });
    return { pid: 4242, unref: () => {} };
  };
}

// A kill double: nothing is alive, so a stale pidfile never blocks the command under test.
function fakeKill() {
  return (pid) => {
    const err = new Error(`kill ESRCH ${pid}`);
    err.code = "ESRCH";
    throw err;
  };
}

// Runs the CLI in this process, with spawn and kill injected so nothing real ever starts.
async function runCli(env, argv, { calls = [] } = {}) {
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line), spawnImpl: fakeSpawn(calls), killImpl: fakeKill() };
  const code = await run(argv, ctx);
  return { code, out, err, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

// A home with one registered project, for the CLI-level tests that never reach a runner.
function makeCliHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

test("`--from`/`--until` without `--watch` are refused", async (t) => {
  const env = makeCliHome(t, "window-cli-no-watch");
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--until", "04:00"], { calls });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--from.*--until.*--watch|--watch/);
  assert.equal(calls.length, 0);
});

test("`--from` without `--until` is refused", async (t) => {
  const env = makeCliHome(t, "window-cli-from-alone");
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--watch", "--from", "19:00"], { calls });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--from.*--until|requires/);
  assert.equal(calls.length, 0);
});

test("`--from` equal to `--until` is refused", async (t) => {
  const env = makeCliHome(t, "window-cli-equal");
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--watch", "--from", "19:00", "--until", "19:00"], { calls });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /same time|equal/);
  assert.equal(calls.length, 0);
});

test("a malformed clock (not two-digit HH:MM) is refused", async (t) => {
  const env = makeCliHome(t, "window-cli-malformed");
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--watch", "--from", "9:05", "--until", "04:00"], { calls });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /HH:MM/);
  assert.equal(calls.length, 0);
});

test("`--from`/`--until` next to `--job` are refused", async (t) => {
  const env = makeCliHome(t, "window-cli-job");
  const job = addJob({ project: "alpha", prompt: "fix it" }, env);
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--job", String(job.id), "--until", "04:00"], { calls });

  assert.equal(result.code, 1);
  assert.equal(calls.length, 0);
});

test("the detached start forwards `--from` and `--until` to the child", async (t) => {
  const env = makeCliHome(t, "window-cli-detached-args");
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--watch", "--from", "19:00", "--until", "04:00"], { calls });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls.length, 1);
  assert.deepEqual(argSlice(calls[0].args, "--from"), ["--from", "19:00"]);
  assert.deepEqual(argSlice(calls[0].args, "--until"), ["--until", "04:00"]);
  assert.ok(calls[0].args.includes("--foreground"), "the detached child must run with --foreground");
});

// The two-token slice of an argv starting at the given flag, or null when the flag is missing.
function argSlice(args, flag) {
  const index = args.indexOf(flag);
  return index < 0 ? null : args.slice(index, index + 2);
}

// The wall clock `offsetMinutes` from now, `HH:MM` - a `--from`/`--until` built this way always opens in the future,
// whatever the local time of day the suite runs at, so `resolveWindow` lands on the deterministic "before" branch
// instead of the "already inside" one, which tracks `now` itself and cannot be bracketed.
function futureClock(offsetMinutes) {
  const at = new Date(Date.now() + offsetMinutes * 60_000);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
}

// The window a registration must carry for `--from`/`--until`, resolved at either edge of the call under test - a
// fixture derived at runtime, since `resolveWindow` reads the real clock and no instant of it can be hardcoded.
function eitherEdgeWindow(spec, beforeMs, afterMs) {
  return [beforeMs, afterMs].map((nowMs) => {
    const { fromMs, untilMs } = resolveWindow({ ...spec, nowMs });
    return { from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString() };
  });
}

test("`queue run --watch --from --until` registers the window it resolves as absolute ISO instants", async (t) => {
  const env = makeCliHome(t, "window-cli-detached-registration");
  const calls = [];
  const spec = { from: futureClock(10), until: futureClock(190) };
  const beforeMs = Date.now();

  const result = await runCli(env, ["queue", "run", "--watch", "--from", spec.from, "--until", spec.until], { calls });
  const afterMs = Date.now();

  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(readFileSync(runnerRegistryPath(4242, env), "utf8"));
  const edges = eitherEdgeWindow(spec, beforeMs, afterMs);
  assert.ok(edges.some((edge) => JSON.stringify(edge) === JSON.stringify(info.window)), `the registered window matched neither edge: ${JSON.stringify(info.window)}`);
});

test("`queue run --watch` with no `--until` registers no window at all", async (t) => {
  const env = makeCliHome(t, "window-cli-detached-no-window");
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--watch"], { calls });

  assert.equal(result.code, 0, result.stderr);
  const info = JSON.parse(readFileSync(runnerRegistryPath(4242, env), "utf8"));
  assert.equal(info.window, null);
});

test("a foreground registration carries the same resolved window as a detached one, and none when `--until` is absent", async (t) => {
  const env = makeCliHome(t, "window-foreground-registration");
  const spec = { from: futureClock(10), until: futureClock(190) };
  const beforeMs = Date.now();

  const guard = await registerForegroundRunner({ env, watchIntervalS: 30, from: spec.from, until: spec.until });
  const afterMs = Date.now();

  const info = JSON.parse(readFileSync(runnerRegistryPath(guard.pid, env), "utf8"));
  const edges = eitherEdgeWindow(spec, beforeMs, afterMs);
  assert.ok(edges.some((edge) => JSON.stringify(edge) === JSON.stringify(info.window)), `the registered window matched neither edge: ${JSON.stringify(info.window)}`);

  const noWindowEnv = makeCliHome(t, "window-foreground-no-window");
  const noWindowGuard = await registerForegroundRunner({ env: noWindowEnv, watchIntervalS: 30 });
  const noWindowInfo = JSON.parse(readFileSync(runnerRegistryPath(noWindowGuard.pid, noWindowEnv), "utf8"));
  assert.equal(noWindowInfo.window, null);
});
