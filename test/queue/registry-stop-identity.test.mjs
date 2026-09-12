import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { test } from "node:test";
import { runnerRegistryPath, runnersDir } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { stopRunner } from "../../src/queue/registry.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// Writes one registration by hand, the shape a runner of another process would have left.
function writeRecord(env, content) {
  ensureHome(env);
  mkdirSync(runnersDir(env), { recursive: true });
  writeFileSync(runnerRegistryPath(content.pid, env), `${JSON.stringify(content)}\n`);
}

test("stopRunner sends a real SIGTERM to a pid whose registration comes from an earlier boot session", async (t) => {
  const env = makeHome(t, "stop-identity-reused-pid");
  const REUSED_PID = 55555;
  // `uptimeS` here is above the current uptime, so the registration can only come from an earlier
  // boot session: whatever answers under that pid now is another process, never the runner.
  writeRecord(env, { pid: REUSED_PID, startedAt: "2026-09-08T21:04:11.000Z", mode: "watch", intervalS: 30, logPath: "/tmp/runner.log", uptimeS: Math.round(uptime()) + 3600 });

  const alive = new Set([REUSED_PID]);
  const signals = [];
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    if (!alive.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
    if (signal === "SIGTERM") alive.delete(pid);
    return true;
  };

  await stopRunner({ pid: REUSED_PID, env, killImpl, sleepImpl: async () => {} });

  const sentRealSignal = signals.some(([, signal]) => signal === "SIGTERM");
  assert.equal(
    sentRealSignal,
    false,
    "stopRunner sent a real SIGTERM to a pid whose identity was never confirmed as the nightshift runner",
  );
});

test("stopRunner still attempts SIGTERM against a pid it can only probe via EPERM (another user's process)", async (t) => {
  const env = makeHome(t, "stop-identity-eperm");
  const OTHER_USER_PID = 424242;
  writeRecord(env, { pid: OTHER_USER_PID, startedAt: "2026-09-08T00:00:00.000Z", mode: "watch", intervalS: 30, logPath: "/tmp/runner.log" });

  const signals = [];
  // A process of another user answers every signal probe with EPERM, never ESRCH:
  // the kernel refuses to even tell us whether the pid is a match.
  const killImpl = (pid, signal) => {
    signals.push([pid, signal]);
    throw Object.assign(new Error(`kill EPERM ${pid}`), { code: "EPERM" });
  };

  await assert.rejects(() => stopRunner({ pid: OTHER_USER_PID, env, killImpl, sleepImpl: async () => {} }));

  const sentRealSignal = signals.some(([, signal]) => signal === "SIGTERM");
  assert.equal(
    sentRealSignal,
    false,
    "stopRunner attempted a real SIGTERM against a pid confirmed only via EPERM, never verified as the nightshift runner",
  );
});
