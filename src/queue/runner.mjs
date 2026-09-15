import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, logsDir } from "../config/paths.mjs";
import { ensureHome } from "../config/store.mjs";
import { packageRoot } from "../host/paths.mjs";
import { sqliteToIso } from "../memory/schema.mjs";
import { openStore } from "../store/open.mjs";
import { acquire, concurrencyCap, isPaused, leaseHeartbeatMs, release, renew, resumeSessionEnabled, stillOwned } from "./claim.mjs";
import { backoffMs, classifyJobResult, isTransientFailure } from "./classify.mjs";
import { refreshMergedJobs } from "./merged.mjs";
import { preflight } from "./preflight.mjs";
import { clearOwnPause, inheritablePause, ownPauseUntilMs, PAUSE_POLL_MS, pauseFromEvent, pauseUntilMs, readOwnPause, recordOwnPause, resumeRequestedAt } from "./rate-limit.mjs";
import { ownRunnerRecord } from "./registry.mjs";
import { repairWarningLine } from "./reconcile.mjs";
import { clearRunOutcome, decideResume, isSafeSegment, readRunState, writeRunTerminal } from "./resume.mjs";
import { buildPrompt, cliEntrypoint, IDLE_TIMEOUT_S, spawnClaude } from "./spawn.mjs";
import { extractRateLimitFromEventLine, extractSessionIdFromEventLine, extractSlugFromEventLine, extractUsage, sumUsage } from "./stream.mjs";

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
  pauseSignalImpl: null,
  idleTimeoutS: IDLE_TIMEOUT_S,
  refreshMergedImpl: refreshMergedJobs,
  finishJobImpl: null,
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
  if (await stillOwned(job, ctx.env)) return false;
  ownership.lost = true;
  return true;
}

// Records the slug of the run: the LAST declaration of the orchestrator wins, and only a safe path segment counts.
async function captureSlug(job, facts, line, { store, env }) {
  const slug = extractSlugFromEventLine(line);
  if (!slug || slug === facts.slug || !isSafeSegment(slug)) return;
  facts.slug = slug;
  const branch = readRunState({ project: job.project, slug, env })?.branch ?? null;
  await store.jobs.persistRunFacts(job.id, { worker: job.worker, slug, branch });
}

// Appends one line to the accumulated log of a job; a log that refuses the write never costs the run.
function appendJobLog(jobId, line, env) {
  try {
    appendFileSync(jobLogPath(jobId, env), `${line}\n`);
  } catch {
    return;
  }
}

// Arms the pause of THIS runner, recording it where every reader of the registry sees it and marking the job log the operator narrates.
// A record that refuses the write is said out loud instead of being dropped: only this run then waits the limit out, and no other reader of the home learns about it.
async function armPause(job, pause, env) {
  try {
    await recordOwnPause(pause, env);
  } catch (err) {
    appendJobLog(job.id, `the rate limit pause could not be recorded, so only this run waits it out: ${err?.message ?? String(err)}`, env);
  }
  appendJobLog(job.id, `=== rate limit until ${pause.pausedUntil} @ ${new Date().toISOString()} ===`, env);
}

// Records the rate limit the stream reported and arms a pause when the event calls for one; a further pause always replaces a nearer one.
async function captureRateLimit(job, facts, line, { env }) {
  const info = extractRateLimitFromEventLine(line);
  if (!info) return;
  facts.rateLimit = info;
  const pause = pauseFromEvent(info);
  if (!pause || (facts.pause && facts.pause.pausedUntil >= pause.pausedUntil)) return;
  facts.pause = pause;
  await armPause(job, pause, env);
}

// Records the run facts that appear in the stream, writing one fact per line of the stream at most.
async function captureFacts(job, facts, line, ctx) {
  await captureSlug(job, facts, line, ctx);
  await captureRateLimit(job, facts, line, ctx);
  if (facts.sessionId) return;
  const sessionId = extractSessionIdFromEventLine(line);
  if (!sessionId) return;
  facts.sessionId = sessionId;
  await ctx.store.jobs.persistRunFacts(job.id, { worker: job.worker, sessionId });
}

