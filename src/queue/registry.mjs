import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { dbShmPath, legacyRunnerPidPath, runnerRegistryPath, runnersDir } from "../config/paths.mjs";
import { ensureHome, writeFileAtomic } from "../config/store.mjs";

// How long `queue run --stop` waits for a runner to go away, and how often it looks.
export const STOP_TIMEOUT_MS = 10000;
export const STOP_POLL_MS = 200;

// Uptime slack, so only a registration clearly above the current uptime counts as written before this boot.
const BOOT_SKEW_S = 60;

const REGISTRY_DIR_MODE = 0o700;

// The state every reader prints for a home with no live runner; the keys are the ones a live runner carries.
export const STOPPED_RUNNER = {
  running: false,
  pid: null,
  mode: null,
  jobId: null,
  intervalS: null,
  startedAt: null,
  logPath: null,
  runtimeDir: null,
  detached: null,
  pausedUntil: null,
  rateLimit: null,
};

// Sends a signal to a process, the single seam every liveness check and every stop of this module goes through.
export function killProcess(pid, signal) {
  return process.kill(pid, signal);
}

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Probes a pid without touching it: `alive` when it answers, `foreign` when the system refuses to signal it (another owner), `gone` otherwise.
export function probePid(pid, killImpl) {
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

// What one entry of a listing describes: one registration, or the registry directory itself.
const RECORD_SCOPE = "record";
const REGISTRY_SCOPE = "registry";

// One entry of the registry as every reader of it sees it, with the raw text it was classified from.
function entry({ status, info, path, raw, legacy, error, scope = RECORD_SCOPE }) {
  return { status, info, path, raw, legacy, error, scope };
}

// Reads and classifies one file of the registry, refusing a record that does not name the pid its own file is named after.
function readRecord({ path, legacy, expectedPid }, killImpl) {
  let raw = null;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    return entry({ status: "unreadable", info: null, path, raw: null, legacy, error: err?.message ?? String(err) });
  }
  let info = null;
  try {
    info = JSON.parse(raw);
  } catch (err) {
    return entry({ status: "unreadable", info: null, path, raw, legacy, error: err?.message ?? String(err) });
  }
  const pid = info?.pid;
  if (!Number.isInteger(pid) || pid <= 0) {
    const error = `\`pid\` is not a positive integer (${JSON.stringify(pid ?? null)})`;
    return entry({ status: "unreadable", info: null, path, raw, legacy, error });
  }
  if (expectedPid !== null && pid !== expectedPid) {
    const error = `the record names pid ${pid} but its file is named after pid ${expectedPid}`;
    return entry({ status: "unreadable", info: null, path, raw, legacy, error });
  }
  return entry({ status: pidStatus(info, killImpl), info, path, raw, legacy, error: null });
}

// Files of the registry directory, plus the legacy pidfile when a previous version left one behind;
// a directory that is simply not there is an empty registry, and ANY other read failure is an error and never one.
function recordFiles(env) {
  const dir = runnersDir(env);
  let names = [];
  let error = null;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (err?.code !== "ENOENT") error = err?.message ?? String(err);
  }
  const own = names
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({ path: join(dir, name), legacy: false, expectedPid: Number(name.slice(0, -".json".length)) }))
    .filter((file) => Number.isInteger(file.expectedPid) && file.expectedPid > 0);
  const legacyPath = legacyRunnerPidPath(env);
  const files = existsSync(legacyPath) ? [...own, { path: legacyPath, legacy: true, expectedPid: null }] : own;
  return { dir, files, error };
}

// The entry that stands for the registry directory itself, so a listing nobody could read is a visible state and not an empty one.
function registryFailure(dir, error) {
  return entry({ status: "unreadable", info: null, path: dir, raw: null, legacy: false, error, scope: REGISTRY_SCOPE });
}

// Sorts the registry the way every report prints it: oldest registration first, the pid breaking a tie.
function byStart(left, right) {
  const started = String(left.info?.startedAt ?? "").localeCompare(String(right.info?.startedAt ?? ""));
  return started !== 0 ? started : (left.info?.pid ?? 0) - (right.info?.pid ?? 0);
}

// Every registration of this home, classified one by one: `alive`, `stale`, `foreign` or `unreadable`;
// a registry that could not be listed leads the list with an `unreadable` entry of its own.
export function listRunnerRecords(env = process.env, killImpl = killProcess) {
  const { dir, files, error } = recordFiles(env);
  const records = files
    .map((file) => readRecord(file, killImpl))
    .filter(Boolean)
    .sort(byStart);
  return error === null ? records : [registryFailure(dir, error), ...records];
}

// Tells the failure to list the registry itself apart from a single registration that could not be read.
export function isRegistryFailure(record) {
  return record?.scope === REGISTRY_SCOPE;
}

// The read failure of the registry directory in a listing, or null when it could be listed.
export function registryReadError(records) {
  return records.find(isRegistryFailure)?.error ?? null;
}

