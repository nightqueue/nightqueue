import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { run } from "../../src/cli/index.mjs";
import { lockPath } from "../../src/config/lock.mjs";
import { runnerPidPath } from "../../src/config/paths.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// A spawn double that reports whether the cross-process lock was held while the guard-then-register section ran.
function spawnCheckingLock(env, observations) {
  return () => {
    observations.push(existsSync(lockPath(env)));
    return { pid: 4242, unref: () => {} };
  };
}

test("queue run --watch holds the cross-process lock across the single-watcher guard and the pidfile registration", async (t) => {
  const env = makeHome(t, "detached-watch-lock");
  const observations = [];
  const ctx = {
    out: () => {},
    err: () => {},
    env,
    cwd: process.cwd(),
    spawnImpl: spawnCheckingLock(env, observations),
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };

  const code = await run(["queue", "run", "--watch", "5"], ctx);

  assert.equal(code, 0);
  assert.equal(observations.length, 1, "the detached child was not spawned");
  assert.equal(
    observations[0],
    true,
    "two `queue run --watch` processes racing to read the pidfile and register the winner must be serialized by the cross-process lock; today `queue` is listed in SELF_LOCKING_COMMANDS (src/cli/index.mjs) so `main` never calls `withLock` around it, and `startDetached` runs the guard-read and the pidfile-write with no lock held at all",
  );
  assert.equal(existsSync(runnerPidPath(env)), true, "the winning watcher registered itself");
  assert.equal(JSON.parse(readFileSync(runnerPidPath(env), "utf8")).pid, 4242);
});
