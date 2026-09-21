import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, logsDir, runDir } from "../config/paths.mjs";
import { ensureHome } from "../config/store.mjs";
import { ghPrList } from "../host/gh.mjs";
import { packageRoot, spawnRoot } from "../host/paths.mjs";
import { sqliteToIso } from "../memory/schema.mjs";
import { openStore, openStoreReadOnly } from "../store/open.mjs";
import { acquire, bashTimeoutS, concurrencyCap, isPaused, leaseHeartbeatMs, release, renew, resumeSessionEnabled, stillOwned } from "./claim.mjs";
import { backoffMs, classifyJobResult, isTerminalRuntimeKill, isTransientFailure } from "./classify.mjs";
import { preflight } from "./preflight.mjs";
import {
  clearOwnPause,
  fiveHourReading,
  inheritablePause,
  ownPauseUntilMs,
  PAUSE_POLL_MS,
  pauseFromEvent,
  pauseUntilMs,
  readOwnPause,
  recordOwnFiveHour,
  recordOwnPause,
  resumeRequestedAt,
} from "./rate-limit.mjs";
import { holdRunnerAwake } from "./keep-awake.mjs";
import { killProcess, ownRunnerRecord } from "./registry.mjs";
import { runMaintenance } from "./maintenance.mjs";
import { clearRunOutcome, decideResume, isSafeSegment, readRunState, renameRunDir, resumeHandoff, writeRunTerminal } from "./resume.mjs";
import { recordPrUrl, recordResume, recordRunFields } from "./run-state.mjs";
import { buildPrompt, IDLE_TIMEOUT_S, provisionalSlug, spawnClaude } from "./spawn.mjs";
import {
  extractHostCommandCounts,
  extractRateLimitFromEventLine,
  extractSessionIdFromEventLine,
  extractSlugFromEventLine,
  extractSlugTypeFromEventLine,
  extractTierRaiseFromEventLine,
  extractUsage,
  isPrUrl,
  sawDisabledBackgroundTask,
  sumHostCommandCounts,
  sumUsage,
} from "./stream.mjs";
import { phaseTelemetry, runDurationS } from "./telemetry.mjs";
import { resolveWindow, windowPhase } from "./window.mjs";
import { finishNotice, inspectRunWorktree, keptWorktreeLine, removeRunWorktree } from "./worktree.mjs";

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
  nowImpl: Date.now,
  gitImpl: undefined,
  existsImpl: undefined,
  resolveBinImpl: undefined,
  stopSignalImpl: null,
  pauseSignalImpl: null,
  idleTimeoutS: IDLE_TIMEOUT_S,
  maintenanceImpl: runMaintenance,
  prListImpl: ghPrList,
  finishJobImpl: null,
  killImpl: null,
  keepAwakeImpl: holdRunnerAwake,
  holdJobAwakeImpl: undefined,
};

// Bounds of the key the pre-spawn pull request check searches for.
const PR_SEARCH_WORDS = 6;
const PR_SEARCH_MAX_CHARS = 80;

