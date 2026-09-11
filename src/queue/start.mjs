import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { packageRoot } from "../host/paths.mjs";
import { killProcess, removeRunnerPidfile, runnerPidfileState, writeRunnerPidfile } from "./pidfile.mjs";
import { launchDetachedRunner } from "./runner.mjs";

// The advisory a refused drain or watch adds when the live runner exits after its single job, so a stalled backlog is never silent.
export const ONE_JOB_RUNNER_ADVISORY = "the live runner runs one job only - start the batch again once it exits: nightshift queue run";

// The answer every refused start gives, whatever path asked for it.
export function runnerBusyLine(pid, mode) {
  return `runner already active (pid ${pid}, ${mode}) - it will pick the job up`;
}

// The extra line a refusal carries only when the live runner stops after one job and the refused start wanted the whole queue.
export function runnerBusyAdvisory(liveMode, startedMode) {
  return liveMode === "once" && startedMode !== "once" ? ONE_JOB_RUNNER_ADVISORY : null;
}

// What a runner started with these options is: a watcher, a single job, or a drain of the whole queue.
export function runnerMode({ jobId = null, watchIntervalS = null } = {}) {
  if (watchIntervalS !== null) return "watch";
  return jobId === null ? "drain" : "once";
}

// Reads the registration and decides whether another runner may start; a registration no live process answers for is cleared on the way.
export function guardRunnerStart({ env = process.env, killImpl = killProcess } = {}) {
  const state = runnerPidfileState(env, killImpl);
  if (state.status === "alive") {
    const mine = state.info.pid === process.pid;
    return { ok: mine, self: mine, pid: state.info.pid, mode: state.info.mode ?? "runner" };
  }
  if (state.status !== "missing") removeRunnerPidfile(env);
  return { ok: true, self: false, pid: null, mode: null };
}

// Registers the runner that is about to own the queue; a runner nobody can find in the pidfile is worse than no runner at all.
function registerRunner({ pid, jobId, watchIntervalS, logPath }, env) {
  try {
    return writeRunnerPidfile(
      {
        pid,
        startedAt: new Date().toISOString(),
        mode: runnerMode({ jobId, watchIntervalS }),
        jobId,
        intervalS: watchIntervalS,
        logPath,
        runtimeDir: packageRoot(),
      },
      env,
    );
  } catch (err) {
    throw new UserError(
      `the runner started (pid ${pid}) but its pidfile could not be written: ${err?.message ?? String(err)}; stop it with \`kill ${pid}\``,
    );
  }
}

// Spawns the detached child and registers it, the critical section that must not be split by another process.
function spawnAndRegister({ jobId, max, watchIntervalS, env, spawnImpl, killImpl }) {
  const guard = guardRunnerStart({ env, killImpl });
  if (!guard.ok) return { started: false, pid: guard.pid, mode: guard.mode, logPath: null };
  const { pid, logPath } = launchDetachedRunner({ jobId, max, watchIntervalS, env, spawnImpl });
  if (!Number.isInteger(pid) || pid <= 0) throw new UserError("the detached runner did not report a pid; nothing was started");
  registerRunner({ pid, jobId, watchIntervalS, logPath }, env);
  return { started: true, pid, mode: runnerMode({ jobId, watchIntervalS }), logPath };
}

// Starts one detached runner, with the guard and the registration inside the same hold of the home lock so two starts can never both win.
export async function startQueueRunner({ jobId = null, max = null, watchIntervalS = null, env = process.env, spawnImpl, killImpl } = {}) {
  return await withLock(env, () => spawnAndRegister({ jobId, max, watchIntervalS, env, spawnImpl, killImpl }));
}

// Makes THIS process the registered runner, unless the parent that spawned it already registered it or another runner owns the queue.
export async function registerForegroundRunner({ jobId = null, watchIntervalS = null, env = process.env, killImpl = killProcess } = {}) {
  const seen = guardRunnerStart({ env, killImpl });
  if (!seen.ok || seen.self) return seen;
  return await withLock(env, () => {
    const guard = guardRunnerStart({ env, killImpl });
    if (!guard.ok || guard.self) return guard;
    registerRunner({ pid: process.pid, jobId, watchIntervalS, logPath: null }, env);
    return { ok: true, self: true, pid: process.pid, mode: runnerMode({ jobId, watchIntervalS }) };
  });
}
