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
import { shipRefusal } from "../memory/jobs.mjs";
import { prStateKey } from "./pr-state.mjs";
import { killProcess, ownRunnerRecord, pruneDeadRunners, removeOwnRunnerRecord, writeRunnerRecord } from "./registry.mjs";
import { callerJobId } from "./retry.mjs";
import { compactStamp } from "./runner.mjs";
import { runShip, SHIP_LEASE_SLACK_S } from "./ship.mjs";
import { SHIP_WORKER_ENV } from "./ship-deps.mjs";
import { parseShipChecklist } from "./ship-view.mjs";

export { SHIP_LEASE_SLACK_S, SHIP_WORKER_ENV };

// Refuses a ship from inside an unattended run: shipping is the operator's act, never an agent's.
function refuseShipInsideJob(env) {
  const own = callerJobId(env);
  if (own === null) return;
  throw new UserError(`refusing to ship from inside job \`${own}\`: an unattended run never ships; ask the operator to run nightshift queue ship <id>`);
}

// The hard timeout of one ship attempt, from the configuration of this home.
export function shipTimeoutS(env) {
  return loadConfig(env).queue.shipTimeoutS;
}

// The lease a ship takes: its hard timeout plus a slack, so a live ship never looks dead.
function shipLeaseSeconds(env) {
  return shipTimeoutS(env) + SHIP_LEASE_SLACK_S;
}

// A fresh token naming the process that holds a ship lease.
export function shipWorkerId() {
  return `ship:${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
}

// The registered checkout of a job's project, refusing an unregistered project or a checkout that is gone.
function projectCheckout(job, env) {
  const project = projectByName(loadConfig(env), job.project);
  if (!project) throw new UserError(`job \`${job.id}\` belongs to project \`${job.project}\`, which is not registered; run \`nightshift project list\``);
  if (!existsSync(project.path)) throw new UserError(`the checkout of project \`${job.project}\` is missing: ${project.path}`);
  return project.path;
}

// Checks, before any lease, that a job can be shipped: its status, its pull request, its project and its checkout.
export async function validateShipTarget({ store, id, force = false, env = process.env }) {
  const job = await store.jobs.getJob(id);
  const refusal = shipRefusal(id, job, { force });
  if (refusal) throw new UserError(refusal);
  const checkout = projectCheckout(job, env);
  if (prStateKey(job.pr_url) === null) throw new UserError(`job \`${id}\` carries a pull request that is not a GitHub pull request URL: ${job.pr_url}`);
  return { job, checkout, forced: job.status !== "done" };
}

// Takes the ship lease in one compare-and-swap; a race lost is refused in the words of the row as it is now.
async function acquireOrRefuse({ store, id, worker, force, env }) {
  const row = await store.jobs.acquireShip(id, { worker, leaseS: shipLeaseSeconds(env), force });
  if (row) return row;
  const refusal = shipRefusal(id, await store.jobs.getJob(id), { force });
  throw new UserError(refusal ?? `job \`${id}\` could not take the ship lease; run nightshift queue status ${id}`);
}

// Validates the target and takes its lease: the part of a start that writes, run only after every refusal had its say.
async function claimShip({ store, id, force, env }) {
  refuseShipInsideJob(env);
  const target = await validateShipTarget({ store, id, force, env });
  const worker = shipWorkerId();
  const row = await acquireOrRefuse({ store, id, worker, force, env });
  return { ...target, worker, row };
}

// Arguments of the detached ship: `--foreground` is what makes the child run the steps instead of detaching again.
function detachedShipArgs({ id, force, runtimeDir }) {
  return [join(runtimeDir, "bin", "nightshift.mjs"), "queue", "ship", String(id), "--foreground", ...(force ? ["--force"] : [])];
}

// Records an asynchronous spawn failure in the ship log, the file the started line already points at.
function recordSpawnFailure(logPath, err) {
  try {
    appendFileSync(logPath, `could not start the detached ship: ${err?.message ?? String(err)}\n`);
  } catch {
    return;
  }
}

// Spawns the detached ship on its own log, handing it the lease token through its environment.
function launchDetachedShip({ id, force, worker, env, spawnImpl }) {
  ensureHome(env);
  mkdirSync(logsDir(env), { recursive: true });
  const logPath = join(logsDir(env), `ship-${id}-${compactStamp()}.log`);
  const runtimeDir = spawnRoot(env);
  const fd = openSync(logPath, "a");
  try {
    const args = detachedShipArgs({ id, force, runtimeDir });
    const child = spawnImpl(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...env, [SHIP_WORKER_ENV]: worker } });
    child?.on?.("error", (err) => recordSpawnFailure(logPath, err));
    child?.unref?.();
    return { pid: child?.pid ?? null, logPath, runtimeDir };
  } finally {
    closeSync(fd);
  }
}

