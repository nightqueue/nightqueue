import { StoreUnavailableError } from "../config/errors.mjs";
import { callerJobId } from "../config/job-home.mjs";
import { openStore } from "../store/open.mjs";
import { appendPendingWrite, PENDING_KEYS } from "./pending-writes.mjs";
import { isStateObject } from "./resume.mjs";

export const OK_VERDICTS = new Set(["PROCEED", "APPROVED", "PASSED", "CONFIRMED", "DONE", "OK"]);
export const FAILED_VERDICT = /^(NEEDS|FAILED|NOT-|NOT |SYMPTOM-PERSISTS)/;

const GATE_OF = Object.freeze({ triage: "triage", architecture: "architect", qa: "qa", verification: "verification", runtime: "runtime" });

// The verdict word a phase recorded, without a heading prefix such as `## Verification:`.
export function verdictWord(verdict) {
  const text = typeof verdict === "string" ? verdict.trim() : "";
  if (!text) return "OK";
  return text.replace(/^#+\s*/, "").split(":").pop().trim().toUpperCase();
}

// The status icon a recorded verdict earns: ✅ a clean pass, ❌ a failure, ⚠️ anything the report cannot call clean.
export function verdictIcon(verdict) {
  const word = verdictWord(verdict);
  if (OK_VERDICTS.has(word)) return "✅";
  return FAILED_VERDICT.test(word) ? "❌" : "⚠️";
}

// The recorded phase entries of a run's state.json, an empty list when it holds none.
function stateEntries(state) {
  return isStateObject(state) && Array.isArray(state.phases) ? state.phases.filter(isStateObject) : [];
}

// A recorded text trimmed, or null when there is nothing to store.
function textOrNull(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

// The `pipeline_phases` rows of a run, one per phase its state.json recorded: a failing verdict is `failed` and a phase seen before is a re-run.
export function statePipelinePhases(state) {
  const seen = new Set();
  return stateEntries(state)
    .filter((entry) => textOrNull(entry.phase) !== null)
    .map((entry) => {
      const phase = entry.phase.trim();
      const retry = seen.has(phase);
      seen.add(phase);
      return { phase, status: verdictIcon(entry.verdict) === "❌" ? "failed" : "ok", retry, note: textOrNull(entry.note), reason: textOrNull(entry.reason) };
    });
}

// The outcome of a run, derived from what its state.json recorded: a pull request, a commit, or neither.
export function derivedOutcome(state) {
  const outcome = isStateObject(state?.outcome) ? state.outcome : {};
  if (outcome.status === "done" && typeof outcome.prUrl === "string" && outcome.prUrl.trim() !== "") return "pr_opened";
  if (outcome.status === "done" || stateEntries(state).some((entry) => entry.phase === "commit")) return "local_commit";
  return "no_commit";
}

// Whether the run concluded on purpose that no code change is needed, by its recorded outcome or its triage termination.
function noChangeRun(state) {
  if (isStateObject(state?.outcome) && state.outcome.status === "no_change") return true;
  return isStateObject(state?.termination) && textOrNull(state.termination.reason) === "NO-CHANGE-NEEDED";
}

// The gate a run without a commit stopped at: the user's pause, the terminated phase, else the last failing phase; null when none applies.
export function derivedGateStop(state, outcome) {
  if (outcome !== "no_commit") return null;
  if (noChangeRun(state)) return null;
  if (isStateObject(state?.outcome) && state.outcome.status === "gate") return "user";
  const terminated = isStateObject(state?.termination) ? GATE_OF[state.termination.phase] : undefined;
  if (terminated) return terminated;
  const failed = stateEntries(state).filter((entry) => verdictIcon(entry.verdict) === "❌").at(-1);
  return GATE_OF[failed?.phase] ?? null;
}

// Queues a pipeline run the unavailable database refused into the run's pending-writes file, fully resolved, and answers ok with the warning;
// any other failure, or a run it cannot be queued into, is raised as it came.
function queuedPipelineLog(err, spec, env) {
  if (!(err instanceof StoreUnavailableError)) throw err;
  const at = new Date().toISOString();
  const payload = { ...spec, model: env?.NIGHTQUEUE_MODEL ?? null, sessionId: env?.NIGHTQUEUE_SESSION_ID ?? null };
  const entry = { key: PENDING_KEYS.pipelineLog(spec.projectId, spec.slug, at), kind: "pipeline_log", at, jobId: callerJobId(env), payload };
  const queued = appendPendingWrite({ projectId: spec.projectId, slug: spec.slug, entry, env });
  if (queued.status !== "queued") throw err;
  return { ok: true, queued: true, warning: `recorded in ${queued.path}; replayed once the database is back`, pending: queued.path };
}

// Writes the telemetry of one run: every call when `always`, once since `since` when given, else unless the latest record has the same facts; an unavailable database queues it.
export async function recordPipelineRun({ spec, since, always = false }, env = process.env) {
  try {
    const runs = openStore(env).runs;
    if (always) return await runs.logPipelineRun(spec);
    const origin = { model: env?.NIGHTQUEUE_MODEL ?? null, sessionId: env?.NIGHTQUEUE_SESSION_ID ?? null };
    if (since) return await runs.logPipelineRunOnce({ ...spec, ...origin }, { since });
    return await runs.logPipelineRunUnlessSame({ ...spec, ...origin });
  } catch (err) {
    return queuedPipelineLog(err, spec, env);
  }
}

// The instant the job's current attempt started, so a run is recorded once per attempt; null outside a job or when the row cannot be read.
export async function attemptSince(jobId, env = process.env) {
  if (jobId === null || jobId === undefined) return null;
  try {
    const job = await openStore(env).jobs.getJob(jobId);
    return textOrNull(job?.attempt_started_at);
  } catch {
    return null;
  }
}