// Delivers one line of the stream to the fact capture, which is never allowed to bring the run down - the same guarantee the spawn gives a synchronous consumer.
function captureLine(job, facts, line, ctx) {
  captureFacts(job, facts, line, ctx).catch(() => {});
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

// The instant a job this rate limit ended must not be claimed again before, or null when the attempt did not end on a limit.
// It is decided from the structured events of the stream alone, and BEFORE the generic transient retry, which would spend an attempt on a limit that is still on.
function rateLimitExit(result, facts) {
  if (result.exitCode === 0 || result.timedOut || result.idleTimedOut || result.stopped || result.spawnError) return null;
  const pause = facts.pause ?? pauseFromEvent(facts.rateLimit);
  return pause?.resetsAt ?? null;
}

// Tells whether this job was parked by a rate limit, the one case that resumes the session whatever the operator configured.
function wasRateLimitParked(job) {
  return typeof job?.not_before === "string" && job.not_before.trim() !== "";
}

// Runs the attempts of a job, re-arming the lease before each one and backing off between retries.
async function runAttempts(job, ctx) {
  const { env, deps } = ctx;
  const facts = { slug: job.slug ?? null, sessionId: job.session_id ?? null, rateLimit: null, pause: null };
  const pauseSignalImpl = deps.pauseSignalImpl ?? (() => ownPauseUntilMs(env) ?? pauseUntilMs(facts.pause));
  const resumeForced = resumeSessionEnabled(env) || wasRateLimitParked(job);
  const ownership = { lost: false };
  const usages = [];
  let attempt = job.attempts;
  while (true) {
    if (!(await renew(job, env))) return { lost: true, facts, attempt, usage: sumUsage(usages), outcome: null, result: null };
    if (isSafeSegment(facts.slug)) clearRunOutcome({ project: job.project, slug: facts.slug, env });
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
      onLine: (line) => captureLine(job, facts, line, ctx),
      stopSignalImpl: () => shouldStop(job, ctx, ownership),
      pauseSignalImpl,
      stopPollMs: deps.stopPollMs,
      resumeSessionId: resumeForced ? facts.sessionId : null,
      resolveBinImpl: deps.resolveBinImpl,
    });
    if (ownership.lost) return { lost: true, facts, attempt, usage: sumUsage(usages), outcome: null, result };
    usages.push(extractUsage(result.log));
    const notBefore = rateLimitExit(result, facts);
    if (notBefore) return { lost: false, parked: { notBefore }, facts, attempt, usage: sumUsage(usages), outcome: null, result };
    const outcome = classifyJobResult({ ...result, state: readRunState({ project: job.project, slug: facts.slug, env }) });
    if (!isRetryable(job, attempt, result, outcome)) {
      return { lost: false, facts, attempt, usage: sumUsage(usages), outcome, result };
    }
    await deps.sleepImpl(backoffMs(attempt));
    if (!(await ctx.store.jobs.countAttempt(job.id, { worker: job.worker }))) {
      return { lost: true, facts, attempt, usage: sumUsage(usages), outcome, result };
    }
    attempt += 1;
  }
}

