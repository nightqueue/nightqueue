import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { derivedType, firstItem } from "../queue/check-contract.mjs";
import { PHASE_ARTIFACTS } from "../queue/phase-artifacts.mjs";
import { isSafeSegment, TERMINAL_VERDICT_LABELS } from "../queue/resume.mjs";
import { adoptRunSlug, isProvisionalSlug } from "../queue/run-slug.mjs";
import { clearTermination, recordCheck, recordRunFields, recordTermination, RUNTIME_AUTHOR } from "../queue/run-state.mjs";
import { briefCommitType, briefSection, briefSlug, briefType } from "../queue/triage-brief.mjs";
import { openStore } from "../store/open.mjs";
import { saveIndexFromText } from "./index-save.mjs";
import { worktreeOf } from "./run-context.mjs";

// The effects `run check` chains after printing its contract lines: the index of 02; the Type, the Brief, the commit type,
// the termination and the slug of 01; the QA stage A marker of 05a; the phase record of a completed check and the check memo.
// None of them changes the first line.

const TERMINATION_MAX = 200;
const BRIEF_FILE = PHASE_ARTIFACTS.get("00").file;
const PASSING_LINES = new Set(["OK", "GENERATED"]);

// The first line of an error's message.
function firstLine(err) {
  return String(err?.message ?? err).split("\n")[0];
}

// The sha256 of the text a check evaluated, which tells a repeated check of the same artifact apart from a new one.
function digestOf(text) {
  return createHash("sha256")
    .update(String(text ?? ""))
    .digest("hex");
}

