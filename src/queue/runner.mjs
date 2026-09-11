import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, logsDir } from "../config/paths.mjs";
import { ensureHome } from "../config/store.mjs";
import { packageRoot } from "../host/paths.mjs";
import { checkpointWal, sqliteToIso } from "../memory/db.mjs";
import {
  countActiveJobs,
  countAttempt,
  countsByStatus,
  finishJob,
  getJob,
  peekNextJob,
  persistRunFacts,
} from "../memory/jobs.mjs";
import { markRoadmapItemDone } from "../memory/roadmap.mjs";
import { acquire, concurrencyCap, isPaused, leaseHeartbeatMs, release, renew, resumeSessionEnabled, stillOwned } from "./claim.mjs";
import { backoffMs, classifyJobResult, isTransientFailure } from "./classify.mjs";
import { refreshMergedJobs } from "./merged.mjs";
import { preflight } from "./preflight.mjs";
import { runnerPidfileState } from "./pidfile.mjs";
import { repairWarningLine } from "./reconcile.mjs";
import { decideResume, isSafeSegment, readRunState, writeRunTerminal } from "./resume.mjs";
import { buildPrompt, cliEntrypoint, IDLE_TIMEOUT_S, spawnClaude } from "./spawn.mjs";
import { extractSessionIdFromEventLine, extractSlugFromEventLine, extractUsage, sumUsage } from "./stream.mjs";

// Interval between two cycles of `queue run --watch` when the operator gives no number.
export const WATCH_INTERVAL_DEFAULT_S = 30;

// Waits the given number of milliseconds, through a promise that can be cancelled before its timer fires.
function sleep(ms) {
  let timer = null;
  const waiting = new Promise((done) => {
    timer = setTimeout(done, ms);
  });
  waiting.cancel = () => clearTimeout(timer);
  return waiting;
}

const DEFAULT_DEPS = {
  spawnImpl: spawn,
  sleepImpl: sleep,
  gitImpl: undefined,
  existsImpl: undefined,
  resolveBinImpl: undefined,
  stopSignalImpl: null,
  idleTimeoutS: IDLE_TIMEOUT_S,
  refreshMergedImpl: refreshMergedJobs,
};