// The refusal every reader raises instead of answering for a registry it could not even list.
export function unreadableRegistry(error, env) {
  return new UserError(`the runner registry cannot be listed (${runnersDir(env)}): ${error}`);
}

// The registration of one pid, or null when the registry holds none.
export function findRunnerRecord(pid, env = process.env, killImpl = killProcess) {
  return listRunnerRecords(env, killImpl).find((record) => record.info?.pid === pid) ?? null;
}

// The record this very process registered, or null when the registry holds none for it.
export function ownRunnerRecord(env = process.env) {
  try {
    const info = JSON.parse(readFileSync(runnerRegistryPath(process.pid, env), "utf8"));
    return info?.pid === process.pid ? info : null;
  } catch {
    return null;
  }
}

// What the transient rate limit region of a registration reports, without ever deciding whether the record is live: those are two different questions.
function rateLimitView(rateLimit) {
  if (!rateLimit || typeof rateLimit !== "object") return { pausedUntil: null, rateLimit: null };
  const { pausedUntil = null, type = null, resetsAt = null, utilization = null } = rateLimit;
  return { pausedUntil, rateLimit: { type, resetsAt, utilization } };
}

// The state of one runner as every reader of it prints it: only a live registration carries fields.
export function runnerView(record) {
  if (record?.status !== "alive") return { ...STOPPED_RUNNER };
  const { pid, mode = null, jobId = null, intervalS = null, startedAt = null, logPath = null, runtimeDir = null, detached = null } = record.info;
  return { running: true, pid, mode, jobId, intervalS, startedAt, logPath, runtimeDir, detached, ...rateLimitView(record.info.rateLimit) };
}

// Every live runner of this home, in the order the registry lists them, next to the failure to list it: a reader that reports instead of refusing needs both.
export function liveRunnersReport(env = process.env, killImpl = killProcess) {
  const records = listRunnerRecords(env, killImpl);
  return {
    runners: records.filter((record) => record.status === "alive").map(runnerView),
    error: registryReadError(records),
  };
}

// Every live runner of this home; a registry that could not be listed throws, so no caller reads a read failure as a host where nothing runs.
export function liveRunners(env = process.env, killImpl = killProcess) {
  const { runners, error } = liveRunnersReport(env, killImpl);
  if (error !== null) throw unreadableRegistry(error, env);
  return runners;
}