// Merges the injected seams over the real implementations; the ownership poll is the configured heartbeat.
function withDefaults(deps, env) {
  const merged = { ...DEFAULT_DEPS, stopPollMs: leaseHeartbeatMs(env), bashTimeoutS: bashTimeoutS(env) };
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

// Moves the run of this job onto the slug the pipeline declared; a name another run already took is refused, and the job keeps the slug the runtime gave it.
async function adoptSlug(job, facts, slug, { store, env }) {
  if (slug === facts.slug) return;
  const renamed = renameRunDir({ project: job.project, from: facts.slug, to: slug, env });
  if (renamed.status === "kept") {
    appendJobLog(job.id, `the run keeps the slug \`${facts.slug}\`: it could not be renamed to \`${slug}\` (${renamed.reason})`, env);
    return;
  }
  facts.slug = slug;
  const branch = readRunState({ project: job.project, slug, env })?.branch ?? null;
  await store.jobs.persistRunFacts(job.id, { worker: job.worker, slug, branch });
}

// Records the task type the pipeline declared with its slug; a state that refuses the write is said out loud and never costs the run.
function persistRunType(job, type, slug, env) {
  const written = recordRunFields({ project: job.project, slug, fields: { type }, env });
  if (written.status !== "written") appendJobLog(job.id, `the task type could not be recorded in the state of the run: ${written.reason}`, env);
}

// Applies the ONE `SLUG: <slug> TYPE: <type>` declaration the pipeline is allowed to make: the first one renames the run, every later one is ignored.
async function captureSlugOverride(job, facts, line, ctx) {
  if (facts.slugDeclared) return;
  const declared = extractSlugTypeFromEventLine(line);
  if (!declared || !isSafeSegment(declared.slug) || !isSafeSegment(facts.slug)) return;
  facts.slugDeclared = true;
  await adoptSlug(job, facts, declared.slug, ctx);
  if (declared.type) persistRunType(job, declared.type, facts.slug, ctx.env);
}

// Records the tier a raise announced in the Brief moved the run to, with the evidence that justified it; a state that refuses the write is said out loud and never costs the run.
function persistTierRaise(job, raise, slug, env) {
  const written = recordRunFields({ project: job.project, slug, fields: { tier: raise.to, tierRaiseReason: raise.reason }, env });
  if (written.status !== "written") appendJobLog(job.id, `the tier raise could not be recorded in the state of the run: ${written.reason}`, env);
}

// Records the tier raise the orchestrator announced; the Brief is written before the run has a slug, so a raise waits in the facts until there is a state.json to record it into.
function captureTierRaise(job, facts, line, { env }) {
  facts.tierRaise = extractTierRaiseFromEventLine(line) ?? facts.tierRaise;
  if (!facts.tierRaise || !isSafeSegment(facts.slug)) return;
  const raise = facts.tierRaise;
  facts.tierRaise = null;
  persistTierRaise(job, raise, facts.slug, env);
}

// The accumulated log of a job as it is on disk: the only reading that carries the attempt markers the telemetry is measured from; a log that cannot be read measures nothing.
function readJobLog(jobId, env) {
  try {
    return readFileSync(jobLogPath(jobId, env), "utf8");
  } catch {
    return "";
  }
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

// Records in the registration of THIS runner the five-hour reading the stream reported, once per new value; a record that refuses the write never costs the run.
async function noteFiveHour(facts, info, env) {
  const reading = fiveHourReading(info);
  if (!reading || (facts.fiveHour?.utilization === reading.utilization && facts.fiveHour?.resetsAt === reading.resetsAt)) return;
  facts.fiveHour = reading;
  try {
    await recordOwnFiveHour(reading, env);
  } catch {
    return;
  }
}

// Records the rate limit the stream reported and arms a pause when the event calls for one; a further pause always replaces a nearer one.
async function captureRateLimit(job, facts, line, { env }) {
  const info = extractRateLimitFromEventLine(line);
  if (!info) return;
  facts.rateLimit = info;
  await noteFiveHour(facts, info, env);
  const pause = pauseFromEvent(info);
  if (!pause || (facts.pause && facts.pause.pausedUntil >= pause.pausedUntil)) return;
  facts.pause = pause;
  await armPause(job, pause, env);
}

// Records the first session id of the job (never overwritten) and, whenever the stream reveals a session id different
// from the last one recorded, the session and attempt of the run's latest attempt: once per attempt, so `queue session`
// always resumes the one the operator is actually waiting on.
async function captureSession(job, facts, line, attempt, { store }) {
  const sessionId = extractSessionIdFromEventLine(line);
  if (!sessionId || sessionId === facts.lastSessionId) return;
  const isFirst = !facts.sessionId;
  if (isFirst) facts.sessionId = sessionId;
  facts.lastSessionId = sessionId;
  await store.jobs.persistRunFacts(job.id, {
    worker: job.worker,
    sessionId: isFirst ? sessionId : null,
    lastSessionId: sessionId,
    lastSessionAttempt: attempt,
  });
}

// Records the run facts that appear in the stream, writing one fact per line of the stream at most.
async function captureFacts(job, facts, line, attempt, ctx) {
  await captureSlug(job, facts, line, ctx);
  await captureSlugOverride(job, facts, line, ctx);
  captureTierRaise(job, facts, line, ctx);
  await captureRateLimit(job, facts, line, ctx);
  await captureSession(job, facts, line, attempt, ctx);
}

// Delivers one line of the stream to the fact capture, which is never allowed to bring the run down - the same guarantee the spawn gives a synchronous consumer.
function captureLine(job, facts, line, attempt, ctx) {
  captureFacts(job, facts, line, attempt, ctx).catch(() => {});
}

// Records in the job log that this runner lost the job; it is the ONLY write allowed once ownership is gone.
function noteOwnershipLost(job, env) {
  try {
    appendFileSync(jobLogPath(job.id, env), `=== ownership lost @ ${new Date().toISOString()} ===\n`);
  } catch {
    return;
  }
}

// Tells whether a failed attempt deserves another one: only a transient failure, never a timeout nor a kill that ended the run.
// A kill that did not end the run (the run's own record settled it) never blocks a retry any differently than a run without one.
function isRetryable(job, attempt, result, outcome, state) {
  if (outcome.status !== "failed" || result.timedOut || result.idleTimedOut) return false;
  if (isTerminalRuntimeKill(result.log, state)) return false;
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
  const facts = {
    slug: job.slug ?? null,
    slugDeclared: false,
    sessionId: job.session_id ?? null,
    lastSessionId: job.last_session_id ?? job.session_id ?? null,
    rateLimit: null,
    fiveHour: null,
    pause: null,
    tierRaise: null,
  };
  const pauseSignalImpl = deps.pauseSignalImpl ?? (() => ownPauseUntilMs(env) ?? pauseUntilMs(facts.pause));
  const resumeForced = resumeSessionEnabled(env) || wasRateLimitParked(job);
  const ownership = { lost: false };
  const usages = [];
  const hostCommandCounts = [];
  let attempt = job.attempts;
  while (true) {
    if (!(await renew(job, env)))
      return { lost: true, facts, attempt, usage: sumUsage(usages), hostCommands: sumHostCommandCounts(hostCommandCounts), outcome: null, result: null };
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
      onLine: (line) => captureLine(job, facts, line, attempt, ctx),
      stopSignalImpl: () => shouldStop(job, ctx, ownership),
      pauseSignalImpl,
      stopPollMs: deps.stopPollMs,
      resumeSessionId: resumeForced ? facts.sessionId : null,
      resolveBinImpl: deps.resolveBinImpl,
      holdJobAwakeImpl: deps.holdJobAwakeImpl,
      bashTimeoutS: deps.bashTimeoutS,
    });
    if (ownership.lost)
      return { lost: true, facts, attempt, usage: sumUsage(usages), hostCommands: sumHostCommandCounts(hostCommandCounts), outcome: null, result };
    usages.push(extractUsage(result.log));
    hostCommandCounts.push(extractHostCommandCounts(result.log));
    const hostCommands = sumHostCommandCounts(hostCommandCounts);
    const notBefore = rateLimitExit(result, facts);
    if (notBefore) return { lost: false, parked: { notBefore }, facts, attempt, usage: sumUsage(usages), hostCommands, outcome: null, result };
    const planPath = isSafeSegment(facts.slug) ? join(runDir(job.project, facts.slug, env), "03-plan.md") : null;
    const state = readRunState({ project: job.project, slug: facts.slug, env });
    const outcome = classifyJobResult({ ...result, state, planPath });
    if (!isRetryable(job, attempt, result, outcome, state)) {
      return { lost: false, facts, attempt, usage: sumUsage(usages), hostCommands, outcome, result };
    }
    await deps.sleepImpl(backoffMs(attempt));
    if (!(await ctx.store.jobs.countAttempt(job.id, { worker: job.worker }))) {
      return { lost: true, facts, attempt, usage: sumUsage(usages), hostCommands, outcome, result };
    }
    attempt += 1;
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

// Records in the state of the run the pull request the runtime read from the run; the record is the runtime's, and a state that already carries one is left alone.
function persistPrUrl(job, run, state, env) {
  const prUrl = run.outcome?.prUrl ?? null;
  if (!prUrl || isPrUrl(state?.outcome?.prUrl) || !isSafeSegment(run.facts.slug)) return;
  const written = recordPrUrl({ project: job.project, slug: run.facts.slug, prUrl, env });
  if (written.status !== "written") appendJobLog(job.id, `the pull request could not be recorded in the state of the run: ${written.reason}`, env);
}

// Fills the telemetry row the agent recorded with what the runtime MEASURED in the stream: the measured durations and models win,
// the agent's survive only where the runtime observed none, and a run with no row of its own is left alone instead of being invented.
async function persistTelemetry(job, run, { store, env }) {
  if (!isSafeSegment(run.facts.slug)) return;
  const log = readJobLog(job.id, env);
  try {
    await store.runs.updateRunTelemetry({ project: job.project, slug: run.facts.slug, durationS: runDurationS(log), phases: phaseTelemetry(log) });
  } catch (err) {
    appendJobLog(job.id, `the telemetry of the run could not be updated: ${err?.message ?? String(err)}`, env);
  }
}

// Inspects the worktree the run recorded, read-only, before the finish, so a kept one can be named in the single notice write.
async function inspectJobWorktree(run, state, ctx) {
  return await inspectRunWorktree({
    checkout: ctx.checkout,
    path: state?.worktree,
    prRecorded: isPrUrl(run.outcome.prUrl) || isPrUrl(state?.outcome?.prUrl),
    env: ctx.env,
    killImpl: ctx.deps.killImpl ?? killProcess,
  });
}

// The line appended once when the last attempt shows the host backgrounding a task despite the disable env var the runtime sets.
const DISABLED_BACKGROUND_ESCAPE_LINE =
  "⚠️ the host moved a command to the background although background tasks are disabled - the CLI may have dropped CLAUDE_CODE_DISABLE_BACKGROUND_TASKS";

// Appends the disabled-background escape line once when the last attempt shows one, mirroring it to the runner's own log.
function withDisabledBackgroundEscape(noticeMd, log) {
  if (!sawDisabledBackgroundTask(log)) return noticeMd;
  process.stderr.write(`${DISABLED_BACKGROUND_ESCAPE_LINE}\n`);
  return noticeMd ? `${noticeMd}\n\n${DISABLED_BACKGROUND_ESCAPE_LINE}` : DISABLED_BACKGROUND_ESCAPE_LINE;
}

// The outcome the finish writes: the run's own, with the kept-worktree line and the disabled-background escape appended to whatever notice exists; both lines also go to their own log.
function outcomeWithWorktree(job, run, worktree, env) {
  if (worktree && !worktree.removable) appendJobLog(job.id, keptWorktreeLine(worktree), env);
  const noticeMd = finishNotice({ runNotice: run.outcome.noticeMd, rowNotice: job.notice_md, worktree });
  return { ...run.outcome, noticeMd: withDisabledBackgroundEscape(noticeMd, run.result.log) };
}

// Removes the worktree of a job that ended `done`; a refusal is written to the job log and stderr, and never costs the job.
async function dropRunWorktree(job, worktree, { env, checkout }) {
  const removed = await removeRunWorktree({ checkout, path: worktree.path, staleLock: worktree.staleLock, env });
  if (removed.ok) {
    appendJobLog(job.id, `worktree removed: ${worktree.path}`, env);
    return;
  }
  const line = `the worktree ${worktree.path} was kept: ${removed.reason}`;
  appendJobLog(job.id, line, env);
  process.stderr.write(`job #${job.id}: ${line}\n`);
}

// Writes the outcome of a finished job, together with the branch the pipeline registered in its state.
async function finalize(job, run, ctx) {
  const { env, store } = ctx;
  const finishJobImpl = ctx.deps.finishJobImpl ?? ((id, outcome) => store.jobs.finishJob(id, outcome));
  const state = readRunState({ project: job.project, slug: run.facts.slug, env });
  persistPrUrl(job, run, state, env);
  await persistTelemetry(job, run, ctx);
  if (state?.branch) await store.jobs.persistRunFacts(job.id, { worker: job.worker, branch: state.branch });
  const worktree = await inspectJobWorktree(run, state, ctx);
  const outcome = outcomeWithWorktree(job, run, worktree, env);
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
          noticeMd: outcome.noticeMd,
          usage: run.usage,
          hostCommands: run.hostCommands,
        },
        env,
      ),
  }, env);
  // The witness is written when the row took the finish AND when the database refused the commit - the second case is exactly
  // what the reconciliation repairs from. A finish that returned false means the row is no longer ours (another worker owns
  // it): no witness then, or the reconciliation would close a job someone else is still running.
  if (finish.written || finish.error) await writeWitness(job, outcome, ctx);
  if (finish.written) await store.checkpoint();
  if (finish.written && run.outcome.status === "done" && worktree?.removable) await dropRunWorktree(job, worktree, ctx);
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

