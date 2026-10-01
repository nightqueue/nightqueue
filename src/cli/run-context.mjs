import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "../config/errors.mjs";
import { jobLogPath, runDir } from "../config/paths.mjs";
import { registeredProject } from "../memory/registry-access.mjs";
import { resolveJobRun } from "../queue/job-run.mjs";
import { itemRefOfJob } from "../queue/pr-footer.mjs";
import { formatDuration } from "../queue/narrate.mjs";
import { isSafeSegment, isStateObject, readRunState } from "../queue/resume.mjs";
import { callerJobId } from "../queue/retry.mjs";
import { phaseTelemetry } from "../queue/telemetry.mjs";
import { openStore } from "../store/open.mjs";

// The options every subcommand shares: outside a job they are the only way to say which run is meant.
export const RUN_OPTIONS = { project: { type: "string" }, slug: { type: "string" } };

// Refuses to read another run from inside a job: the run of a job is the one its own row names, never one the prompt spelled out.
function refuseNamedRun(own) {
  throw new UserError(
    `refusing to name a run from inside job \`${own}\`: \`nightqueue run\` acts on the run of the job it is called from; ` +
      "drop `--project`/`--slug`, or run the command outside the queue",
  );
}

// Refuses to work a run whose slug the row does not carry yet, instead of inventing one.
function refuseMissingSlug(own) {
  throw new UserError(
    `job \`${own}\` has no run slug on its row yet: print \`SLUG: <slug>\` once, so the runtime binds the run directory, ` +
      "then call this command again",
  );
}

// The run of the job this process belongs to: its own row, or its job block on disk when the database is unavailable.
async function jobRun(own, values, env) {
  if (values.project !== undefined || values.slug !== undefined) refuseNamedRun(own);
  const run = await resolveJobRun(own, env);
  if (!isSafeSegment(run.slug)) refuseMissingSlug(own);
  return { jobId: own, project: run.project, projectId: run.projectId, slug: run.slug };
}

// The run an operator names from outside a job, where nothing else can tell which one it is.
function operatorRun(values, env) {
  const project = (values.project ?? "").trim();
  const slug = (values.slug ?? "").trim();
  if (!project || !slug) {
    throw new UserError(
      "outside a job, `--project` (the registered NAME) and `--slug` (the `<slug>` of runs/<project_id>/<slug>) are both required",
    );
  }
  if (!isSafeSegment(slug)) {
    throw new UserError(`invalid slug \`${slug}\`: a run slug is one path segment of letters, digits and \`. _ + -\``);
  }
  const registered = registeredProject(project, env);
  if (!registered) {
    throw new UserError(`unknown project \`${project}\`: pass the registered project NAME; list them with \`nightqueue project list\``);
  }
  return { jobId: null, project: registered.name, projectId: registered.id, slug };
}

// The run every `nightqueue run` subcommand acts on: the caller's own job run inside the queue, the one an operator named outside it.
export async function resolveRun(values, ctx) {
  const own = callerJobId(ctx.env);
  const run = own === null ? operatorRun(values, ctx.env) : await jobRun(own, values, ctx.env);
  return { ...run, runDir: runDir(run.projectId, run.slug, ctx.env) };
}

// Whether the pipeline has recorded anything into the run: a phase or an outcome, as opposed to the runtime's own job block alone.
export function pipelineStarted(state) {
  return (Array.isArray(state.phases) && state.phases.length > 0) || isStateObject(state.outcome);
}

// The state.json of the run, refusing when nothing has been recorded into it yet or only the runtime created it.
export function requireRunState({ projectId, slug, runDir: dir }, env) {
  const state = readRunState({ projectId, slug, env });
  const path = join(dir, "state.json");
  if (!isStateObject(state)) {
    throw new UserError(`no run recorded at ${path}; the runtime writes it as the phases complete`);
  }
  if (isStateObject(state.job) && !pipelineStarted(state)) {
    throw new UserError(`the runtime created this run at ${state.job.createdAt ?? "an unknown time"}; the pipeline has recorded no phase in ${path} yet`);
  }
  return state;
}

// The ref of the issue the run's job came from: the job block of state.json first (null for a free-prompt job), the job row otherwise.
export async function runItemRef(run, env) {
  const state = readRunState({ projectId: run.projectId, slug: run.slug, env });
  const block = isStateObject(state) && isStateObject(state.job) ? state.job : null;
  if (block !== null && run.jobId !== null && block.id === run.jobId) return block.itemRef ?? null;
  return await itemRefOfJob(openStore(env), run.jobId);
}

// The accumulated stream of the job on disk, the only source of what the runtime measured; no log means nothing was measured.
export function readJobLog(jobId, env) {
  if (jobId === null) return "";
  try {
    return readFileSync(jobLogPath(jobId, env), "utf8");
  } catch {
    return "";
  }
}

// The lanes the runtime measured, grouped by phase name, so a phase that ran twice keeps one measure per run of it.
export function measuredByPhase(log) {
  const byPhase = new Map();
  for (const lane of phaseTelemetry(log)) {
    const lanes = byPhase.get(lane.phase) ?? [];
    lanes.push(lane);
    byPhase.set(lane.phase, lanes);
  }
  return byPhase;
}

// How a recorded phase ended: the verdict the phase reported, or `ok` for a phase that was recorded without one.
function phaseStatus(entry) {
  const verdict = typeof entry?.verdict === "string" ? entry.verdict.trim() : "";
  return verdict || "ok";
}

// One row per phase recorded in state.json, enriched with the model and the duration the runtime measured for its lane.
export function phaseRows(state, log) {
  const measured = measuredByPhase(log);
  const phases = Array.isArray(state.phases) ? state.phases : [];
  return phases.map((entry) => {
    const lane = measured.get(entry?.phase)?.shift() ?? null;
    return {
      phase: String(entry?.phase ?? "-"),
      at: typeof entry?.at === "string" ? entry.at : null,
      model: lane?.model ?? null,
      status: phaseStatus(entry),
      durationS: lane?.durationS ?? null,
    };
  });
}

// A duration as the report reads it, and a dash when the runtime measured none.
export function durationCell(seconds) {
  return Number.isFinite(seconds) ? formatDuration(seconds * 1000) : "-";
}

// The checkout of the project of a run: the directory its worktrees were created from, and the only one that may remove them.
export function projectCheckout(project, env) {
  const registered = registeredProject(project, env);
  if (!registered?.path) throw new UserError(`unknown project \`${project}\`: it is no longer registered, so its checkout cannot be read`);
  return registered.path;
}

// Where the code of this run lives: the worktree the pipeline recorded, or the project's own checkout when no worktree was created.
export function worktreeOf({ project, projectId, slug }, env) {
  const state = readRunState({ projectId, slug, env });
  const recorded = isStateObject(state) && typeof state.worktree === "string" ? state.worktree.trim() : "";
  return recorded || projectCheckout(project, env);
}

// A file the command cannot work without, read from where the caller pointed at it.
export function readRequiredFile(path, flag) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new UserError(`could not read \`${flag}\` ${path}: ${error.message}`);
  }
}

// The lines a host command answered on stdout, trimmed and without the empty ones.
export function outputLines(result) {
  return String(result?.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

// The one line of a failed host command worth showing, so an error message never carries a whole page of output.
export function failureLine(result) {
  const text = `${result?.stderr ?? ""}\n${result?.stdout ?? ""}`.trim();
  return text.split("\n")[0] || "the command answered nothing";
}
