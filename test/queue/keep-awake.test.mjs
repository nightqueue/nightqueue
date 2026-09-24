import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { jobLogPath } from "../../src/config/paths.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import {
  holdJobAwake,
  holdRunnerAwake,
  keepAwakeArgs,
  keepAwakeMode,
  resolveCaffeinateBin,
} from "../../src/queue/keep-awake.mjs";
import { runCycle, runDrain, runWatch } from "../../src/queue/runner.mjs";
import { spawnClaude } from "../../src/queue/spawn.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const PLATFORMS_WITHOUT_HOLD = ["linux", "win32", "freebsd", "aix"];

test("keepAwakeArgs: `-s` for the runner in auto, `-i` in always, `-i` for a job in every mode, none when off", () => {
  assert.deepEqual(keepAwakeArgs({ platform: "darwin", mode: "auto", kind: "runner", pid: 4242 }), ["-s", "-w", "4242"]);
  assert.deepEqual(keepAwakeArgs({ platform: "darwin", mode: "always", kind: "runner", pid: 4242 }), ["-i", "-w", "4242"]);
  assert.equal(keepAwakeArgs({ platform: "darwin", mode: "off", kind: "runner", pid: 4242 }), null);
  assert.deepEqual(keepAwakeArgs({ platform: "darwin", mode: "auto", kind: "job", pid: 4242 }), ["-i", "-w", "4242"]);
  assert.deepEqual(keepAwakeArgs({ platform: "darwin", mode: "always", kind: "job", pid: 4242 }), ["-i", "-w", "4242"]);
  assert.equal(keepAwakeArgs({ platform: "darwin", mode: "off", kind: "job", pid: 4242 }), null);
});

test("keepAwakeArgs is a silent no-op on any platform but darwin, whatever the mode", () => {
  for (const platform of PLATFORMS_WITHOUT_HOLD) {
    for (const mode of ["auto", "always", "off"]) {
      for (const kind of ["runner", "job"]) {
        assert.equal(keepAwakeArgs({ platform, mode, kind, pid: 1 }), null, `${platform}/${mode}/${kind}`);
      }
    }
  }
});

test("`-d` never appears in any hold's argv: the display is always allowed to sleep", () => {
  for (const mode of ["auto", "always", "off"]) {
    for (const kind of ["runner", "job"]) {
      const args = keepAwakeArgs({ platform: "darwin", mode, kind, pid: 1 }) ?? [];
      assert.equal(args.includes("-d"), false);
    }
  }
});

// A directory with one executable file named `caffeinate`, standing in for the real binary; it is never run.
function fakeCaffeinateDir(t) {
  const dir = makeDir(t, "caffeinate-bin");
  const bin = join(dir, "caffeinate");
  writeFileSync(bin, "#!/bin/sh\nexit 1\n");
  chmodSync(bin, 0o755);
  return { dir, bin };
}

test("resolveCaffeinateBin: an operator override that resolves, one that does not, and a PATH lookup", (t) => {
  const { dir, bin } = fakeCaffeinateDir(t);

  assert.equal(resolveCaffeinateBin({ NIGHTQUEUE_CAFFEINATE_BIN: bin }), bin);
  assert.equal(resolveCaffeinateBin({ NIGHTQUEUE_CAFFEINATE_BIN: join(dir, "does-not-exist") }), null);
  assert.equal(resolveCaffeinateBin({ PATH: dir }), bin);
  assert.equal(resolveCaffeinateBin({ PATH: "/does/not/exist/at/all" }), null);
  assert.equal(resolveCaffeinateBin({}), null);
});

// A home whose config.json carries the given `queue.keepAwake` mode.
function homeWithKeepAwake(t, name, mode) {
  const env = makeHome(t, name);
  const config = loadConfig(env);
  saveConfig({ ...config, queue: { ...config.queue, keepAwake: mode } }, env);
  return env;
}

test("keepAwakeMode reads the normalized `queue.keepAwake` of the home, defaulting to auto", (t) => {
  assert.equal(keepAwakeMode(makeHome(t, "keep-awake-mode-default")), "auto");
  assert.equal(keepAwakeMode(homeWithKeepAwake(t, "keep-awake-mode-always", "always")), "always");
  assert.equal(keepAwakeMode(homeWithKeepAwake(t, "keep-awake-mode-off", "off")), "off");
});