// Writes the registration of a ship process, the record that makes it visible to status, doctor and the install guard.
function registerShip({ pid, id, detached, logPath, runtimeDir }, env) {
  return writeRunnerRecord(
    { pid, startedAt: new Date().toISOString(), mode: "ship", jobId: id, intervalS: null, detached, logPath, runtimeDir, rateLimit: null, window: null },
    env,
  );
}

// Spawns the detached ship and registers it, inside one hold of the home lock.
function spawnAndRegisterShip({ id, force, worker, env, spawnImpl, killImpl }) {
  pruneDeadRunners(env, killImpl);
  const { pid, logPath, runtimeDir } = launchDetachedShip({ id, force, worker, env, spawnImpl });
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("the detached ship did not report a pid");
  registerShip({ pid, id, detached: true, logPath, runtimeDir }, env);
  return { pid, logPath };
}

// Stops a ship that never started, keeping its checklist so the next `queue ship` resumes it.
async function failShipStart({ store, id, worker, row }) {
  const checklist = parseShipChecklist(row?.ship) ?? { attempts: 1, steps: {}, data: {} };
  const ship = { ...checklist, finishedAt: new Date().toISOString(), failed: { step: "start", reason: "spawn-failed" } };
  try {
    await store.jobs.failShip(id, { worker, ship });
  } catch {
    return;
  }
}

// Starts the ship of a job detached: validate, take the lease, spawn and register; a spawn that fails releases the lease as a failed ship.
export async function startShipDetached({ store, id, force = false, env = process.env, spawnImpl = spawn, killImpl = killProcess }) {
  const claimed = await claimShip({ store, id, force, env });
  try {
    const started = await withLock(env, () => spawnAndRegisterShip({ id, force, worker: claimed.worker, env, spawnImpl, killImpl }));
    return { started: true, jobId: id, pid: started.pid, logPath: started.logPath, worker: claimed.worker, forced: claimed.forced, status: claimed.job.status };
  } catch (err) {
    await failShipStart({ store, id, worker: claimed.worker, row: claimed.row });
    throw new UserError(`could not start the ship of job #${id}: ${err?.message ?? String(err)}; run again with: nightshift queue ship ${id}`);
  }
}

// Makes THIS process a registered ship, unless the parent that spawned it already registered it.
async function registerForegroundShip({ id, env, killImpl }) {
  if (ownRunnerRecord(env)) return { self: false };
  return await withLock(env, () => {
    if (ownRunnerRecord(env)) return { self: false };
    pruneDeadRunners(env, killImpl);
    registerShip({ pid: process.pid, id, detached: false, logPath: null, runtimeDir: packageRoot() }, env);
    return { self: true };
  });
}

// Confirms the lease the detached parent took for this process through the token it handed down.
async function adoptParentLease({ store, id, env }) {
  const worker = env[SHIP_WORKER_ENV].trim();
  const adopted = await store.jobs.adoptShip(id, { worker, leaseS: shipLeaseSeconds(env) });
  if (!adopted) throw new UserError(`the ship lease of job #${id} is not held by this process any more; run nightshift queue status ${id}`);
  const job = await store.jobs.getJob(id);
  return { job, worker, forced: job.status !== "done", row: job };
}

// The lease this process ships under: the one the detached parent handed down, or one taken here.
async function foregroundLease({ store, id, force, env }) {
  const token = typeof env[SHIP_WORKER_ENV] === "string" ? env[SHIP_WORKER_ENV].trim() : "";
  if (token) return await adoptParentLease({ store, id, env });
  return await claimShip({ store, id, force, env });
}

// Turns SIGTERM and SIGINT into an abort of the ship for as long as it runs, and answers the function that removes them.
function abortOnSignals(controller) {
  const abort = () => controller.abort(new Error("interrupted"));
  process.on("SIGTERM", abort);
  process.on("SIGINT", abort);
  return () => {
    process.off("SIGTERM", abort);
    process.off("SIGINT", abort);
  };
}

// Runs the ship of a job in THIS process as a registered ship, and answers its outcome with the job as it ended.
export async function runShipHere({ store, id, force = false, env = process.env, deps = null, killImpl = killProcess, onStep, onStart }) {
  const lease = await foregroundLease({ store, id, force, env });
  onStart?.(lease);
  await registerForegroundShip({ id, env, killImpl });
  const controller = new AbortController();
  const removeSignals = abortOnSignals(controller);
  try {
    const outcome = await runShip({
      store,
      job: lease.row,
      worker: lease.worker,
      env,
      deps,
      timeoutS: shipTimeoutS(env),
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

// Ships a job in the calling process without any CLI around it: validate, take the lease, run the steps, and answer the outcome.
export async function shipJob({ store, id, env = process.env, deps = null, force = false, onStep = null, signal = null }) {
  const claimed = await claimShip({ store, id, force, env });
  return await runShip({ store, job: claimed.row, worker: claimed.worker, env, deps, timeoutS: shipTimeoutS(env), signal, onStep, checkout: claimed.checkout, force });
}
