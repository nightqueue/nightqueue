import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, logsDir } from "../config/paths.mjs";
import { ensureHome } from "../config/store.mjs";
import { countActiveJobs, countAttempt, countsByStatus, finishJob, peekNextJob, persistRunFacts } from "../memory/jobs.mjs";
import { acquire, concurrencyCap, isPaused, leaseHeartbeatMs, release, renew, resumeSessionEnabled, stillOwned } from "./claim.mjs";
import { backoffMs, classifyJobResult, isTransientFailure } from "./classify.mjs";
import { preflight } from "./preflight.mjs";
import { decideResume, isSafeSegment, readRunState } from "./resume.mjs";
import { buildPrompt, cliEntrypoint, IDLE_TIMEOUT_S, spawnClaude } from "./spawn.mjs";
import { extractSessionIdFromEventLine, extractSlugFromEventLine, extractUsage, sumUsage } from "./stream.mjs";

// Interval between two cycles of `queue run --watch` when the operator gives no number.
export const WATCH_INTERVAL_DEFAULT_S = 30;

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const DEFAULT_DEPS = {
  spawnImpl: spawn,
  sleepImpl: sleep,
  gitImpl: undefined,
  existsImpl: undefined,
  resolveBinImpl: undefined,
  stopSignalImpl: null,
  idleTimeoutS: IDLE_TIMEOUT_S,
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
  const ctx = { env, deps: withDefaults(deps, env), state: { stopping: false } };
  const uninstall = installShutdown(ctx.state);
  const limit = localLimit(max, cap);
  const processed = [];
  const pool = new Set();
  const seen = new Set();
  let reason = "empty-queue";
  try {
    while (!ctx.state.stopping) {
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
      if (state.stopping || (cycles !== null && passes.length >= cycles)) break;
      await options.sleepImpl(Math.max(1, Number(intervalS) || WATCH_INTERVAL_DEFAULT_S) * 1000);
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

// Starts `shift queue run` detached, with its output going to a log file, and returns right away.
export function launchDetachedRunner({ jobId = null, env = process.env, spawnImpl = spawn } = {}) {
  ensureHome(env);
  const logPath = join(logsDir(env), `runner-${compactStamp()}.log`);
  try {
    mkdirSync(logsDir(env), { recursive: true });
    const fd = openSync(logPath, "a");
    const args = [cliEntrypoint(), "queue", "run", ...(jobId === null ? [] : ["--job", String(jobId)])];
    const child = spawnImpl(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...env } });
    child?.unref?.();
    return { pid: child?.pid ?? null, logPath };
  } catch (err) {
    throw new UserError(`could not start the detached runner: ${err?.message ?? String(err)}`);
  }
}