test("holdRunnerAwake spawns `-s -w <pid>` in auto and `-i -w <pid>` in always, detached and unref'ed", (t) => {
  const auto = [];
  const spawnAuto = (bin, args, options) => {
    auto.push({ bin, args, options });
    return { on: () => {}, unref: () => {} };
  };
  holdRunnerAwake({
    pid: 555,
    env: makeHome(t, "keep-awake-runner-auto"),
    deps: { spawnImpl: spawnAuto, resolveBinImpl: () => "/usr/bin/caffeinate", platform: "darwin" },
  });
  assert.equal(auto.length, 1);
  assert.deepEqual(auto[0].args, ["-s", "-w", "555"]);

  const always = [];
  const spawnAlways = (bin, args, options) => {
    always.push({ bin, args, options });
    return { on: () => {}, unref: () => {} };
  };
  holdRunnerAwake({
    pid: 555,
    env: homeWithKeepAwake(t, "keep-awake-runner-always", "always"),
    deps: { spawnImpl: spawnAlways, resolveBinImpl: () => "/usr/bin/caffeinate", platform: "darwin" },
  });

  assert.equal(always.length, 1);
  assert.deepEqual(always[0].args, ["-i", "-w", "555"]);
  assert.equal(always[0].bin, "/usr/bin/caffeinate");
  assert.equal(always[0].options.stdio, "ignore");
  assert.equal(always[0].options.detached, true);
});

test("holdRunnerAwake spawns nothing when `queue.keepAwake` is off", (t) => {
  const calls = [];
  holdRunnerAwake({
    pid: 555,
    env: homeWithKeepAwake(t, "keep-awake-runner-off", "off"),
    deps: { spawnImpl: (...args) => calls.push(args), resolveBinImpl: () => "/usr/bin/caffeinate", platform: "darwin" },
  });
  assert.equal(calls.length, 0);
});

test("holdJobAwake always spawns `-i -w <pid>`, in auto and in always alike", (t) => {
  for (const mode of ["auto", "always"]) {
    const calls = [];
    holdJobAwake({
      pid: 777,
      env: mode === "auto" ? makeHome(t, `keep-awake-job-${mode}`) : homeWithKeepAwake(t, `keep-awake-job-${mode}`, mode),
      deps: {
        spawnImpl: (bin, args, options) => {
          calls.push({ bin, args, options });
          return { on: () => {}, unref: () => {} };
        },
        resolveBinImpl: () => "/usr/bin/caffeinate",
        platform: "darwin",
      },
    });
    assert.deepEqual(calls[0].args, ["-i", "-w", "777"], mode);
  }
});

test("neither hold spawns anything outside darwin, and no warning is written either", (t) => {
  const written = [];
  const restore = t.mock.method(process.stderr, "write", (chunk) => {
    written.push(String(chunk));
    return true;
  });
  const calls = [];
  const deps = { spawnImpl: (...args) => calls.push(args), resolveBinImpl: () => "/usr/bin/caffeinate", platform: "linux" };
  holdRunnerAwake({ pid: 1, env: makeHome(t, "keep-awake-linux-runner"), deps });
  holdJobAwake({ pid: 2, env: makeHome(t, "keep-awake-linux-job"), deps });
  restore.mock.restore();

  assert.equal(calls.length, 0);
  assert.equal(written.length, 0);
});

