import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { withLock } from "../config/lock.mjs";
import { logsDir } from "../config/paths.mjs";
import { projectByName } from "../config/projects.mjs";
import { ensureHome, loadConfig } from "../config/store.mjs";
import { packageRoot, spawnRoot } from "../host/paths.mjs";
import { closeRefusal } from "../memory/jobs.mjs";
import { prStateKey } from "./pr-state.mjs";
import { killProcess, ownRunnerRecord, pruneDeadRunners, removeOwnRunnerRecord, writeRunnerRecord } from "./registry.mjs";
import { callerJobId } from "./retry.mjs";
import { compactStamp } from "./runner.mjs";
import { runClosePipeline, CLOSE_LEASE_SLACK_S } from "./close.mjs";
import { CLOSE_WORKER_ENV } from "./close-deps.mjs";
import { parseCloseChecklist } from "./close-view.mjs";

export { CLOSE_LEASE_SLACK_S, CLOSE_WORKER_ENV };

// Refuses a close from inside an unattended run: closing is the operator's act, never an agent's.
function refuseCloseInsideJob(env) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(`refusing to close from inside job \`${own}\`: an unattended run never closes; ask the operator to run nightshift queue close <id>`);
}

// The hard timeout of one close attempt, from the configuration of this home.
export function closeTimeoutS(env) {
  return loadConfig(env).queue.closeTimeoutS;
}

// The lease a close takes: its hard timeout plus a slack, so a live close never looks dead.
function closeLeaseSeconds(env) {
  return closeTimeoutS(env) + CLOSE_LEASE_SLACK_S;
}

// A fresh token naming the process that holds a close lease.
export function closeWorkerId() {
  return `close:${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

// The registered checkout of a job's project, refusing an unregistered project or a checkout that is gone.
function projectCheckout(job, env) {
  const project = projectByName(loadConfig(env), job.project);
  if (!project) throw new UserError(`job \`${job.id}\` belongs to project \`${job.project}\`, which is not registered; run \`nightshift project list\``);
  if (!existsSync(project.path)) throw new UserError(`the checkout of project \`${job.project}\` is missing: ${project.path}`);
  return project.path;
}

// Checks, before any lease, that a job can be closed: its status, its pull request, its project and its checkout.
export async function validateCloseTarget({ store, id, force = false, env = process.env }) {
  const job = await store.jobs.getJob(id);
  const refusal = closeRefusal(id, job, { force });
  if (refusal) throw new UserError(refusal);
  const checkout = projectCheckout(job, env);
  if (prStateKey(job.pr_url) === null) throw new UserError(`job \`${id}\` carries a pull request that is not a GitHub pull request URL: ${job.pr_url}`);
  return { job, checkout, forced: force === true };
}

// Takes the close lease in one compare-and-swap; a race lost is refused in the words of the row as it is now.
async function acquireOrRefuse({ store, id, worker, force, env }) {
  const row = await store.jobs.acquireClose(id, { worker, leaseS: closeLeaseSeconds(env), force });
  if (row) return row;
  const refusal = closeRefusal(id, await store.jobs.getJob(id), { force });
  throw new UserError(refusal ?? `job \`${id}\` could not take the close lease; run nightshift queue status ${id}`);
}

// Validates the target and takes its lease: the part of a start that writes, run only after every refusal had its say.
async function claimClose({ store, id, force, env }) {
  refuseCloseInsideJob(env);
  const target = await validateCloseTarget({ store, id, force, env });
  const worker = closeWorkerId();
  const row = await acquireOrRefuse({ store, id, worker, force, env });
  return { ...target, worker, row };
}

// Arguments of the detached close: `--foreground` is what makes the child run the steps instead of detaching again, and the `--decisions` choice is handed down.
function detachedCloseArgs({ id, force, runtimeDir, decisions }) {
  const flags = [...(force ? ["--force"] : []), ...(decisions ? ["--decisions", decisions] : [])];
  return [join(runtimeDir, "bin", "nightshift.mjs"), "queue", "close", String(id), "--foreground", ...flags];
}

// Records an asynchronous spawn failure in the close log, the file the started line already points at.
function recordSpawnFailure(logPath, err) {
  try {
    appendFileSync(logPath, `could not start the detached close: ${err?.message ?? String(err)}\n`);
  } catch {
    return;
  }
}

// Spawns the detached close on its own log, handing it the lease token through its environment.
function launchDetachedClose({ id, force, worker, env, spawnImpl, decisions }) {
  ensureHome(env);
  mkdirSync(logsDir(env), { recursive: true });
  const logPath = join(logsDir(env), `close-${id}-${compactStamp()}.log`);
  const runtimeDir = spawnRoot(env);
  const fd = openSync(logPath, "a");
  try {
    const args = detachedCloseArgs({ id, force, runtimeDir, decisions });
    const child = spawnImpl(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...env, [CLOSE_WORKER_ENV]: worker } });
    child?.on?.("error", (err) => recordSpawnFailure(logPath, err));
    child?.unref?.();
    return { pid: child?.pid ?? null, logPath, runtimeDir };
  } finally {
    closeSync(fd);
  }
}