// Counts this resume in the state of the run, so the cap bites on the next retry; a state that refuses the write is said out loud and never costs the run.
function persistResume(job, resumeCount, env) {
  const written = recordResume({ project: job.project, slug: job.slug, resumeCount, env });
  if (written.status !== "written") appendJobLog(job.id, `the resume could not be counted in the state of the run: ${written.reason}`, env);
}

// The job with the run it writes into already named: the slug of its row, or a provisional one derived from its prompt and
// persisted before the spawn, so the run directory exists from the first attempt and a retry finds it again.
async function withRunSlug(job, { store, env }) {
  if (isSafeSegment(job.slug)) return job;
  const slug = provisionalSlug(job);
  if (!(await store.jobs.persistRunFacts(job.id, { worker: job.worker, slug }))) {
    appendJobLog(job.id, `the provisional slug \`${slug}\` could not be persisted on the row of the job`, env);
  }
  return { ...job, slug };
}

// Search key of a job: its slug once it has one, and otherwise the first significant words of its prompt, with no punctuation gh could read as syntax.
export function prSearchKey(job) {
  const slug = typeof job?.slug === "string" ? job.slug.trim() : "";
  if (slug) return slug.slice(0, PR_SEARCH_MAX_CHARS);
  const words = String(job?.prompt ?? "")
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  return (words ?? []).slice(0, PR_SEARCH_WORDS).join(" ").slice(0, PR_SEARCH_MAX_CHARS);
}

