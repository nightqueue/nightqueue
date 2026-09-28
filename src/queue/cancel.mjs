import { UserError } from "../config/errors.mjs";
import { runnerRegistryPath } from "../config/paths.mjs";
import { localWorkerPid } from "./claim.mjs";
import { killProcess, listRunnerRecords, registryReadError, STOP_TIMEOUT_MS, stopRunnerIfRegistered, unreadableRegistry } from "./registry.mjs";
import { stopReport } from "./stop.mjs";
import { releaseJobWorktree } from "./worktree.mjs";

const RELEASED_FROM = new Set(["done", "failed"]);

// How many times a stop-and-cancel re-reads a row that moved between its read and its write before it gives up.
const STOP_CANCEL_ROUNDS = 3;

// The stop outcomes in which the runner process is confirmed not there any more.
const RUNNER_GONE = new Set(["stopped", "stale", "absent"]);

// Why a registration that is not `alive` cannot vouch for the pid a job names.
const NOT_LIVE_WHY = {
  stale: "its registration is stale",
  unreadable: "its registration cannot be read",
};

// Cancels a job in one store write and only then, for a job cancelled from `done` or `failed`, releases its worktree; a refused cancel touches nothing on disk.
export async function cancelJobAndWorktree({ store, id, reason, env = process.env, killImpl = killProcess } = {}) {
  const job = await store.jobs.cancelJob(id, { reason });
  const worktree = RELEASED_FROM.has(job?.cancelled_from) ? await releaseJobWorktree({ job, env, killImpl }) : null;
  return { job, worktree };
}

// The pid of this host a running job's worker names, refusing a malformed worker or a worker of another host.
function localOwnerPid(id, worker) {
  const owner = localWorkerPid(worker);
  if (owner === null) {
    throw new UserError(`job \`${id}\` is running on worker \`${worker}\`, which does not name a process of this host; nothing was signalled or written`);
  }
  if (!owner.local) {
    throw new UserError(
      `job \`${id}\` is running on worker \`${worker}\`, a runner of host \`${owner.host}\`; nightqueue only stops a runner of this host - stop it on that machine, or cancel the job without \`stop\` once its lease has expired; nothing was signalled or written`,
    );
  }
  return owner.pid;
}

// The registration of one pid, found by the pid it names or by the file named after it, read without writing anything; a registry that cannot be listed is refused.
function readOwnerRecord(pid, env, killImpl) {
  const records = listRunnerRecords(env, killImpl);
  const error = registryReadError(records);
  if (error !== null) throw unreadableRegistry(error, env);
  const path = runnerRegistryPath(pid, env);
  return records.find((record) => record.info?.pid === pid) ?? records.find((record) => record.path === path) ?? null;
}

// Refuses, before any write or signal, a pid the registry does not list as a live runner of this home.
function requireLiveRunner(id, pid, record) {
  if (record?.status === "alive") return;
  if (record?.status === "foreign") {
    throw new UserError(
      `job \`${id}\` is running on runner pid ${pid}, whose registration names a process of another user; nightqueue will not signal it - check that pid and remove ${record.path} by hand; nothing was written`,
    );
  }
  const why = NOT_LIVE_WHY[record?.status] ?? "no runner is registered with that pid";
  throw new UserError(
    `job \`${id}\` is held by pid ${pid}, which is not a live runner of this home (${why}); nothing was signalled or written - once its lease has expired, cancel the job without \`stop\``,
  );
}

// The pid of the live registered runner of this host that owns a running job, refusing every other owner.
function signallableOwner(id, worker, env, killImpl) {
  const pid = localOwnerPid(id, worker);
  requireLiveRunner(id, pid, readOwnerRecord(pid, env, killImpl));
  return pid;
}

// Stops the one runner that owned the cancelled job; a failure is reported as `error`, because the job is cancelled either way.
async function stopOwner(pid, stop) {
  try {
    return await stopRunnerIfRegistered({ pid, ...stop });
  } catch (err) {
    return { outcome: "error", pid, message: err?.message ?? String(err) };
  }
}

// What the operator reads about the stopped runner of a job that is already cancelled.
function runnerMessage(id, report) {
  if (report.outcome === "error") return report.message;
  if (report.outcome === "alive") {
    const seconds = STOP_TIMEOUT_MS / 1000;
    return `runner (pid ${report.pid}) did not stop within ${seconds}s; job \`${id}\` is already cancelled, and the runner ends its attempt and exits by itself`;
  }
  return stopReport(report).line;
}

// Stops the owner of a job just cancelled from `running` and, when asked and the runner is confirmed gone, releases the job's worktree.
async function stopOwnerAndRelease({ job, pid, releaseWorktree, stop }) {
  const report = await stopOwner(pid, stop);
  const gone = RUNNER_GONE.has(report.outcome);
  const worktree = releaseWorktree && gone ? await releaseJobWorktree({ job, env: stop.env, killImpl: stop.killImpl }) : null;
  return { job, worktree, runner: { outcome: report.outcome, pid: report.pid ?? pid, message: runnerMessage(job.id, report) } };
}

// Plain-cancels a job read as not running; null when a runner claimed it before the cancel, so the caller re-reads it as running.
async function cancelNotRunning({ store, id, reason, env, killImpl }) {
  try {
    return { ...(await cancelJobAndWorktree({ store, id, reason, env, killImpl })), runner: null };
  } catch (err) {
    const now = await store.jobs.getJob(id);
    if (now?.status === "running") return null;
    throw err;
  }
}

// Cancels a running job of a live local runner in one compare-and-set write and only then stops that runner alone; a job that is not running follows the plain cancel.
export async function stopAndCancelJob({ store, id, reason, releaseWorktree = false, env = process.env, killImpl = killProcess, sleepImpl, pollMs, timeoutMs } = {}) {
  const stop = { env, killImpl, sleepImpl, pollMs, timeoutMs };
  for (let round = 0; round < STOP_CANCEL_ROUNDS; round += 1) {
    const row = await store.jobs.getJob(id);
    if (!row) throw new UserError(`unknown job \`${id}\``);
    if (row.status !== "running") {
      const answer = await cancelNotRunning({ store, id, reason, env, killImpl });
      if (answer) return answer;
      continue;
    }
    const pid = signallableOwner(id, row.worker, env, killImpl);
    const job = await store.jobs.cancelRunningJob(id, { worker: row.worker, reason });
    if (job) return await stopOwnerAndRelease({ job, pid, releaseWorktree, stop });
  }
  throw new UserError(`job \`${id}\` changed hands while it was being stopped; nothing was cancelled - call again`);
}