// A text cut to at most the given number of code points.
function capped(text, max) {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

// The line a refused write prints, so the caller sees the record did not happen without the check failing.
function notRecorded(written) {
  return `recorded: not recorded (${written.reason ?? "unknown reason"})`;
}

// The `index:` line of check 02: the explore map saved into the project index, queued, or why not; never a failure of the check.
async function indexLine({ run, result, ctx }) {
  if (!PASSING_LINES.has(result.first)) return [];
  try {
    const saved = await saveIndexFromText({ text: result.evaluated, project: run.project, repoRoot: worktreeOf(run, ctx.env), ctx });
    if (saved.status === "queued") return [`index: not saved (store unavailable; queued at ${saved.path})`];
    return [`index: saved ${saved.files} files, ${saved.libs} libs`];
  } catch (err) {
    return [`index: not saved (${firstLine(err)})`];
  }
}

// The `recorded: type` line of check 01: the Brief's Type when it states a valid one, else the Type the triage implies when the run has none yet.
function typeLines({ run, result, state, ctx }) {
  if (result.first.startsWith("MISSING")) return [];
  const recorded = PIPELINE_TASK_TYPES.includes(state?.type) ? state.type : null;
  const type = briefType(result.evaluated) ?? (recorded === null ? derivedType(result.evaluated) : null);
  if (type === null || type === recorded) return [];
  const written = recordRunFields({ projectId: run.projectId, slug: run.slug, fields: { type }, env: ctx.env });
  if (written.status !== "written") return [notRecorded(written)];
  return [recorded === null ? `recorded: type ${type}` : `recorded: type ${type} (was ${recorded})`];
}

// The `recorded: brief` line of a completed check 01: the triage's `## Brief` copied into `00-brief.md`, the Brief every later phase reads.
function briefLines({ run, result }) {
  const section = briefSection(result.evaluated);
  if (section === null) return [notRecorded({ reason: "the triage has no ## Brief" })];
  try {
    writeFileSync(join(run.runDir, BRIEF_FILE), `${section.trim()}\n`);
  } catch (err) {
    return [notRecorded({ reason: `${BRIEF_FILE} could not be written: ${firstLine(err)}` })];
  }
  return [`recorded: brief ${BRIEF_FILE}`];
}

// The `recorded: commit type` line of a completed check 01, when the Brief states an accepted commit type.
function commitTypeLines({ run, result, ctx }) {
  const commitType = briefCommitType(result.evaluated);
  if (commitType === null) return [];
  const written = recordRunFields({ projectId: run.projectId, slug: run.slug, fields: { commitType }, env: ctx.env });
  return [written.status === "written" ? `recorded: commit type ${commitType}` : notRecorded(written)];
}

// The caller's own job row, or null outside a job or when the store cannot read it.
async function ownJobRow(run, env) {
  if (run.jobId === null) return null;
  try {
    return await openStore(env).jobs.getJob(run.jobId);
  } catch {
    return null;
  }
}

// Why the run keeps its provisional slug although the Brief was asked for one, or null when the named slug can be adopted.
function slugUnusable(named, current) {
  if (named === null) return "the Brief names no **Slug:**";
  if (!isSafeSegment(named)) return `\`${named}\` is not a valid run slug`;
  return named === current ? "the Brief names the same slug" : null;
}

// The `recorded: slug` line of a completed check 01, run last: a provisional run takes the Brief's slug (the row rebound, the run dir renamed), any other keeps its own.
async function slugLines({ run, result, ctx }) {
  const named = briefSlug(result.evaluated);
  const row = await ownJobRow(run, ctx.env);
  if (!isProvisionalSlug(row, run.slug)) {
    const note = named !== null && named !== run.slug ? " (kept: the run already has its slug)" : "";
    return [`recorded: slug ${run.slug}${note}`];
  }
  const unusable = slugUnusable(named, run.slug);
  if (unusable !== null) return [`recorded: slug ${run.slug} (kept: ${unusable})`];
  const job = { id: row.id, worker: row.worker, project_id: row.project_id };
  try {
    const adopted = await adoptRunSlug({ job, from: run.slug, to: named, store: openStore(ctx.env), env: ctx.env });
    if (adopted.status === "kept") return [`recorded: slug ${run.slug} (kept: ${[adopted.reason, adopted.warning].filter(Boolean).join("; ")})`];
    return [`recorded: slug ${named} (renamed from ${run.slug}; run dir ${adopted.dir})`];
  } catch (err) {
    return [`recorded: slug ${run.slug} (kept: ${firstLine(err)})`];
  }
}

// Why the triage stopped the run on purpose: its verdict and the first open item, else the first line of the validated brief.
function terminationReason(result) {
  const detail = firstItem(result.evaluated, "## Open items") ?? firstItem(result.evaluated, "## Validated brief");
  return capped(detail ? `${result.verdict}: ${detail}` : result.verdict, TERMINATION_MAX);
}

// The `recorded: run_terminate` line of a completed check 01 whose verdict closes the run on purpose.
function terminationLines({ run, result, ctx }) {
  if (!TERMINAL_VERDICT_LABELS.includes(result.verdict)) return [];
  const written = recordTermination({ projectId: run.projectId, slug: run.slug, phase: "triage", reason: terminationReason(result), by: RUNTIME_AUTHOR, env: ctx.env });
  return [written.status === "written" ? `recorded: run_terminate triage ${result.verdict}` : notRecorded(written)];
}

// The `recorded: termination cleared` line of a completed check 01 that proceeds: the runtime's own triage stop no longer holds.
function liftedTerminationLines({ run, result, ctx }) {
  if (TERMINAL_VERDICT_LABELS.includes(result.verdict)) return [];
  const cleared = clearTermination({ projectId: run.projectId, slug: run.slug, phase: "triage", env: ctx.env });
  if (cleared.status === "absent") return [];
  return [cleared.status === "written" ? "recorded: termination cleared" : notRecorded(cleared)];
}

// The `recorded: qa_stage_a` line of a completed check 05a: the marker that lets a resume re-enter the QA at stage B.
function qaStageALines({ run, check, result, ctx }) {
  const artifact = PHASE_ARTIFACTS.get(check).file;
  const fields = { qaStageA: { artifact, verdict: result.verdict } };
  const written = recordRunFields({ projectId: run.projectId, slug: run.slug, fields, env: ctx.env });
  return [written.status === "written" ? `recorded: qa_stage_a ${result.verdict}` : notRecorded(written)];
}

// The `recorded: phase_done` line from what the check record decided: appended (with its reason) or already recorded.
function phaseDoneLine(done, written) {
  if (written.status !== "written" || written.phase === null) return notRecorded(written);
  const base = `recorded: phase_done ${done.phase} ${done.verdict}`;
  if (written.phase.status === "already") return `${base} (already)`;
  return written.phase.reason ? `${base} — reason: ${written.phase.reason}` : base;
}

// Writes the check memo and, for a completed check of a phase, the phase itself; answers the `recorded:` line of the phase.
function memoAndPhaseLines({ run, check, result, ctx }) {
  const artifact = PHASE_ARTIFACTS.get(check);
  const memo = { line: result.memoLine, ok: PASSING_LINES.has(result.memoLine), completed: result.completes, digest: digestOf(result.evaluated) };
  const done = result.completes && artifact.phase ? { phase: artifact.phase, artifact: artifact.file, verdict: result.verdict ?? result.first } : null;
  const written = recordCheck({ projectId: run.projectId, slug: run.slug, check, memo, done, env: ctx.env });
  if (done !== null) return [phaseDoneLine(done, written)];
  if (written.status !== "written") ctx.err(`nightqueue: the check memo was not recorded on the run: ${written.reason}`);
  return result.completes || result.first.startsWith("MISSING") ? [] : [`recorded: none (${result.memoLine})`];
}

// Runs the effects of a check in order and answers the lines they print: `index:` first, then every `recorded:` line.
export async function checkEffectLines({ run, check, result, state, ctx }) {
  const args = { run, check, result, state, ctx };
  const triageDone = check === "01" && result.completes;
  const index = check === "02" ? await indexLine(args) : [];
  const type = check === "01" ? typeLines(args) : [];
  const brief = triageDone ? briefLines(args) : [];
  const commitType = triageDone ? commitTypeLines(args) : [];
  const recorded = memoAndPhaseLines(args);
  const qaStageA = check === "05a" && result.completes ? qaStageALines(args) : [];
  const termination = triageDone ? terminationLines(args) : [];
  const lifted = triageDone ? liftedTerminationLines(args) : [];
  const slug = triageDone ? await slugLines(args) : [];
  return [...index, ...type, ...brief, ...commitType, ...recorded, ...qaStageA, ...termination, ...lifted, ...slug];
}