// Open pull requests to attach to the prompt of this job: disabled by NIGHTSHIFT_NO_PR_CHECK with no subprocess at all, and
// undetermined whenever gh could not answer. The lookup is awaited, never run synchronously: it is the only network call of a
// run, and a blocking one here would stall the dispatch loop and the I/O of every job already in flight.
export async function openPrsForJob(job, { env = process.env, deps = {} } = {}) {
  if (env?.NIGHTSHIFT_NO_PR_CHECK === "1") return undefined;
  const key = prSearchKey(job);
  if (!key) return undefined;
  const lookup = typeof deps.prListImpl === "function" ? deps.prListImpl : ghPrList;
  try {
    const found = await lookup(key, { env });
    return Array.isArray(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

// Runs one claimed job end to end: preflight, attempts and the single write of the outcome.
async function runJob(claimed, ctx) {
  const { env, deps } = ctx;
  const check = preflight({ job: claimed, env, gitImpl: deps.gitImpl, existsImpl: deps.existsImpl, resolveBinImpl: deps.resolveBinImpl });
  if (!check.ok) {
    await release(claimed, { blocked: { code: check.code, message: check.message } }, env, check.code);
    return { id: claimed.id, status: "blocked", code: check.code };
  }
  const openPrs = await openPrsForJob(claimed, { env, deps });
  const job = await withRunSlug(claimed, ctx);
  const state = readRunState({ project: job.project, slug: job.slug, env });
  const resume = decideResume({ state });
  const handoff = resumeHandoff({ job, resume, state, env });
  if (handoff) persistResume(job, resume.resumeCount, env);
  const prompt = buildPrompt({ job, handoff, openPrs, env });
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
  return await finalize(job, run, { ...ctx, checkout: check.cwd });
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
async function dryReport({ jobId, cap, max, env }) {
  const store = openStore(env);
  return {
    dry: true,
    paused: isPaused(env),
    ...dryRateLimit(env),
    cap,
    max,
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
// means stop now and the cycle must end on it. A window's `until` cuts the wait short: the reset is not worth waiting
// for once the runner is about to stop claiming anyway. Returns the reason the cycle ends with, or null when the runner may claim.
async function waitOutRateLimitPause(jobId, ctx, window = null) {
  const { env, deps, state } = ctx;
  let waited = false;
  while (!state.stopping) {
    if (jobId === null && isPaused(env)) return null;
    const until = await pauseGate(env);
    if (until === null) return null;
    const now = deps.nowImpl();
    if (window && now >= window.untilMs) return null;
    waited = true;
    const sliceMs = Math.min(Math.max(1, until - now), PAUSE_POLL_MS);
    await waitNextPass(window ? Math.min(sliceMs, Math.max(1, window.untilMs - now)) : sliceMs, state, deps.sleepImpl);
  }
  return waited ? "rate-limited" : null;
}

// Waits, in slices, for a window's `from` to arrive before this runner claims anything; a shutdown signal ends the
// wait early, the same way it ends the rate-limit wait. Returns `outside-window` when the runner stopped before the
// window opened, or null once it may proceed - which happens at once when the window is already open.
async function waitOutWindowOpen(window, ctx) {
  const { deps, state } = ctx;
  let waited = false;
  while (!state.stopping) {
    const now = deps.nowImpl();
    if (now >= window.fromMs) return null;
    waited = true;
    await waitNextPass(Math.min(window.fromMs - now, PAUSE_POLL_MS), state, deps.sleepImpl);
  }
  return waited ? "outside-window" : null;
}

// Tells whether a window's `until` has already arrived; carries the count of jobs still pending, the one `printCycle`
// turns into the closing line of the runner log.
async function windowClosedCheck(window, ctx) {
  if (windowPhase({ fromMs: window.fromMs, untilMs: window.untilMs, nowMs: ctx.deps.nowImpl() }) !== "after") return null;
  const counts = await ctx.store.jobs.countsByStatus();
  return { windowClosedAt: window.untilMs, pending: counts.pending ?? 0 };
}

// A runner works one job at a time; simultaneity comes from starting several runners, never from one.
const RUNNER_POOL_SIZE = 1;

// Counts the results that reached the agent; a job the preflight released refunded its attempt and spends no budget.
export function agentRuns(results) {
  return results.filter((result) => result.status !== "blocked").length;
}

// Tells whether this run already ran every job its --max budget allows; a run with no budget never spends it.
function budgetSpent(max, results) {
  return Number.isInteger(max) && max > 0 && agentRuns(results) >= max;
}

// What is left of the --max budget of this run after the passes already made, or null when the run has no budget.
function remainingBudget(max, passes) {
  if (!Number.isInteger(max) || max <= 0) return null;
  return max - passes.reduce((total, pass) => total + agentRuns(pass.processed), 0);
}

// Claims and runs jobs one after the other until the queue refuses another one or the --max budget is spent, respecting the ceiling across processes.
// A `window` bounds the claiming to `[fromMs, untilMs)`: nothing is claimed before it opens or after it closes, but a
// job already running when it closes always finishes - the window never kills or shortens a job's own timeout.
export async function runCycle({ jobId = null, max = null, dry = false, env = process.env, deps = {}, window = null, keepAwake = true } = {}) {
  await openStoreReadOnly(env).migrateIfOutdated();
  const cap = concurrencyCap(env);
  if (dry) return await dryReport({ jobId, cap, max, env });
  const ctx = { env, store: openStore(env), deps: withDefaults(deps, env), state: { stopping: false } };
  if (keepAwake) ctx.deps.keepAwakeImpl({ pid: process.pid, env });
  const upkeep = await ctx.deps.maintenanceImpl({ env });
  if (upkeep?.warning) process.stderr.write(`warning: ${upkeep.warning}\n`);
  const uninstall = installShutdown(ctx.state);
  const runtime = ownRuntimeDir(env);
  const processed = [];
  const pool = new Set();
  const seen = new Set();
  const blocked = new Set();
  let reason = "empty-queue";
  let windowClosed = null;
  try {
    while (!ctx.state.stopping) {
      if (!existsSync(runtime)) {
        reason = "runtime-gone";
        warnRuntimeGone(runtime);
        break;
      }
      if (pool.size >= RUNNER_POOL_SIZE) {
        await Promise.race(pool);
        continue;
      }
      if (window) {
        const opened = await waitOutWindowOpen(window, ctx);
        if (opened !== null) {
          reason = opened;
          break;
        }
        windowClosed = await windowClosedCheck(window, ctx);
        if (windowClosed) {
          reason = "window-closed";
          break;
        }
      }
      if (budgetSpent(max, processed)) {
        reason = "max-reached";
        break;
      }
      const limited = await waitOutRateLimitPause(jobId, ctx, window);
      if (limited !== null) {
        reason = limited;
        break;
      }
      if (window) {
        windowClosed = await windowClosedCheck(window, ctx);
        if (windowClosed) {
          reason = "window-closed";
          break;
        }
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
  return { processed, reason, cap, stopped: ctx.state.stopping, ...(windowClosed ?? {}) };
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

// Repeats the cycle while the runner lives, sleeping between two passes over the queue, until its --max budget is spent
// or, when `until` names a window, until it closes. `from`/`until` are resolved into absolute instants exactly once,
// at the start of the watch, and that same window is handed to every pass for the rest of its life.
export async function runWatch({
  intervalS = WATCH_INTERVAL_DEFAULT_S,
  jobId = null,
  max = null,
  env = process.env,
  deps = {},
  cycles = null,
  onCycle = () => {},
  from = null,
  until = null,
} = {}) {
  const options = withDefaults(deps, env);
  options.keepAwakeImpl({ pid: process.pid, env });
  const window = until === null ? null : resolveWindow({ from, until, nowMs: options.nowImpl() });
  const state = { stopping: false };
  const uninstall = installShutdown(state);
  const passes = [];
  try {
    while (!state.stopping && (cycles === null || passes.length < cycles)) {
      const budget = remainingBudget(max, passes);
      if (budget !== null && budget <= 0) break;
      const pass = await runCycle({ jobId, max: budget, env, deps: options, window, keepAwake: false });
      passes.push(pass);
      onCycle(pass);
      if (
        state.stopping ||
        pass.reason === "runtime-gone" ||
        pass.reason === "max-reached" ||
        pass.reason === "window-closed" ||
        (cycles !== null && passes.length >= cycles)
      )
        break;
      await waitNextPass(Math.max(1, Number(intervalS) || WATCH_INTERVAL_DEFAULT_S) * 1000, state, options.sleepImpl);
    }
  } finally {
    uninstall();
  }
  return passes;
}

export const DRAIN_INTERVAL_S = 15;

// Reasons of a cycle after which a drain has nothing left to do: the queue is empty, paused, the cycle was told to stop, the --max budget is spent, or the tree it runs from is gone.
const DRAIN_DONE_REASONS = new Set(["empty-queue", "paused", "already-tried", "runtime-gone", "max-reached"]);
// Reasons the drain keeps waiting on: the pending job is held back by something the operator, another runner or the provider will clear.
const DRAIN_WAIT_REASONS = new Set(["blocked", "cap-reached", "rate-limited"]);

// Runs cycles until the queue has nothing pending or the --max budget is spent (a job the preflight releases spends none), waiting between passes while the pending jobs are held back by a preflight block or the concurrency cap - what "run the queue" means to an operator.
export async function runDrain({ max = null, intervalS = DRAIN_INTERVAL_S, env = process.env, deps = {}, cycles = null, onCycle = () => {} } = {}) {
  const options = withDefaults(deps, env);
  options.keepAwakeImpl({ pid: process.pid, env });
  const state = { stopping: false };
  const uninstall = installShutdown(state);
  const passes = [];
  try {
    while (!state.stopping && (cycles === null || passes.length < cycles)) {
      const budget = remainingBudget(max, passes);
      if (budget !== null && budget <= 0) break;
      const pass = await runCycle({ max: budget, env, deps: options, keepAwake: false });
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

// Arguments of the detached child: `--foreground` is what makes it run the queue instead of detaching again; the
// child parses `--from`/`--until` itself, so they travel unchanged. The entry point is the CURRENT installed
// runtime, never this process's own tree, so a long-lived caller can never hand the child a superseded one.
function detachedArgs({ jobId, max, watchIntervalS, from = null, until = null, runtimeDir }) {
  return [
    join(runtimeDir, "bin", "nightshift.mjs"),
    "queue",
    "run",
    "--foreground",
    ...(jobId === null ? [] : ["--job", String(jobId)]),
    ...(max === null ? [] : ["--max", String(max)]),
    ...(watchIntervalS === null ? [] : ["--watch", String(watchIntervalS)]),
    ...(from === null ? [] : ["--from", from]),
    ...(until === null ? [] : ["--until", until]),
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
function spawnRunner({ args, fd, logPath, runtimeDir, env, spawnImpl }) {
  const child = spawnImpl(process.execPath, args, { detached: true, stdio: ["ignore", fd, fd], env: { ...env } });
  child?.on?.("error", (err) => recordSpawnFailure(logPath, err));
  child?.unref?.();
  return { pid: child?.pid ?? null, logPath, runtimeDir };
}

// Starts `nightshift queue run` detached, with its output going to a log file, and returns right away; the
// `runtimeDir` it answers with is the same tree the child's argv points into, so the caller registers what the
// child really loads instead of guessing it a second time.
export function launchDetachedRunner({ jobId = null, max = null, watchIntervalS = null, from = null, until = null, env = process.env, spawnImpl = spawn } = {}) {
  ensureHome(env);
  const logPath = join(logsDir(env), `runner-${compactStamp()}.log`);
  const runtimeDir = spawnRoot(env);
  try {
    mkdirSync(logsDir(env), { recursive: true });
    const fd = openSync(logPath, "a");
    const args = detachedArgs({ jobId, max, watchIntervalS, from, until, runtimeDir });
    try {
      return spawnRunner({ args, fd, logPath, runtimeDir, env, spawnImpl });
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    throw new UserError(`could not start the detached runner: ${err?.message ?? String(err)}`);
  }
}
