import { readFileSync, rmSync } from "node:fs";
import { uptime } from "node:os";
import { UserError } from "../config/errors.mjs";
import { runnerPidPath } from "../config/paths.mjs";
import { ensureHome, writeFileAtomic } from "../config/store.mjs";

// How long `queue run --stop` waits for the runner to go away, and how often it looks.
export const STOP_TIMEOUT_MS = 10000;
export const STOP_POLL_MS = 200;

// Uptime slack, so only a registration clearly above the current uptime counts as written before this boot.
const BOOT_SKEW_S = 60;

// Sends a signal to a process, the single seam every liveness check and every stop of this module goes through.
export function killProcess(pid, signal) {
  return process.kill(pid, signal);
}

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Probes a pid without touching it: `alive` when it answers, `foreign` when the system refuses to signal it (another owner), `gone` otherwise.
function probePid(pid, killImpl) {
  try {
    killImpl(pid, 0);
    return "alive";
  } catch (err) {
    return err?.code === "EPERM" ? "foreign" : "gone";
  }
}

// Tells whether the registration was written before this boot: inside one boot session uptime only grows.
function precedesThisBoot(info) {
  const registeredUptimeS = Number(info?.uptimeS);
  if (!Number.isFinite(registeredUptimeS)) return false;
  return registeredUptimeS > Number(uptime()) + BOOT_SKEW_S;
}

// Classifies the pid of a registration: only a live pid this boot could have written is `alive`.
function pidStatus(info, killImpl) {
  const probed = probePid(info.pid, killImpl);
  if (probed === "gone") return "stale";
  if (probed === "foreign") return "foreign";
  return precedesThisBoot(info) ? "stale" : "alive";
}

// Reads the pidfile of the runner and classifies it: `missing`, `alive`, `stale`, `foreign` or `unreadable`.
export function runnerPidfileState(env = process.env, killImpl = killProcess) {
  const path = runnerPidPath(env);
  let info = null;
  try {
    info = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return { status: "missing", info: null, path, error: null };
    return { status: "unreadable", info: null, path, error: err?.message ?? String(err) };
  }
  const pid = info?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: "unreadable", info: null, path, error: `\`pid\` is not a positive integer (${JSON.stringify(pid ?? null)})` };
  }
  return { status: pidStatus(info, killImpl), info, path, error: null };
}

// The state of the runner as every reader of it prints it: only a live pidfile carries fields.
export function runnerView(state) {
  if (state.status !== "alive") {
    return { running: false, pid: null, mode: null, intervalS: null, startedAt: null, logPath: null };
  }
  const { pid, mode = null, intervalS = null, startedAt = null, logPath = null } = state.info;
  return { running: true, pid, mode, intervalS, startedAt, logPath };
}

// Registers the runner that was just started, so `queue status`, `doctor` and `--stop` can find it.
export function writeRunnerPidfile(info, env = process.env) {
  ensureHome(env);
  const stamped = { ...info, uptimeS: Math.round(Number(uptime())) };
  writeFileAtomic(runnerPidPath(env), `${JSON.stringify(stamped, null, 2)}\n`);
  return stamped;
}

// Removes the pidfile of the runner, whoever wrote it.
export function removeRunnerPidfile(env = process.env) {
  rmSync(runnerPidPath(env), { force: true });
}

// Removes the registration only when it still names the given pid, so nobody ever clears the record of another runner.
function removeRunnerPidfileOf(pid, env) {
  try {
    const info = JSON.parse(readFileSync(runnerPidPath(env), "utf8"));
    if (info?.pid !== pid) return false;
    removeRunnerPidfile(env);
    return true;
  } catch {
    return false;
  }
}

// Removes the pidfile only when it registers THIS process: a runner never clears the registration of another one.
export function removeOwnRunnerPidfile(env = process.env) {
  return removeRunnerPidfileOf(process.pid, env);
}

// Sends the stop signal, telling a process that was already gone apart from one the system refuses to signal.
function signalStop(pid, killImpl) {
  try {
    killImpl(pid, "SIGTERM");
    return true;
  } catch (err) {
    if (err?.code === "ESRCH") return false;
    throw new UserError(`could not stop the runner (pid ${pid}): ${err?.message ?? String(err)}`);
  }
}

// Refuses to signal a pid of another owner: a runner this operator started would never answer `EPERM` to them.
function refuseForeignPid(state) {
  throw new UserError(
    `the runner pidfile registers pid ${state.info.pid}, a process of another user; nightshift will not signal it - check that pid and remove ${state.path} by hand`,
  );
}

// Ends the registered runner: SIGTERM and then polls until it is gone or the timeout passes.
export async function stopRunner({ env = process.env, killImpl = killProcess, sleepImpl = sleep, pollMs = STOP_POLL_MS, timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const state = runnerPidfileState(env, killImpl);
  if (state.status === "missing") return { outcome: "absent", pid: null };
  if (state.status === "foreign") refuseForeignPid(state);
  if (state.status === "unreadable") {
    removeRunnerPidfile(env);
    return { outcome: "stale", pid: null };
  }
  if (state.status !== "alive") {
    removeRunnerPidfileOf(state.info.pid, env);
    return { outcome: "stale", pid: state.info.pid };
  }
  const pid = state.info.pid;
  if (!signalStop(pid, killImpl)) {
    removeRunnerPidfileOf(pid, env);
    return { outcome: "stale", pid };
  }
  for (let poll = 0; poll < Math.max(1, Math.ceil(timeoutMs / pollMs)); poll += 1) {
    await sleepImpl(pollMs);
    if (probePid(pid, killImpl) !== "gone") continue;
    removeRunnerPidfileOf(pid, env);
    return { outcome: "stopped", pid };
  }
  return { outcome: "alive", pid };
}
