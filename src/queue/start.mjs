import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { packageRoot } from "../host/paths.mjs";
import { claimBlocker } from "./claim.mjs";
import { inheritablePause } from "./rate-limit.mjs";
import { killProcess, ownRunnerRecord, pruneDeadRunners, writeRunnerRecord } from "./registry.mjs";
import { launchDetachedRunner } from "./runner.mjs";
import { resolveWindow } from "./window.mjs";

// What a runner started with these options is: a watcher, a single job, or a drain of the whole queue.
export function runnerMode({ jobId = null, watchIntervalS = null } = {}) {
  if (watchIntervalS !== null) return "watch";
  return jobId === null ? "drain" : "once";
}

// The window a registration carries: `--from`/`--until` resolved once, here, into absolute ISO instants - a watch
// with no `--until` (or a runner that is not a watch at all) carries none, and nobody re-resolves it afterwards.
function registeredWindow({ watchIntervalS, from, until }) {
  if (watchIntervalS === null || until === null) return null;
  const { fromMs, untilMs } = resolveWindow({ from, until });
  return { from: new Date(fromMs).toISOString(), until: new Date(untilMs).toISOString() };
}

// Registers the runner that is about to work the queue; a runner nobody can find in the registry is worse than no runner at all.
// A runner born while a live runner of this home waits out a rate limit adopts that wait here, at registration and only here.
// `runtimeDir` names the tree the runner ITSELF loads: the detached branch passes the one its argv was launched from,
// a foreground runner is this very process, so it always names its own `packageRoot()`.
function registerRunner({ pid, jobId, watchIntervalS, logPath, detached, killImpl, from = null, until = null, runtimeDir }, env) {
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
        runtimeDir,
        rateLimit: inheritablePause(env, killImpl),
        window: registeredWindow({ watchIntervalS, from, until }),
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
function spawnAndRegister({ jobId, max, watchIntervalS, from, until, env, spawnImpl, killImpl }) {
  pruneDeadRunners(env, killImpl);
  const { pid, logPath, runtimeDir } = launchDetachedRunner({ jobId, max, watchIntervalS, from, until, env, spawnImpl });
  if (!Number.isInteger(pid) || pid <= 0) throw new UserError("the detached runner did not report a pid; nothing was started");
  registerRunner({ pid, jobId, watchIntervalS, logPath, detached: true, killImpl, from, until, runtimeDir }, env);
  return { started: true, pid, mode: runnerMode({ jobId, watchIntervalS }), logPath, waiting: null };
}

// Starts one detached runner, with the prune and the registration inside the same hold of the home lock; a start that would claim nothing reports why instead of spawning a ghost.
export async function startQueueRunner({ jobId = null, max = null, watchIntervalS = null, from = null, until = null, env = process.env, spawnImpl, killImpl } = {}) {
  const waiting = await claimBlocker({ jobId, mode: runnerMode({ jobId, watchIntervalS }), env });
  if (waiting) return { started: false, pid: null, mode: null, logPath: null, waiting };
  return await withLock(env, () => spawnAndRegister({ jobId, max, watchIntervalS, from, until, env, spawnImpl, killImpl }));
}

// Makes THIS process a registered runner, unless the parent that spawned it already registered it: only the parent knows the log the child writes into.
export async function registerForegroundRunner({ jobId = null, watchIntervalS = null, from = null, until = null, env = process.env, killImpl = killProcess } = {}) {
  const registered = ownRunnerRecord(env);
  if (registered) return { registered: true, self: false, pid: process.pid, mode: registered.mode ?? null };
  return await withLock(env, () => {
    const own = ownRunnerRecord(env);
    if (own) return { registered: true, self: false, pid: process.pid, mode: own.mode ?? null };
    pruneDeadRunners(env, killImpl);
    registerRunner({ pid: process.pid, jobId, watchIntervalS, logPath: null, detached: false, killImpl, from, until, runtimeDir: packageRoot() }, env);
    return { registered: true, self: true, pid: process.pid, mode: runnerMode({ jobId, watchIntervalS }) };
  });
}
