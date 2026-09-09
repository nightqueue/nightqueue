import assert from "node:assert/strict";
import { test } from "node:test";
import { stopRunner, writeRunnerPidfile } from "../../src/queue/pidfile.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const RECYCLED_PID = 424243;

// A kill double for a pid recycled by some unrelated process of the same boot: it always answers, SIGTERM included.
function fakeRecycledKill(pid, signals) {
  return (probedPid, signal) => {
    signals.push([probedPid, signal]);
    if (probedPid !== pid) throw Object.assign(new Error(`kill ESRCH ${probedPid}`), { code: "ESRCH" });
    return true;
  };
}

test("stop never signals a pid whose identity as the runner was not confirmed, even inside the same boot", { skip: "known limitation: a pid recycled inside the same boot session is still trusted; confirming real process identity needs ps//proc - tracked in a dedicated ticket" }, async (t) => {
  const env = makeHome(t, "pidfile-same-boot-reuse");
  const startedAt = new Date().toISOString();
  writeRunnerPidfile({ pid: RECYCLED_PID, startedAt, mode: "watch", intervalS: 30, logPath: "/tmp/runner.log" }, env);

  const signals = [];
  await stopRunner({ env, killImpl: fakeRecycledKill(RECYCLED_PID, signals), sleepImpl: async () => {} });

  const sigterms = signals.filter(([, signal]) => signal === "SIGTERM");
  assert.equal(sigterms.length, 0, "a SIGTERM was sent to a pid whose identity as the registered runner was never confirmed");
});
