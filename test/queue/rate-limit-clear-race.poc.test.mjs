import assert from "node:assert/strict";
import { test } from "node:test";
import { clearOwnPauseIfOver, ownPauseUntilMs, PAUSE_GRACE_S, readOwnPause, recordOwnPause } from "../../src/queue/rate-limit.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// A pause region shaped the way `pauseFromEvent` writes it, at an arbitrary future/past instant.
function pauseRegion(untilMs, { type = "five_hour", utilization = 0.99 } = {}) {
  return {
    pausedAt: new Date(untilMs - 3600_000).toISOString(),
    pausedUntil: new Date(untilMs).toISOString(),
    resetsAt: new Date(untilMs - PAUSE_GRACE_S * 1000).toISOString(),
    type,
    utilization,
  };
}

// A registration of THIS process, the only file a runner ever writes its own pause into.
function registerSelf(env) {
  return writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain" }, env);
}

test("a pause a concurrent job just extended must survive a clear decided against the earlier, now-stale read", async (t) => {
  const env = makeHome(t, "rate-limit-clear-race");
  registerSelf(env);

  // Step 1: an already-expired pause is on record, the way a previous rate-limit wait left it.
  await recordOwnPause(pauseRegion(Date.now() - 1000), env);

  // Step 2: `pauseGate` reads it and decides "expired, forget it" (ownPauseUntilMs returns null).
  assert.equal(ownPauseUntilMs(env), null, "setup: the initial pause should already read as expired");

  // Step 3: BEFORE the delayed clear executes, a concurrent job on the SAME runner receives a
  // fresh rejection/warning and extends the pause further into the future.
  const extendedUntilMs = Date.now() + 3600_000;
  await recordOwnPause(pauseRegion(extendedUntilMs), env);
  assert.equal(readOwnPause(env).pausedUntil, new Date(extendedUntilMs).toISOString(), "setup: the concurrent extension should be on record before the clear runs");

  // Step 4: NOW the delayed clear that `pauseGate` had already decided on (back in step 2) executes.
  await clearOwnPauseIfOver(env);

  // The runner's own most-recent limit information must never be silently discarded by an
  // earlier, now-stale "it's expired" decision: the concurrent extension must survive the clear.
  assert.equal(ownPauseUntilMs(env), extendedUntilMs, "the concurrent pause extension was wiped by a stale clear decided before it was written");
});
