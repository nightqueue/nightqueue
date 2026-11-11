import { createHash } from "node:crypto";
import { PIPELINE_TASK_TYPES } from "../../../../src/memory/runs.mjs";
import { isSafeSegment, RUNTIME_AUTHOR } from "../../../../src/queue/resume.mjs";
import { PHASE_ARTIFACTS, QA_SKIP_VERDICT, QA_STAGES } from "./artifacts.mjs";
import { briefCommitType, briefSection, briefSlug, briefType } from "./brief.mjs";
import { derivedType, firstItem } from "./contract.mjs";

// What a check of `resolve` asks the runtime to do after its contract lines: the index of 02; the Type, the Brief, the commit type,
// the termination and the slug of 01; the QA mode of the triage stage; the phase record of a completed check and the check memo.

// The triage verdicts that close the run on purpose.
const TERMINAL_VERDICT_LABELS = ["NO-CHANGE-NEEDED", "NOT-REPRODUCIBLE"];
const TERMINATION_MAX = 200;
const BRIEF_FILE = PHASE_ARTIFACTS.get("00").file;
const TRIAGE_PHASE = PHASE_ARTIFACTS.get("01").phase;
const QA_PHASE = PHASE_ARTIFACTS.get("05").phase;
const PASSING_LINES = new Set(["OK", "GENERATED"]);

// The sha256 of the text a check evaluated, which tells a repeated check of the same artifact apart from a new one.
function digestOf(text) {
  return createHash("sha256")
    .update(String(text ?? ""))
    .digest("hex");
}