// Closes the roadmap item this job came from; bookkeeping never costs the outcome that was just written.
async function closeRoadmapItem(jobId, store) {
  try {
    await store.roadmap.markRoadmapItemDone(jobId);
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
// The witness comes from the outcome the runner holds in memory, never from the row: when the finish itself
// failed to commit, the row still says `running`, and the witness is exactly what the reconciliation needs then.
async function writeWitness(job, outcome, { store, env }) {
  try {
    const row = await store.jobs.getJob(job.id);
    const slug = row?.slug ?? job.slug;
    if (!slug) return;
    const written = writeRunTerminal({
      project: row?.project ?? job.project,
      slug,
      terminal: {
        status: outcome.status,
        prUrl: outcome.prUrl ?? null,
        finishedAt: row?.status === outcome.status && row?.finished_at ? sqliteToIso(row.finished_at) : new Date().toISOString(),
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

// Runs the finish, turning a database that refused the commit into a reported failure instead of a crash of the runner.
async function tryFinish(job, outcome, env) {
  try {
    return { written: await outcome.write(), error: null };
  } catch (err) {
    const message = err?.message ?? String(err);
    try {
      appendFileSync(jobLogPath(job.id, env), `finish verification failed\nthe finish of job #${job.id} did not commit: ${message}\n`);
      process.stderr.write(`job #${job.id}: the finish did not commit: ${message}\n`);
    } catch {}
    return { written: false, error: message };
  }
}

// Writes the outcome of a finished job, together with the branch the pipeline registered in its state.
async function finalize(job, run, ctx) {
  const { env, store } = ctx;
  const finishJobImpl = ctx.deps.finishJobImpl ?? ((id, outcome) => store.jobs.finishJob(id, outcome));
  const state = readRunState({ project: job.project, slug: run.facts.slug, env });
  if (state?.branch) await store.jobs.persistRunFacts(job.id, { worker: job.worker, branch: state.branch });
  const finish = await tryFinish(job, {
    write: () =>
      finishJobImpl(
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
      ),
  }, env);
  // The witness is written when the row took the finish AND when the database refused the commit - the second case is exactly
  // what the reconciliation repairs from. A finish that returned false means the row is no longer ours (another worker owns
  // it): no witness then, or the reconciliation would close a job someone else is still running.
  if (finish.written || finish.error) await writeWitness(job, run.outcome, ctx);
  if (finish.written) await store.checkpoint();
  if (finish.written && run.outcome.status === "done") await closeRoadmapItem(job.id, store);
  const status = finish.written ? run.outcome.status : finish.error ? "unrecorded" : "lost";
  const report = { id: job.id, status, prUrl: run.outcome.prUrl, attempts: run.attempt };
  return finish.error ? { ...report, error: finish.error } : report;
}

// Puts a job whose run ended on a rate limit back in the queue, due at the reset and with its attempt intact; the session it was running is kept, so the next claim resumes it.
async function parkRun(job, run, ctx) {
  const { env, store } = ctx;
  const notBefore = run.parked.notBefore;
  const parked = await store.jobs.parkJob(job.id, {
    worker: job.worker,
    notBefore,
    result: { rateLimited: true, notBefore, logPath: jobLogPath(job.id, env), exitCode: run.result.exitCode, attempts: run.attempt },
  });
  if (!parked) return { id: job.id, status: "lost", attempts: run.attempt };
  return { id: job.id, status: "rate-limited", attempts: run.attempt, notBefore };
}

// Runs one claimed job end to end: preflight, attempts and the single write of the outcome.
async function runJob(job, ctx) {
  const { env, deps } = ctx;
  const check = preflight({ job, env, gitImpl: deps.gitImpl, existsImpl: deps.existsImpl, resolveBinImpl: deps.resolveBinImpl });
  if (!check.ok) {
    await release(job, { blocked: { code: check.code, message: check.message } }, env);
    return { id: job.id, status: "blocked", code: check.code };
  }
  const resume = decideResume({ state: readRunState({ project: job.project, slug: job.slug, env }) });
  const prompt = buildPrompt({ job, resume });
  const run = await runAttempts(job, { ...ctx, cwd: check.cwd, prompt });
  if (run.lost) {
    noteOwnershipLost(job, env);
    return { id: job.id, status: "lost", attempts: run.attempt };
  }
  if (run.parked) return await parkRun(job, run, ctx);
  if (ctx.state.stopping) {
    await release(job, { interrupted: true }, env);
    return { id: job.id, status: "interrupted", attempts: run.attempt };
  }
  return await finalize(job, run, ctx);
}

// Directory this runner loaded its code from: the one it registered when it started, or the tree this process is running.
function ownRuntimeDir(env) {
  try {
    const dir = ownRunnerRecord(env)?.runtimeDir ?? null;
    return typeof dir === "string" && dir ? dir : packageRoot();
  } catch {
    return packageRoot();
  }
}

// Repairs the jobs whose run directory already says how they ended, and writes a repair the database refused into the log of this runner.
async function warnRepairRefused(env) {
  const warning = await repairWarningLine(env);
  if (warning) process.stderr.write(`warning: ${warning}\n`);
}

// Warns, once, that the tree this runner runs from is gone; the detached runner writes its stderr straight into its own log.
function warnRuntimeGone(dir) {
  process.stderr.write(
    `runtime directory ${dir} is gone - this runner finishes the job it is running and exits; start a new runner with: nightshift queue run\n`,
  );
}

// The rate limit a claim of this home would wait for right now: the pause a runner of it is waiting out, which a runner
// starting now adopts at its registration. A home where no live runner carries one has no limit to report.
function dryRateLimit(env) {
  const pause = inheritablePause(env);
  if (pause === null) return { pausedUntil: null, rateLimit: null };
  return { pausedUntil: pause.pausedUntil ?? null, rateLimit: { type: pause.type ?? null, resetsAt: pause.resetsAt ?? null, utilization: pause.utilization ?? null } };
}

// Read-only report of what the cycle would do, the answer of `queue run --dry`: both reasons a claim would not happen now,
// the sentinel the operator wrote by hand and the rate limit a runner of this home is waiting out.
async function dryReport({ jobId, cap, env }) {
  const store = openStore(env);
  return {
    dry: true,
    paused: isPaused(env),
    ...dryRateLimit(env),
    cap,
    heartbeatS: leaseHeartbeatMs(env) / 1000,
    active: await store.jobs.countActiveJobs(),
    counts: await store.jobs.countsByStatus(),
    next: jobId === null ? ((await store.jobs.peekNextJob())?.id ?? null) : jobId,
  };
}

// Tells whether the operator asked the runners of this home to resume after this pause was armed; a pause nobody can date is one this runner does not trust enough to keep waiting on.
function resumedPast(pause, env) {
  const requestedAt = resumeRequestedAt(env);
  if (requestedAt === null) return false;
  const pausedAt = Date.parse(String(pause?.pausedAt ?? ""));
  return !Number.isFinite(pausedAt) || requestedAt >= pausedAt;
}

// Forgets the very pause this decision was taken from; a record that refuses the write costs nothing here, because the pause is over either way.
async function forgetPause(pause, env) {
  try {
    await clearOwnPause(env, pause);
  } catch {
    return;
  }
}

// The instant this runner must not claim before, or null when it may claim now: a pause that ran out, or one a `queue resume` cleared, is forgotten here and never again read.
async function pauseGate(env) {
  const pause = readOwnPause(env);
  if (pause === null) return null;
  const until = pauseUntilMs(pause);
  if (until !== null && !resumedPast(pause, env)) return until;
  await forgetPause(pause, env);
  return null;
}

// Waits out the rate limit of THIS runner before it claims anything, one slice at a time, so a shutdown signal or a
// `queue resume` is noticed while it waits; a queue the operator paused by hand never waits at all, because `queue pause`
// means stop now and the cycle must end on it. Returns the reason the cycle ends with, or null when the runner may claim.
async function waitOutRateLimitPause(jobId, ctx) {
  const { env, deps, state } = ctx;
  let waited = false;
  while (!state.stopping) {
    if (jobId === null && isPaused(env)) return null;
    const until = await pauseGate(env);
    if (until === null) return null;
    waited = true;
    await waitNextPass(Math.min(Math.max(1, until - Date.now()), PAUSE_POLL_MS), state, deps.sleepImpl);
  }
  return waited ? "rate-limited" : null;
}

// Ceiling of jobs this process runs at the same time, never above the global ceiling of the home.
function localLimit(max, cap) {
  const requested = Number.isInteger(max) && max > 0 ? max : cap;
  return Math.max(1, Math.min(requested, cap));
}

// Claims and runs jobs until the queue refuses another one, respecting the ceiling inside and across processes.
export async function runCycle({ jobId = null, max = null, dry = false, env = process.env, deps = {} } = {}) {
  const cap = concurrencyCap(env);
  if (dry) return await dryReport({ jobId, cap, env });
  await warnRepairRefused(env);
  const ctx = { env, store: openStore(env), deps: withDefaults(deps, env), state: { stopping: false } };
  await ctx.deps.refreshMergedImpl({ env });
  const uninstall = installShutdown(ctx.state);
  const limit = localLimit(max, cap);
  const runtime = ownRuntimeDir(env);
  const processed = [];
  const pool = new Set();
  const seen = new Set();
  const blocked = new Set();
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
      const limited = await waitOutRateLimitPause(jobId, ctx);
      if (limited !== null) {
        reason = limited;
        break;
      }
      const claimed = await acquire({ jobId, cap, env });
      if (!claimed.job) {
        reason = claimed.reason;
        break;
      }
      if (seen.has(claimed.job.id)) {
        await release(claimed.job, null, env);
        await Promise.allSettled([...pool]);
        // A job released by a preflight block (dirty checkout, missing binary) stays pending on purpose: the operator fixes the
        // cause and the drain must be there to pick it up, so this pass ends as `blocked`, which the drain waits on.
        reason = blocked.has(claimed.job.id) ? "blocked" : "already-tried";
        break;
      }
      seen.add(claimed.job.id);
      reason = "claimed";
      const task = runJob(claimed.job, ctx)
        .catch((err) => ({ id: claimed.job.id, status: "error", error: err?.message ?? String(err) }))
        .then((result) => {
          if (result.status === "blocked") blocked.add(result.id);
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
// Reasons the drain keeps waiting on: the pending job is held back by something the operator, another runner or the provider will clear.
const DRAIN_WAIT_REASONS = new Set(["blocked", "cap-reached", "rate-limited"]);

// Runs cycles until the queue has nothing pending, waiting between passes while the pending jobs are held back by a preflight block or the concurrency cap - what "run the queue" means to an operator.
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
      if (!DRAIN_WAIT_REASONS.has(pass.reason) && pass.reason !== "claimed") break;
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