// Merges the injected seams over the real implementations; the ownership poll is the configured heartbeat.
function withDefaults(deps, env) {
  const merged = { ...DEFAULT_DEPS, stopPollMs: leaseHeartbeatMs(env) };
  for (const [key, value] of Object.entries(deps ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

// Installs the shutdown handlers of the runner and returns the function that removes them.
function installShutdown(state) {
  const onSignal = () => {
    state.stopping = true;
    state.wake?.();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
}

// Tells the spawn to end the child: the runner is shutting down, or this job is no longer ours.
async function shouldStop(job, ctx, ownership) {
  if (ctx.state.stopping) return true;
  if (typeof ctx.deps.stopSignalImpl === "function") return Boolean(await ctx.deps.stopSignalImpl(job));
  if (stillOwned(job, ctx.env)) return false;
  ownership.lost = true;
  return true;
}

// Records the slug of the run: the LAST declaration of the orchestrator wins, and only a safe path segment counts.
function captureSlug(job, facts, line, env) {
  const slug = extractSlugFromEventLine(line);
  if (!slug || slug === facts.slug || !isSafeSegment(slug)) return;
  facts.slug = slug;
  const branch = readRunState({ project: job.project, slug, env })?.branch ?? null;
  persistRunFacts(job.id, { worker: job.worker, slug, branch }, env);
}

// Records the run facts that appear in the stream, writing one fact per line of the stream at most.
function captureFacts(job, facts, line, env) {
  captureSlug(job, facts, line, env);
  if (facts.sessionId) return;
  const sessionId = extractSessionIdFromEventLine(line);
  if (!sessionId) return;
  facts.sessionId = sessionId;
  persistRunFacts(job.id, { worker: job.worker, sessionId }, env);
}

// Records in the job log that this runner lost the job; it is the ONLY write allowed once ownership is gone.
function noteOwnershipLost(job, env) {
  try {
    appendFileSync(jobLogPath(job.id, env), `=== ownership lost @ ${new Date().toISOString()} ===\n`);
  } catch {
    return;
  }
}

// Tells whether a failed attempt deserves another one: only a transient failure, never a timeout.
function isRetryable(job, attempt, result, outcome) {
  if (outcome.status !== "failed" || result.timedOut || result.idleTimedOut) return false;
  return isTransientFailure(result.log) && attempt < job.max_attempts;
}

// Runs the attempts of a job, re-arming the lease before each one and backing off between retries.
async function runAttempts(job, ctx) {
  const { env, deps } = ctx;
  const facts = { slug: job.slug ?? null, sessionId: job.session_id ?? null };
  const ownership = { lost: false };
  const usages = [];
  let attempt = job.attempts;
  while (true) {
    if (!renew(job, env)) return { lost: true, facts, attempt, usage: sumUsage(usages), outcome: null, result: null };
    const result = await spawnClaude({
      prompt: ctx.prompt,
      cwd: ctx.cwd,
      timeoutS: job.timeout_s,
      idleTimeoutS: deps.idleTimeoutS,
      logPath: jobLogPath(job.id, env),
      env,
      attempt,
      jobId: job.id,
      spawnImpl: deps.spawnImpl,
      onLine: (line) => captureFacts(job, facts, line, env),
      stopSignalImpl: () => shouldStop(job, ctx, ownership),
      stopPollMs: deps.stopPollMs,
      resumeSessionId: resumeSessionEnabled(env) ? facts.sessionId : null,
      resolveBinImpl: deps.resolveBinImpl,
    });
    if (ownership.lost) return { lost: true, facts, attempt, usage: sumUsage(usages), outcome: null, result };
    usages.push(extractUsage(result.log));
    const outcome = classifyJobResult(result);
    if (!isRetryable(job, attempt, result, outcome)) {
      return { lost: false, facts, attempt, usage: sumUsage(usages), outcome, result };
    }
    await deps.sleepImpl(backoffMs(attempt));
    if (!countAttempt(job.id, { worker: job.worker }, env)) {
      return { lost: true, facts, attempt, usage: sumUsage(usages), outcome, result };
    }
    attempt += 1;
  }
}

// Closes the roadmap item this job came from; bookkeeping never costs the outcome that was just written.
function closeRoadmapItem(jobId, env) {
  try {
    markRoadmapItemDone(jobId, env);
  } catch {
    return;
  }
}

// Records in the job log that the outcome could not be witnessed on disk; the job keeps the outcome it was given.
function noteWitnessFailure(jobId, reason, env) {
  try {
    appendFileSync(jobLogPath(jobId, env), `could not write the terminal witness: ${reason}\n`);
  } catch {
    return;
  }
}

// Writes the witness of the outcome next to the run: the durable record the database is verified against.
function writeWitness(job, env) {
  try {
    const row = getJob(job.id, env);
    if (!row) return;
    const written = writeRunTerminal({
      project: row.project,
      slug: row.slug,
      terminal: {
        status: row.status,
        prUrl: row.pr_url ?? null,
        finishedAt: sqliteToIso(row.finished_at),
        writtenBy: packageRoot(),
        pid: process.pid,
      },
      env,
    });
    if (written.status !== "written") noteWitnessFailure(job.id, written.reason ?? written.status, env);
  } catch (err) {
    noteWitnessFailure(job.id, err?.message ?? String(err), env);
  }
}

// Writes the outcome of a finished job, together with the branch the pipeline registered in its state.
function finalize(job, run, env) {
  const state = readRunState({ project: job.project, slug: run.facts.slug, env });
  if (state?.branch) persistRunFacts(job.id, { worker: job.worker, branch: state.branch }, env);
  const written = finishJob(
    job.id,
    {
      worker: job.worker,
      status: run.outcome.status,
      result: {
        status: run.outcome.status,
        prUrl: run.outcome.prUrl,
        logPath: jobLogPath(job.id, env),
        exitCode: run.result.exitCode,
        timedOut: run.result.timedOut,
        idleTimedOut: run.result.idleTimedOut,
        attempts: run.attempt,
      },
      prUrl: run.outcome.prUrl,
      noticeMd: run.outcome.noticeMd,
      usage: run.usage,
    },
    env,
  );
  if (written) {
    checkpointWal(env);
    writeWitness(job, env);
  }
  if (written && run.outcome.status === "done") closeRoadmapItem(job.id, env);
  return { id: job.id, status: written ? run.outcome.status : "lost", prUrl: run.outcome.prUrl, attempts: run.attempt };
}

// Runs one claimed job end to end: preflight, attempts and the single write of the outcome.
async function runJob(job, ctx) {
  const { env, deps } = ctx;
  const check = preflight({ job, env, gitImpl: deps.gitImpl, existsImpl: deps.existsImpl, resolveBinImpl: deps.resolveBinImpl });
  if (!check.ok) {
    release(job, { blocked: { code: check.code, message: check.message } }, env);
    return { id: job.id, status: "blocked", code: check.code };
  }
  const resume = decideResume({ state: readRunState({ project: job.project, slug: job.slug, env }) });
  const prompt = buildPrompt({ job, resume });
  const run = await runAttempts(job, { ...ctx, cwd: check.cwd, prompt });
  if (run.lost) {
    noteOwnershipLost(job, env);
    return { id: job.id, status: "lost", attempts: run.attempt };
  }
  if (ctx.state.stopping) {
    release(job, { interrupted: true }, env);
    return { id: job.id, status: "interrupted", attempts: run.attempt };
  }
  return finalize(job, run, env);
}

// Directory this runner loaded its code from: the one it registered when it started, or the tree this process is running.
function ownRuntimeDir(env) {
  try {
    const state = runnerPidfileState(env);
    const dir = state.status === "alive" && state.info.pid === process.pid ? state.info.runtimeDir : null;
    return typeof dir === "string" && dir ? dir : packageRoot();
  } catch {
    return packageRoot();
  }
}

// Repairs the jobs whose run directory already says how they ended, and writes a repair the database refused into the log of this runner.
function warnRepairRefused(env) {
  const warning = repairWarningLine(env);
  if (warning) process.stderr.write(`warning: ${warning}\n`);
}

// Warns, once, that the tree this runner runs from is gone; the detached runner writes its stderr straight into its own log.
function warnRuntimeGone(dir) {
  process.stderr.write(
    `runtime directory ${dir} is gone - this runner finishes the job it is running and exits; start a new runner with: nightshift queue run\n`,
  );
}

// Read-only report of what the cycle would do, the answer of `queue run --dry`.
function dryReport({ jobId, cap, env }) {
  return {
    dry: true,
    paused: isPaused(env),
    cap,
    heartbeatS: leaseHeartbeatMs(env) / 1000,
    active: countActiveJobs(env),
    counts: countsByStatus(env),
    next: jobId === null ? (peekNextJob(env)?.id ?? null) : jobId,
  };
}

// Ceiling of jobs this process runs at the same time, never above the global ceiling of the home.
function localLimit(max, cap) {
  const requested = Number.isInteger(max) && max > 0 ? max : cap;
  return Math.max(1, Math.min(requested, cap));
}

// Claims and runs jobs until the queue refuses another one, respecting the ceiling inside and across processes.
export async function runCycle({ jobId = null, max = null, dry = false, env = process.env, deps = {} } = {}) {
  const cap = concurrencyCap(env);
  if (dry) return dryReport({ jobId, cap, env });
  warnRepairRefused(env);
  const ctx = { env, deps: withDefaults(deps, env), state: { stopping: false } };
  ctx.deps.refreshMergedImpl({ env });
  const uninstall = installShutdown(ctx.state);
  const limit = localLimit(max, cap);
  const runtime = ownRuntimeDir(env);
  const processed = [];
  const pool = new Set();
  const seen = new Set();
  let reason = "empty-queue";
  try {
    while (!ctx.state.stopping) {
      if (!existsSync(runtime)) {
        reason = "runtime-gone";
        warnRuntimeGone(runtime);
        break;
      }
      if (pool.size >= limit) {
        await Promise.race(pool);
        continue;
      }
      const claimed = acquire({ jobId, cap, env });
      if (!claimed.job) {
        reason = claimed.reason;
        if (reason === "project-busy" && pool.size) {
          await Promise.race(pool);
          continue;
        }
        break;
      }
      if (seen.has(claimed.job.id)) {
        release(claimed.job, null, env);
        reason = "already-tried";
        break;
      }
      seen.add(claimed.job.id);
      reason = "claimed";
      const task = runJob(claimed.job, ctx)
        .catch((err) => ({ id: claimed.job.id, status: "error", error: err?.message ?? String(err) }))
        .then((result) => {
          processed.push(result);
          pool.delete(task);
        });
      pool.add(task);
      if (jobId !== null) break;
    }
    await Promise.allSettled([...pool]);
  } finally {
    uninstall();
  }
  return { processed, reason, cap, stopped: ctx.state.stopping };
}

// Waits until the next pass over the queue, or until a shutdown signal wakes the runner up first.
function waitNextPass(ms, state, sleepImpl) {
  const waiting = sleepImpl(ms);
  return new Promise((done) => {
    const finish = () => {
      state.wake = null;
      done();
    };
    state.wake = () => {
      waiting?.cancel?.();
      finish();
    };
    Promise.resolve(waiting).then(finish);
  });
}

// Repeats the cycle while the runner lives, sleeping between two passes over the queue.
export async function runWatch({ intervalS = WATCH_INTERVAL_DEFAULT_S, jobId = null, max = null, env = process.env, deps = {}, cycles = null, onCycle = () => {} } = {}) {
  const options = withDefaults(deps, env);
  const state = { stopping: false };
  const uninstall = installShutdown(state);
  const passes = [];
  try {
    while (!state.stopping && (cycles === null || passes.length < cycles)) {
      const pass = await runCycle({ jobId, max, env, deps: options });
      passes.push(pass);
      onCycle(pass);
      if (state.stopping || pass.reason === "runtime-gone" || (cycles !== null && passes.length >= cycles)) break;
      await waitNextPass(Math.max(1, Number(intervalS) || WATCH_INTERVAL_DEFAULT_S) * 1000, state, options.sleepImpl);
    }
  } finally {
    uninstall();
  }
  return passes;
}

export const DRAIN_INTERVAL_S = 15;

// Reasons of a cycle after which a drain has nothing left to do: the queue is empty, paused, the cycle was told to stop, or the tree it runs from is gone.
const DRAIN_DONE_REASONS = new Set(["empty-queue", "paused", "already-tried", "runtime-gone"]);

// Runs cycles until the queue has nothing pending, waiting between passes while the pending jobs are held back by a busy project or the concurrency cap - what "run the queue" means to an operator.
export async function runDrain({ max = null, intervalS = DRAIN_INTERVAL_S, env = process.env, deps = {}, cycles = null, onCycle = () => {} } = {}) {
  const options = withDefaults(deps, env);
  const state = { stopping: false };
  const uninstall = installShutdown(state);
  const passes = [];
  try {
    while (!state.stopping && (cycles === null || passes.length < cycles)) {
      const pass = await runCycle({ max, env, deps: options });
      passes.push(pass);
      onCycle(pass);
      if (pass.stopped || DRAIN_DONE_REASONS.has(pass.reason)) break;
      if (cycles !== null && passes.length >= cycles) break;
      await waitNextPass(Math.max(1, Number(intervalS) || DRAIN_INTERVAL_S) * 1000, state, options.sleepImpl);
    }
  } finally {
    uninstall();
  }
  return passes;
}

// Timestamp of the runner log file name, compact enough to stay one path segment.
function compactStamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Arguments of the detached child: `--foreground` is what makes it run the queue instead of detaching again.
function detachedArgs({ jobId, max, watchIntervalS }) {
  return [
    cliEntrypoint(),
    "queue",
    "run",
    "--foreground",
    ...(jobId === null ? [] : ["--job", String(jobId)]),
    ...(max === null ? [] : ["--max", String(max)]),
    ...(watchIntervalS === null ? [] : ["--watch", String(watchIntervalS)]),
    ...(jobId === null && watchIntervalS === null ? ["--drain"] : []),
  ];
}

// Records an asynchronous spawn failure in the runner log, the file the started line already points at.
function recordSpawnFailure(logPath, err) {
  try {
    appendFileSync(logPath, `could not start the detached runner: ${err?.message ?? String(err)}\n`);
  } catch {}
}

// Starts the child on the open log descriptor and takes over the failures that arrive after this call returned.
function spawnRunner({ args, fd, logPath, env, spawnImpl }) {
  const child = spawnImpl(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...env } });
  child?.on?.("error", (err) => recordSpawnFailure(logPath, err));
  child?.unref?.();
  return { pid: child?.pid ?? null, logPath };
}

// Starts `nightshift queue run` detached, with its output going to a log file, and returns right away.
export function launchDetachedRunner({ jobId = null, max = null, watchIntervalS = null, env = process.env, spawnImpl = spawn } = {}) {
  ensureHome(env);
  const logPath = join(logsDir(env), `runner-${compactStamp()}.log`);
  try {
    mkdirSync(logsDir(env), { recursive: true });
    const fd = openSync(logPath, "a");
    const args = detachedArgs({ jobId, max, watchIntervalS });
    try {
      return spawnRunner({ args, fd, logPath, env, spawnImpl });
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    throw new UserError(`could not start the detached runner: ${err?.message ?? String(err)}`);
  }
}