// Removes a record only when the file on disk is still the text that was classified, so a prune never erases a registration that landed on a recycled pid.
function removeRecordIfUnchanged(record) {
  if (record.raw === null) return false;
  try {
    if (readFileSync(record.path, "utf8") !== record.raw) return false;
    rmSync(record.path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Drops the registrations no live process answers for; a `foreign` one is left alone, because it blocks nothing and is not ours to clear.
export function pruneDeadRunners(env = process.env, killImpl = killProcess) {
  const dead = listRunnerRecords(env, killImpl).filter(
    (record) => !isRegistryFailure(record) && (record.status === "stale" || record.status === "unreadable"),
  );
  return dead.filter(removeRecordIfUnchanged).map((record) => record.path);
}

// Requires the pid a registration is written for, because a record nobody can find is worse than no record at all.
function requireRunnerPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new UserError(`invalid runner pid \`${String(pid)}\`; expected a positive integer`);
  return pid;
}

// Registers one runner under its own pid, the single write of the whole record.
// Any later writer reads, MERGES its own keys into and rewrites ONLY the file whose `pid` is its own, under `withLock`.
export function writeRunnerRecord(info, env = process.env) {
  const pid = requireRunnerPid(info?.pid);
  ensureHome(env);
  mkdirSync(runnersDir(env), { recursive: true, mode: REGISTRY_DIR_MODE });
  const stamped = { ...info, uptimeS: Math.round(Number(uptime())) };
  writeFileAtomic(runnerRegistryPath(pid, env), `${JSON.stringify(stamped, null, 2)}\n`);
  return stamped;
}

// Removes the registration only when it still names THIS process: a runner never clears the record of another one.
export function removeOwnRunnerRecord(env = process.env) {
  const path = runnerRegistryPath(process.pid, env);
  try {
    const info = JSON.parse(readFileSync(path, "utf8"));
    if (info?.pid !== process.pid) return false;
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Identity of the shared-memory file of the database right now, as decimal strings because an inode does not always fit a JSON number.
function dbShmWitness(env) {
  const stats = statSync(dbShmPath(env), { bigint: true, throwIfNoEntry: false });
  return stats ? { ino: String(stats.ino), dev: String(stats.dev), at: new Date().toISOString() } : null;
}

// Merges into the record of this process, while it still names it, the keys a decision taken from that very record asks for;
// a decision that asks for nothing leaves the file untouched, which is how a caller compares before it swaps.
// `uptimeS` is never re-stamped here: it is the boot witness the classification reads, and only the registration itself writes it.
function mergeOwnRecord(decide, env) {
  const path = runnerRegistryPath(process.pid, env);
  const info = JSON.parse(readFileSync(path, "utf8"));
  if (info?.pid !== process.pid) return null;
  const patch = decide(info);
  if (patch === null) return info;
  const merged = { ...info, ...patch };
  writeFileAtomic(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

// Reads the registration of THIS runner and writes what a decision taken from it asks for, both inside the home lock,
// so a writer never swaps a region against a value another writer has already replaced.
export async function updateOwnRunnerRecord(decide, env = process.env) {
  return await withLock(env, () => mergeOwnRecord(decide, env));
}

// Merges fixed keys into the registration of THIS runner, under the home lock; a lock nobody could take raises instead of writing unguarded.
export async function mergeOwnRunnerRecord(patch, env = process.env) {
  return await updateOwnRunnerRecord(() => patch, env);
}

// Records in the registration of THIS runner which shared-memory file its connection is attached to, so `doctor` can tell a split apart from a healthy home; a witness that cannot be written is an unknown and never a failure.
export async function stampRunnerDbWitness(env = process.env) {
  try {
    const dbShm = dbShmWitness(env);
    if (!dbShm) return null;
    return await mergeOwnRunnerRecord({ dbShm }, env);
  } catch {
    return null;
  }
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
function refuseForeignRecord(record) {
  throw new UserError(
    `the registration of pid ${record.info.pid} names a process of another user; nightshift will not signal it - check that pid and remove ${record.path} by hand`,
  );
}

// Signals one registration, answering right away for everything that needs no wait at all.
function signalRecord(record, killImpl) {
  if (record.status === "foreign") return { outcome: "foreign", pid: record.info.pid, path: record.path };
  if (record.status === "unreadable") {
    removeRecordIfUnchanged(record);
    return { outcome: "stale", pid: null };
  }
  if (record.status !== "alive") {
    removeRecordIfUnchanged(record);
    return { outcome: "stale", pid: record.info.pid };
  }
  if (signalStop(record.info.pid, killImpl)) return null;
  removeRecordIfUnchanged(record);
  return { outcome: "stale", pid: record.info.pid };
}

// Polls the runners that were signalled until each one is gone or the timeout passes, so N runners cost one timeout and not N.
async function pollUntilGone(records, { killImpl, sleepImpl, pollMs, timeoutMs }) {
  const pending = new Set(records);
  const reports = new Map();
  const polls = Math.max(1, Math.ceil(timeoutMs / pollMs));
  for (let poll = 0; poll < polls && pending.size; poll += 1) {
    await sleepImpl(pollMs);
    for (const record of [...pending]) {
      if (probePid(record.info.pid, killImpl) !== "gone") continue;
      removeRecordIfUnchanged(record);
      pending.delete(record);
      reports.set(record, { outcome: "stopped", pid: record.info.pid });
    }
  }
  for (const record of pending) reports.set(record, { outcome: "alive", pid: record.info.pid });
  return reports;
}

// Ends every given registration: SIGTERM to all of them first, then one shared poll until they are gone.
async function stopRecords(records, { killImpl, sleepImpl, pollMs, timeoutMs }) {
  const reports = new Map();
  const signalled = [];
  for (const record of records) {
    const report = signalRecord(record, killImpl);
    if (report) reports.set(record, report);
    else signalled.push(record);
  }
  for (const [record, report] of await pollUntilGone(signalled, { killImpl, sleepImpl, pollMs, timeoutMs })) {
    reports.set(record, report);
  }
  return records.map((record) => reports.get(record));
}

// Ends the runner registered under one pid, refusing a registration of another user: there the refusal IS the answer.
export async function stopRunner({ pid, env = process.env, killImpl = killProcess, sleepImpl = sleep, pollMs = STOP_POLL_MS, timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const records = listRunnerRecords(env, killImpl);
  const error = registryReadError(records);
  if (error !== null) throw unreadableRegistry(error, env);
  const record = records.find((candidate) => candidate.info?.pid === pid) ?? null;
  if (!record) throw new UserError(`no runner is registered with pid ${pid}`);
  if (record.status === "foreign") refuseForeignRecord(record);
  const [report] = await stopRecords([record], { killImpl, sleepImpl, pollMs, timeoutMs });
  return report;
}

// Ends every registered runner; a registration of another user is reported as its own line instead of taking the healthy ones hostage.
export async function stopAllRunners({ env = process.env, killImpl = killProcess, sleepImpl = sleep, pollMs = STOP_POLL_MS, timeoutMs = STOP_TIMEOUT_MS } = {}) {
  const records = listRunnerRecords(env, killImpl);
  const error = registryReadError(records);
  if (error !== null) throw unreadableRegistry(error, env);
  if (!records.length) return [{ outcome: "absent", pid: null }];
  return await stopRecords(records, { killImpl, sleepImpl, pollMs, timeoutMs });
}