// Captures every line this test writes to stderr, restored automatically at the end of the test.
function captureStderr(t) {
  const written = [];
  t.mock.method(process.stderr, "write", (chunk) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

test("a caffeinate binary that cannot be found warns once and never throws", (t) => {
  const written = captureStderr(t);
  assert.doesNotThrow(() => {
    holdRunnerAwake({
      pid: 1,
      env: makeHome(t, "keep-awake-not-found"),
      deps: { spawnImpl: () => ({ on: () => {}, unref: () => {} }), resolveBinImpl: () => null, platform: "darwin" },
    });
  });
  assert.equal(written.filter((line) => line.includes("could not keep the machine awake")).length, 1);
});

test("a spawn that throws synchronously warns once and never throws out of the hold", (t) => {
  const written = captureStderr(t);
  assert.doesNotThrow(() => {
    holdRunnerAwake({
      pid: 1,
      env: makeHome(t, "keep-awake-throws"),
      deps: {
        spawnImpl: () => {
          throw new Error("boom");
        },
        resolveBinImpl: () => "/usr/bin/caffeinate",
        platform: "darwin",
      },
    });
  });
  assert.equal(written.filter((line) => line.includes("could not keep the machine awake") && line.includes("boom")).length, 1);
});

test("a spawn that fails asynchronously warns once, without ever costing the caller", async (t) => {
  const written = captureStderr(t);
  const child = new EventEmitter();
  child.unref = () => {};
  holdJobAwake({
    pid: 1,
    env: makeHome(t, "keep-awake-async-error"),
    deps: { spawnImpl: () => child, resolveBinImpl: () => "/usr/bin/caffeinate", platform: "darwin" },
  });
  child.emit("error", new Error("spawn EACCES"));
  await Promise.resolve();

  assert.equal(written.filter((line) => line.includes("could not keep the machine awake") && line.includes("EACCES")).length, 1);
});

// A fake child of `spawnClaude`, closing on its own right away; `pid` stands in for the process the child would have.
function fakeClaudeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  process.nextTick(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0);
  });
  return child;
}

test("spawnClaude threads the child's own pid into the per-job hold, never the runner's", async (t) => {
  const env = makeHome(t, "keep-awake-spawn-claude");
  const calls = [];
  const childPid = 99999;

  await spawnClaude({
    prompt: "p",
    timeoutS: 30,
    logPath: jobLogPath(1, env),
    env,
    spawnImpl: () => fakeClaudeChild(childPid),
    holdJobAwakeImpl: (opts) => calls.push(opts),
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, childPid);
  assert.notEqual(calls[0].pid, process.pid);
});

// Waits without a real timer, recording every slice asked for.
function slicedSleep(slept) {
  return async (ms) => {
    slept.push(ms);
  };
}

test("runCycle holds the runner awake once for a single `--job` run, even when there is nothing to claim", async (t) => {
  const env = makeHome(t, "keep-awake-runcycle-job");
  const calls = [];

  const cycle = await runCycle({ jobId: 999, env, deps: { keepAwakeImpl: (opts) => calls.push(opts) } });

  assert.equal(cycle.reason, "unknown-job");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, process.pid);
});

test("a bare `runCycle({ jobId: null })` (e.g. `queue run --foreground` with no --job/--watch/--drain) still holds the runner awake once, with its own pid", async (t) => {
  const env = makeHome(t, "keep-awake-runcycle-bare");
  const calls = [];

  await runCycle({ jobId: null, env, deps: { keepAwakeImpl: (opts) => calls.push(opts) } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, process.pid);
});

test("runCycle takes no hold of its own when called with `keepAwake: false`, the way runWatch/runDrain call it on every pass after their own start", async (t) => {
  const env = makeHome(t, "keep-awake-runcycle-suppressed");
  const calls = [];

  await runCycle({ env, keepAwake: false, deps: { keepAwakeImpl: (opts) => calls.push(opts) } });

  assert.equal(calls.length, 0);
});

test("runWatch holds the runner awake exactly once, however many passes it makes", async (t) => {
  const env = makeHome(t, "keep-awake-runwatch");
  const calls = [];
  const slept = [];

  await runWatch({ env, cycles: 3, deps: { keepAwakeImpl: (opts) => calls.push(opts), sleepImpl: slicedSleep(slept) } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, process.pid);
});

test("runDrain holds the runner awake exactly once, however many passes it makes", async (t) => {
  const env = makeHome(t, "keep-awake-rundrain");
  const calls = [];
  const slept = [];

  await runDrain({ env, cycles: 3, deps: { keepAwakeImpl: (opts) => calls.push(opts), sleepImpl: slicedSleep(slept) } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].pid, process.pid);
});