// A text cut to at most the given number of code points.
export function capped(text, max) {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

// The explore map saved into the project index, on a passing check 02.
function indexEffects(result) {
  return PASSING_LINES.has(result.first) ? [{ kind: "saveIndex", text: result.evaluated }] : [];
}

// The Type of check 01: the Brief's when it states a valid one, else the one the triage implies when the run has none yet.
function typeEffects(result, state) {
  if (result.first.startsWith("MISSING")) return [];
  const recorded = PIPELINE_TASK_TYPES.includes(state?.type) ? state.type : null;
  const type = briefType(result.evaluated) ?? (recorded === null ? derivedType(result.evaluated) : null);
  if (type === null || type === recorded) return [];
  return [{ kind: "recordFields", fields: { type }, line: recorded === null ? `recorded: type ${type}` : `recorded: type ${type} (was ${recorded})` }];
}

// The triage's `## Brief` copied into `00-brief.md`, the Brief every later phase reads; with no such section the whole triage stands for it.
function briefEffects(result) {
  const section = briefSection(result.evaluated);
  if (section === null) return [{ kind: "writeRunFile", name: BRIEF_FILE, text: `${result.evaluated.trim()}\n`, line: `recorded: brief ${BRIEF_FILE} (whole triage: no ## Brief)` }];
  return [{ kind: "writeRunFile", name: BRIEF_FILE, text: `${section.trim()}\n`, line: `recorded: brief ${BRIEF_FILE}` }];
}

// The commit type of a completed check 01, when the Brief states an accepted one.
function commitTypeEffects(result) {
  const commitType = briefCommitType(result.evaluated);
  return commitType === null ? [] : [{ kind: "recordFields", fields: { commitType }, line: `recorded: commit type ${commitType}` }];
}

// Why the triage stopped the run on purpose: its verdict and the first open item, else the first line of the validated brief.
export function terminationReason(result) {
  const detail = firstItem(result.evaluated, "## Open items") ?? firstItem(result.evaluated, "## Validated brief");
  return capped(detail ? `${result.verdict}: ${detail}` : result.verdict, TERMINATION_MAX);
}

// A completed check 01: the stop of a verdict that closes the run on purpose, else lifting the runtime's own triage stop, which no longer holds.
function terminationEffects(result) {
  if (TERMINAL_VERDICT_LABELS.includes(result.verdict)) {
    const termination = { phase: TRIAGE_PHASE, reason: terminationReason(result) };
    return [{ kind: "recordFields", fields: { termination }, line: `recorded: run_terminate ${TRIAGE_PHASE} ${result.verdict}`, afterRecord: true }];
  }
  return [{ kind: "recordFields", fields: { termination: { phase: TRIAGE_PHASE, clear: true } }, line: "recorded: termination cleared", afterRecord: true }];
}

// Why the run keeps its provisional slug although the Brief was asked for one, or null when the named slug can be adopted.
function slugUnusable(named, current) {
  if (named === null) return "the Brief names no **Slug:**";
  if (!isSafeSegment(named)) return `\`${named}\` is not a valid run slug`;
  return named === current ? "the Brief names the same slug" : null;
}

// A completed check 01, last of all: a provisional run takes the Brief's slug, any other keeps its own.
function slugEffects(result, run) {
  const named = briefSlug(result.evaluated);
  if (!run.provisionalSlug) {
    const note = named !== null && named !== run.slug ? " (kept: the run already has its slug)" : "";
    return [{ kind: "say", line: `recorded: slug ${run.slug}${note}`, afterRecord: true }];
  }
  const unusable = slugUnusable(named, run.slug);
  if (unusable !== null) return [{ kind: "say", line: `recorded: slug ${run.slug} (kept: ${unusable})`, afterRecord: true }];
  return [{ kind: "recordFields", fields: { slug: named }, afterRecord: true }];
}

// Whether a phase entry is the runtime's record of a QA skip.
function isRuntimeQaSkip(entry) {
  return entry?.phase === QA_PHASE && entry?.by === RUNTIME_AUTHOR && entry?.verdict === QA_SKIP_VERDICT;
}

// Whether a QA mode leaves a recorded skip behind: a lite or full decision on a state that still holds one.
function leavesStaleQaSkip(state, mode) {
  return mode !== "skip" && Array.isArray(state?.phases) && state.phases.some(isRuntimeQaSkip);
}

// A completed `check 05 --stage triage`: the decision on the run, left untouched when the same mode already stands with no stale skip beside it, however the reason is worded; a lite or full decision drops the skip it supersedes.
function qaModeEffects(result, state) {
  const { mode, why } = result.qaMode;
  if (state?.qaMode?.mode === mode && !leavesStaleQaSkip(state, mode)) return [{ kind: "say", line: `recorded: qa_mode ${mode} (already)`, afterRecord: true }];
  const dropPhases = mode === "skip" ? null : { phase: QA_PHASE, by: RUNTIME_AUTHOR, verdict: QA_SKIP_VERDICT };
  return [{ kind: "recordFields", fields: { qaMode: { mode, reason: why } }, dropPhases, line: `recorded: qa_mode ${mode}`, afterRecord: true }];
}

// The phase record a completed check writes: a QA triage's skip stands for the whole QA phase, any other check records its own phase, and a check of no phase records none.
function recordOf(artifact, result) {
  if (!result.completes) return null;
  if (result.qaMode?.mode === "skip") {
    const qa = PHASE_ARTIFACTS.get("05");
    return { phase: qa.phase, artifact: qa.file, verdict: QA_SKIP_VERDICT, note: result.qaMode.why, reason: `QA skipped: ${result.qaMode.why}`, decision: true };
  }
  return artifact.phase ? { phase: artifact.phase, artifact: artifact.file, verdict: result.verdict ?? result.first } : null;
}

// The check memo: the one line that stands for the check and what tells a repeat of it apart.
function memoOf({ check, stage, result }) {
  return { key: stage ? `${check}-${stage}` : check, line: result.memoLine, ok: PASSING_LINES.has(result.memoLine), completed: result.completes, digest: digestOf(result.evaluated) };
}

// The line of a check that stopped short of a phase record for a reason other than a missing part.
function noRecordEffects(result, record) {
  return record !== null || result.completes || result.first.startsWith("MISSING") ? [] : [{ kind: "say", line: `recorded: none (${result.memoLine})` }];
}

// The effects of the triage check, in their order around the phase record.
function triageEffects(result, state, run) {
  if (!result.completes) return { before: typeEffects(result, state), after: [] };
  return {
    before: [...typeEffects(result, state), ...briefEffects(result), ...commitTypeEffects(result)],
    after: [...terminationEffects(result), ...slugEffects(result, run)],
  };
}

// The phase record, the memo and the effects a check's result asks for, in the order the runtime applies them.
export function answerParts({ check, stage, result, state, run }) {
  const artifact = stage !== null ? QA_STAGES[stage] : PHASE_ARTIFACTS.get(check);
  const record = recordOf(artifact, result);
  const triage = check === "01" ? triageEffects(result, state, run) : { before: [], after: [] };
  const before = [...(check === "02" ? indexEffects(result) : []), ...triage.before, ...noRecordEffects(result, record)];
  const after = [...(result.completes && result.qaMode !== null ? qaModeEffects(result, state) : []), ...triage.after];
  return { record, memo: memoOf({ check, stage, result }), effects: [...before, ...after] };
}
