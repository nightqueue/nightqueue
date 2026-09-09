import assert from "node:assert/strict";
import { uptime } from "node:os";
import { test } from "node:test";
import { runnerPidfileState, writeRunnerPidfile } from "../../src/queue/pidfile.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const REUSED_PID = 424242;

// A kill double that answers alive for a single fixed pid and never touches a real process.
function fakeAliveKill(pid) {
  return (probedPid) => {
    if (probedPid === pid) return true;
    throw Object.assign(new Error(`kill ESRCH ${probedPid}`), { code: "ESRCH" });
  };
}

test("a watcher started this boot stays alive across a forward wall-clock jump (NTP correction, VM/container skew)", (t) => {
  const env = makeHome(t, "pidfile-clock-skew");
  const beforeMs = Date.now();
  const startedAt = new Date(beforeMs).toISOString();
  writeRunnerPidfile({ pid: REUSED_PID, startedAt, mode: "watch", intervalS: 30, logPath: "/tmp/runner.log" }, env);

  t.mock.timers.enable({ apis: ["Date"] });
  // Push the wall clock past the boot instant plus the real uptime, the case a clock correction after boot produces.
  // `Date.now()` is captured as `beforeMs` above, before enabling the mock: once mocked, `Date.now()` no longer reflects the real clock.
  const jumpMs = Number(uptime()) * 1000 + 2 * 60 * 60 * 1000;
  t.mock.timers.setTime(beforeMs + jumpMs);

  const state = runnerPidfileState(env, fakeAliveKill(REUSED_PID));
  assert.equal(state.status, "alive", "a registration written this boot was misread as stale after a wall-clock jump forward");
});
