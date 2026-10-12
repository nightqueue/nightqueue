import { measuredByPhase, phaseRows, readJobLog } from "../cli/run-context.mjs";
import { callerJobId } from "../config/job-home.mjs";
import { openStore } from "../store/open.mjs";

const TIMELINE_LIMIT = 60;
const NONE = "none recorded";
const FALLBACK_ITEM = "the run timeline comes from state.json: `pipeline_log` recorded no run for this attempt";

// The instant this job's attempt started, so a previous attempt's run never speaks for this one; null outside a job.
async function attemptStart(jobId, env) {
  if (jobId === null) return null;
  const job = await openStore(env).jobs.getJob(jobId);
  return job?.attempt_started_at ?? null;
}

// The phases `pipeline_log` recorded for this attempt, each with the lane model the runtime measured when the row has none.
function recordedPhases(rows, log) {
  const measured = measuredByPhase(log);
  return rows.map((row) => {
    const lane = measured.get(row.phase)?.shift() ?? null;
    return { phase: row.phase, model: row.model ?? lane?.model ?? null, status: row.status, retry: row.retry, reason: row.reason };
  });
}

// The phases state.json recorded, for an attempt `pipeline_log` never recorded: a phase seen before is a re-run.
function statePhases(state, log) {
  const entries = Array.isArray(state?.phases) ? state.phases : [];
  const seen = new Set();
  return phaseRows(state ?? {}, log).map((row, index) => {
    const retry = seen.has(row.phase);
    seen.add(row.phase);
    const reason = typeof entries[index]?.reason === "string" ? entries[index].reason.trim() : "";
    return { ...row, retry, reason: reason || null };
  });
}

// Why one phase ran: the recorded reason, a re-run with none, or its first run.
function reasonCell(phase) {
  if (phase.reason) return phase.reason;
  return phase.retry ? "re-run (no reason recorded)" : "first run";
}

// The numbered timeline lines, capped so a runaway loop cannot flood the prompt.
function timelineText(phases) {
  if (phases.length === 0) return NONE;
  const lines = phases.map((phase, index) => `${index + 1}. ${phase.phase} · ${phase.model ?? "-"} · ${phase.status} · ${reasonCell(phase)}`);
  if (lines.length <= TIMELINE_LIMIT) return lines.join("\n");
  const kept = lines.slice(0, TIMELINE_LIMIT - 1);
  return [...kept, `… ${lines.length - kept.length} more phases not shown`].join("\n");
}

// The phases of this attempt, from `pipeline_phases`, else from state.json with an open item saying so.
async function timelinePhases({ run, state, env, openItems }) {
  const jobId = callerJobId(env);
  const since = await attemptStart(jobId, env);
  const rows = await openStore(env).runs.runTimeline({ projectId: run.projectId ?? null, slug: run.slug, since });
  const log = readJobLog(jobId, env);
  if (rows.length > 0) return recordedPhases(rows, log);
  openItems.push(FALLBACK_ITEM);
  return statePhases(state, log);
}

// The `## Run timeline` block of the reflector's prompt: phase, model, status and why it ran, in order; a failure answers `none recorded` and an open item.
export async function runTimelineLines({ run, state, env = process.env, openItems }) {
  try {
    return timelineText(await timelinePhases({ run, state, env, openItems }));
  } catch (error) {
    openItems.push(`the run timeline failed: ${error?.message ?? String(error)}`);
    return NONE;
  }
}