// Writes the registration of a close process, the record that makes it visible to status, doctor and the install guard.
function registerClose({ pid, id, detached, logPath, runtimeDir }, env) {
  return writeRunnerRecord(
    { pid, startedAt: new Date().toISOString(), mode: "close", jobId: id, intervalS: null, detached, logPath, runtimeDir, rateLimit: null, window: null },
    env,
  );
}

// Spawns the detached close and registers it, inside one hold of the home lock.
function spawnAndRegisterClose({ id, force, worker, env, spawnImpl, killImpl, decisions }) {
  pruneDeadRunners(env, killImpl);
  const { pid, logPath, runtimeDir } = launchDetachedClose({ id, force, worker, env, spawnImpl, decisions });
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("the detached close did not report a pid");
  registerClose({ pid, id, detached: true, logPath, runtimeDir }, env);
  return { pid, logPath };
}

// Stops a close that never started, keeping its checklist so the next `queue close` resumes it.
async function failCloseStart({ store, id, worker, row }) {
  const checklist = parseCloseChecklist(row?.close) ?? { attempts: 1, steps: {}, data: {} };
  const close = { ...checklist, finishedAt: new Date().toISOString(), failed: { step: "start", reason: "spawn-failed" } };
  try {
    await store.jobs.failClose(id, { worker, close });
  } catch {
    return;
  }
}

// Starts the close of a job detached: validate, take the lease, spawn and register; a spawn that fails releases the lease as a failed close.
export async function startCloseDetached({ store, id, force = false, env = process.env, spawnImpl = spawn, killImpl = killProcess, decisions = null }) {
  const claimed = await claimClose({ store, id, force, env });
  try {
    const started = await withLock(env, () => spawnAndRegisterClose({ id, force, worker: claimed.worker, env, spawnImpl, killImpl, decisions }));
    return { started: true, jobId: id, pid: started.pid, logPath: started.logPath, worker: claimed.worker, forced: claimed.forced, status: claimed.job.status };
  } catch (err) {
    await failCloseStart({ store, id, worker: claimed.worker, row: claimed.row });
    throw new UserError(`could not start the close of job #${id}: ${err?.message ?? String(err)}; run again with: nightshift queue close ${id}`);
  }
}

// Makes THIS process a registered close, unless the parent that spawned it already registered it.
async function registerForegroundClose({ id, env, killImpl }) {
  if (ownRunnerRecord(env)) return { self: false };
  return await withLock(env, () => {
    if (ownRunnerRecord(env)) return { self: false };
    pruneDeadRunners(env, killImpl);
    registerClose({ pid: process.pid, id, detached: false, logPath: null, runtimeDir: packageRoot() }, env);
    return { self: true };
  });
}

// Confirms the lease the detached parent took for this process through the token it handed down.
async function adoptParentLease({ store, id, force, env }) {
  const worker = env[CLOSE_WORKER_ENV].trim();
  const adopted = await store.jobs.adoptClose(id, { worker, leaseS: closeLeaseSeconds(env) });
  if (!adopted) throw new UserError(`the close lease of job #${id} is not held by this process any more; run nightshift queue status ${id}`);
  const job = await store.jobs.getJob(id);
  return { job, worker, forced: force === true, row: job };
}

// The lease this process closes under: the one the detached parent handed down, or one taken here.
async function foregroundLease({ store, id, force, env }) {
  const token = typeof env[CLOSE_WORKER_ENV] === "string" ? env[CLOSE_WORKER_ENV].trim() : "";
  if (token) return await adoptParentLease({ store, id, force, env });
  return await claimClose({ store, id, force, env });
}

// Turns SIGTERM and SIGINT into an abort of the close for as long as it runs, and answers the function that removes them.
function abortOnSignals(controller) {
  const abort = () => controller.abort(new Error("interrupted"));
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  return () => {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  };
}

// Runs the close of a job in THIS process as a registered close, and answers its outcome with the job as it ended.
export async function runCloseHere({ store, id, force = false, env = process.env, deps = null, killImpl = killProcess, onStep, onStart }) {
  const lease = await foregroundLease({ store, id, force, env });
  onStart?.(lease);
  await registerForegroundClose({ id, env, killImpl });
  const controller = new AbortController();
  const removeSignals = abortOnSignals(controller);
  try {
    const outcome = await runClosePipeline({
      store,
      job: lease.row,
      worker: lease.worker,
      env,
      deps,
      timeoutS: closeTimeoutS(env),
      signal: controller.signal,
      onStep,
      checkout: lease.checkout,
      force,
    });
    return { outcome, job: await store.jobs.getJob(id) };
  } finally {
    removeSignals();
    removeOwnRunnerRecord(env);
  }
}

// Closes a job in the calling process without any CLI around it: validate, take the lease, run the steps, and answer the outcome.
export async function closeInProcess({ store, id, env = process.env, deps = null, force = false, onStep = null, signal = null }) {
  const claimed = await claimClose({ store, id, force, env });
  return await runClosePipeline({ store, job: claimed.row, worker: claimed.worker, env, deps, timeoutS: closeTimeoutS(env), signal, onStep, checkout: claimed.checkout, force });
}
