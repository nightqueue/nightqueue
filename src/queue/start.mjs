import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { packageRoot } from "../host/paths.mjs";
import { claimBlocker } from "./claim.mjs";
import { inheritablePause } from "./rate-limit.mjs";
import { killProcess, ownRunnerRecord, pruneDeadRunners, writeRunnerRecord } from "./registry.mjs";
import { launchDetachedRunner } from "./runner.mjs";

// What a runner started with these options is: a watcher, a single job, or a drain of the whole queue.
export function runnerMode({ jobId = null, watchIntervalS = null } = {}) {
  if (watchIntervalS !== null) return "watch";
  return jobId === null ? "drain" : "once";
}

// Registers the runner that is about to work the queue; a runner nobody can find in the registry is worse than no runner at all.
// A runner born while a live runner of this home waits out a rate limit adopts that wait here, at registration and only here.
function registerRunner({ pid, jobId, watchIntervalS, logPath, detached, killImpl }, env) {
  try {
    return writeRunnerRecord(
      {
        pid,
        startedAt: new Date().toISOString(),
        mode: runnerMode({ jobId, watchIntervalS }),
        jobId,
        intervalS: watchIntervalS,
        detached,
        logPath,
        runtimeDir: packageRoot(),
        rateLimit: inheritablePause(env, killImpl),
      },
      env,
    );
  } catch (err) {
    throw new UserError(
      `the runner started (pid ${pid}) but its registration could not be written: ${err?.message ?? String(err)}; stop it with \`kill ${pid}\``,
    );
  }
}

// Spawns the detached child and registers it, the critical section that must not be split by another process.
function spawnAndRegister({ jobId, max, watchIntervalS, env, spawnImpl, killImpl }) {
  pruneDeadRunners(env, killImpl);
  const { pid, logPath } = launchDetachedRunner({ jobId, max, watchIntervalS, env, spawnImpl });
  if (!Number.isInteger(pid) || pid <= 0) throw new UserError("the detached runner did not report a pid; nothing was started");
  registerRunner({ pid, jobId, watchIntervalS, logPath, detached: true, killImpl }, env);
  return { started: true, pid, mode: runnerMode({ jobId, watchIntervalS }), logPath, waiting: null };
}

// Starts one detached runner, with the prune and the registration inside the same hold of the home lock; a start that would claim nothing reports why instead of spawning a ghost.
export async function startQueueRunner({ jobId = null, max = null, watchIntervalS = null, env = process.env, spawnImpl, killImpl } = {}) {
  const waiting = await claimBlocker({ jobId, mode: runnerMode({ jobId, watchIntervalS }), env });
  if (waiting) return { started: false, pid: null, mode: null, logPath: null, waiting };
  return await withLock(env, () => spawnAndRegister({ jobId, max, watchIntervalS, env, spawnImpl, killImpl }));
}

// Makes THIS process a registered runner, unless the parent that spawned it already registered it: only the parent knows the log the child writes into.
export async function registerForegroundRunner({ jobId = null, watchIntervalS = null, env = process.env, killImpl = killProcess } = {}) {
  const registered = ownRunnerRecord(env);
  if (registered) return { registered: true, self: false, pid: process.pid, mode: registered.mode ?? null };
  return await withLock(env, () => {
    const own = ownRunnerRecord(env);
    if (own) return { registered: true, self: false, pid: process.pid, mode: own.mode ?? null };
    pruneDeadRunners(env, killImpl);
    registerRunner({ pid: process.pid, jobId, watchIntervalS, logPath: null, detached: false, killImpl }, env);
    return { registered: true, self: true, pid: process.pid, mode: runnerMode({ jobId, watchIntervalS }) };
  });
}
