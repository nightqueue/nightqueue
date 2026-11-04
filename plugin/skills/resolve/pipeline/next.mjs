import { MANIFEST, PHASE_ARTIFACTS } from "./artifacts.mjs";
import { beforeQa, CONFIRM_LINE, flatLine, planStageNumbers, sectionItems } from "./contract.mjs";
import { nextDefect } from "../../../../src/queue/pipeline-answer.mjs";
import { capped, terminationReason } from "./effects.mjs";

// What `run check` tells the orchestrator to do next, from the check's answer and the loops the run has been through.

const MAX_FIX = MANIFEST.constants.maxFixIterations;
const MAX_ARCHITECT_ROUNDS = 2;
const FAILURES_MAX = 300;
const CONFIRM_QUESTION_PREFIX = `${CONFIRM_LINE} — `;
const STAGE_VERDICT_RE = /^VERDICT: .* \(stage (\d+)\)$/;
const STAGE_BLOCK_RE = /^###\s+Stage\s+(\d+)\b/gm;
const DIAGNOSIS_INCOMPLETE = "the diagnosis is incomplete; look for the underestimated path (order of gates, preceding branch, race, data source)";
const DECISIONS_TAKEN_NOTE = "record it in ## Decisions taken";
const NO_VERDICT = "verification produced no verdict";
const NO_NEW_ROUND = "wrote no new round after the last lane, so its failures stay open";
const TRIAGE_PHASE = PHASE_ARTIFACTS.get("01").phase;
const ARCHITECTURE_PHASE = PHASE_ARTIFACTS.get("03").phase;
const IMPLEMENTATION_PHASE = PHASE_ARTIFACTS.get("04").phase;
const QA_PHASE = PHASE_ARTIFACTS.get("05").phase;
const VERIFICATION_PHASE = PHASE_ARTIFACTS.get("06").phase;
const RUNTIME_PHASE = PHASE_ARTIFACTS.get("07").phase;
const RUNTIME_FIX_VERDICTS = new Set(["NOT-MET", "SYMPTOM-PERSISTS"]);
const DURABLE_LOOPS = ["fix", "architect", "retriage", "stage", "fixPending", "invalidated", "pendingQaRow", "counted"];
const DECIDING_LAUNCH_RE = /^launch (?:coder-fix|architect|triager)\b/;
const ISO_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// Whether a held value is a count: a non-negative safe integer.
function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// A count of a held state, zero for anything that is not a count.
function countOf(value) {
  return isCount(value) ? value : 0;
}

// A held action when it is one the closed grammar accepts, else null.
function actionOf(value) {
  return typeof value === "string" && nextDefect(value, MANIFEST) === null ? value : null;
}

// Whether a recorded phase entry is one the next lane owes a fix to, given the fix count when it landed.
function owesFix(entry, fix) {
  if (entry.phase === QA_PHASE) return entry.verdict === "NEEDS FIX";
  if (entry.phase === VERIFICATION_PHASE) return entry.verdict === "FAILED" && fix < MAX_FIX;
  return entry.phase === RUNTIME_PHASE && RUNTIME_FIX_VERDICTS.has(entry.verdict);
}

// The replay after an entry that decides what the next implementation lane is: a QA starts the fix count over.
function withTrigger(replay, entry) {
  const fix = entry.phase === QA_PHASE ? 0 : replay.fix;
  return { ...replay, fix, trigger: entry.phase, fixPending: owesFix(entry, fix) };
}

// The fix count after an implementation lane: one more for a fix lane, zero for the next stage lane, kept otherwise.
function fixAfterLane(replay) {
  if (replay.fixPending) return replay.fix + 1;
  return replay.trigger === VERIFICATION_PHASE ? 0 : replay.fix;
}

// The replay after one recorded phase entry.
function replayEntry(replay, entry) {
  if (entry.phase === IMPLEMENTATION_PHASE) return { ...replay, fix: fixAfterLane(replay) };
  if (entry.phase === ARCHITECTURE_PHASE) return replay.previous === QA_PHASE ? { ...replay, architect: replay.architect + 1 } : replay;
  const triggered = withTrigger(replay, entry);
  if (entry.phase === RUNTIME_PHASE) return { ...triggered, runtimeSeen: true };
  if (entry.phase === TRIAGE_PHASE && replay.runtimeSeen) return { ...triggered, retriage: 1 };
  return triggered;
}

// The fix, architect and re-triage counts and the fix owed, replayed from the phases every attempt recorded.
function phaseLoops(phases) {
  const entries = Array.isArray(phases) ? phases.filter((entry) => entry !== null && typeof entry === "object") : [];
  const start = { fix: 0, architect: 0, retriage: 0, fixPending: false, trigger: null, previous: null, runtimeSeen: false };
  const replay = entries.reduce((held, entry) => ({ ...replayEntry(held, entry), previous: entry.phase }), start);
  return { fix: replay.fix, architect: replay.architect, retriage: replay.retriage, fixPending: replay.fixPending };
}

// The loop facts a decision record keeps, picked in a fixed order so two snapshots compare as text.
function durableOf(loops) {
  return Object.fromEntries(DURABLE_LOOPS.map((name) => [name, loops?.[name] ?? null]));
}

// The decision records the runtime kept for this run, skipping any entry of a hostile shape.
function decisionsOf(state) {
  const entries = Array.isArray(state?.decisions) ? state.decisions : [];
  return entries.filter((entry) => isObject(entry) && isObject(entry.loops));
}

// Whether a value is a plain object.
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Every assumption any decision recorded as invalidated, once each.
function replayedInvalidated(decisions) {
  const items = decisions.flatMap((entry) => (Array.isArray(entry.loops.invalidated) ? entry.loops.invalidated : []));
  return [...new Set(items.filter((item) => typeof item === "string"))];
}

// The time of a runtime stamp in the ISO form the runtime writes, or null for any other value.
function isoTime(value) {
  const time = typeof value === "string" && ISO_AT_RE.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

// Whether a check memo was written at or after a decision: by the runtime's check sequence when both carry it, else by time, an unreadable order counting as after.
function writtenSince(memo, decision) {
  if (isCount(memo?.seq) && isCount(decision.seq)) return memo.seq >= decision.seq;
  const memoTime = isoTime(memo?.at);
  const decisionTime = isoTime(decision.at);
  return memoTime === null || decisionTime === null || memoTime >= decisionTime;
}

// Whether a decision is the last thing the run checked: its own check not since run on another text, and no other check since.
function isLatestCheck(state, decision) {
  const checks = isObject(state?.checks) ? state.checks : {};
  if (Object.hasOwn(checks, decision.check) && checks[decision.check]?.digest !== decision.digest) return false;
  return !Object.entries(checks).some(([key, memo]) => key !== decision.check && key !== "lastFailure" && writtenSince(memo, decision));
}

// The loops another attempt left, from the last decision record, else replayed from the recorded phases of a run with none.
function replayedLoops(state) {
  const decisions = decisionsOf(state);
  const last = decisions.at(-1);
  if (last === undefined) return phaseLoops(state?.phases);
  return { ...durableOf(last.loops), invalidated: replayedInvalidated(decisions), lastNext: isLatestCheck(state, last) ? last.next : null };
}

// The loops of this attempt from its cache, else the ones replayed from the run's records when the cache holds none or another attempt's.
function loopsOf(state) {
  const attempt = state?.lastClaim?.attempt ?? null;
  const held = state?.pipelineLoops;
  const usable = held !== null && typeof held === "object" && (held.attempt ?? null) === attempt;
  const loops = usable ? held : replayedLoops(state);
  return {
    attempt,
    missing: loops.missing !== null && typeof loops.missing === "object" ? loops.missing : {},
    fix: countOf(loops.fix),
    architect: countOf(loops.architect),
    retriage: countOf(loops.retriage),
    stage: isCount(loops.stage) ? loops.stage : null,
    lastNext: actionOf(loops.lastNext),
    fixPending: loops.fixPending === true,
    invalidated: Array.isArray(loops.invalidated) ? loops.invalidated : [],
    pendingQaRow: actionOf(loops.pendingQaRow),
    counted: countedOf(loops.counted),
  };
}

// The counted row a re-run repeats, or null when the held one is not of its shape or its action is off the grammar.
function countedOf(held) {
  if (!isObject(held) || typeof held.key !== "string" || actionOf(held.next) === null) return null;
  return { ...held, unchanged: countOf(held.unchanged) };
}

// A `launch` action with its optional stage and note.
function launch(target, { stage = null, note = null } = {}) {
  return ["launch", target, ...(stage === null ? [] : [`stage=${stage}`]), ...(note === null ? [] : [`note=${flatLine(note)}`])].join(" ");
}

// A `publish --draft` action with what remains.
function publishDraft(remaining) {
  return `publish --draft remaining=${flatLine(remaining)}`;
}

// The stages of the plan after a stage, none when the stage is unknown or the plan has no stages.
function stagesNotRun(ctx, stage) {
  if (stage === null || ctx.stages.length < 2) return [];
  return ctx.stages.filter((number) => number > stage);
}

// A `publish --draft` action that, on a stage row, also names the stages of the plan it leaves unrun.
function draftOnStage(ctx, stage, remaining) {
  const notRun = stagesNotRun(ctx, stage);
  return publishDraft(notRun.length === 0 ? remaining : `${remaining}; stages not run: ${notRun.join(", ")}`);
}

// The stage a verification round states on its `VERDICT: … (stage N)` line, or null when it states none.
function statedStage(ctx) {
  const stated = ctx.result.lines.map((line) => STAGE_VERDICT_RE.exec(line)?.[1]).find(Boolean);
  return stated === undefined ? null : Number(stated);
}

// The stage an unchanged row is in: the lane the loops hold, else the one its round states.
function rowStage(ctx) {
  return ctx.loops.stage ?? statedStage(ctx);
}

// The lines of the answer that start with a prefix.
function linesWith(ctx, prefix) {
  return ctx.result.lines.filter((line) => line.startsWith(prefix));
}

// Whether the answer's first line says a part is missing.
function isMissing(ctx) {
  return ctx.result.first.startsWith("MISSING");
}

// The `MISSING:`, `REPAIRED:` and `GATE:` lines of the answer as one note.
function problemNote(ctx) {
  const lines = [...linesWith(ctx, "MISSING"), ...(ctx.repaired ? [ctx.repaired] : []), ...linesWith(ctx, "GATE: ")];
  return flatLine(lines.join(" · "));
}

// A step that counts as a miss of this check, so the next one is the still-missing row.
function missed(action) {
  return { action, missed: true };
}

// A step of a counted loop, which a re-run of the check on the same text repeats instead of counting again.
function counted(action, set = {}, unchanged = 0) {
  return { action, set, counted: true, unchanged };
}

// The items of a section as one bounded line, or the fallback when it has none.
function itemsLine(text, heading, fallback) {
  const items = sectionItems(text, heading, { fold: true });
  return capped(flatLine(items.length > 0 ? items.join("; ") : fallback), FAILURES_MAX);
}

// The failures a verification round names.
function verificationFailures(ctx) {
  return itemsLine(ctx.result.evaluated, "## Failures", "the verification still fails");
}

// The fix loop: another `coder-fix` while iterations are left, `publish --draft` at the limit.
function fixLoop(ctx, failures) {
  if (ctx.loops.fix >= MAX_FIX) return counted(publishDraft(failures));
  const fix = ctx.loops.fix + 1;
  return counted(launch("coder-fix", { note: `iteration ${fix}: ${failures}` }), { fix });
}

// What comes after the last implementation lane: the QA, or straight to the verifier on a re-triage, which goes back to Phase 6.
function afterImplementation(loops, note = null) {
  return launch(loops.retriage >= 1 ? "verifier" : "qa-triage", { note });
}

// The brief: the triage is what writes it.
function briefNext() {
  return { action: launch("triager") };
}

// The triage: a relaunch, its verdict, or a re-triage's own limit.
function triageNext(ctx) {
  const { loops, result } = ctx;
  const retriaging = loops.retriage >= 1;
  if (isMissing(ctx) || linesWith(ctx, "GATE: ").length > 0) {
    const note = problemNote(ctx);
    if (!ctx.still) return missed(launch("triager", { note }));
    return missed(retriaging ? publishDraft(`re-triage: ${note}`) : `terminate ${note}`);
  }
  if (result.verdict === "PROCEED") return { action: launch(retriaging ? "architect" : "explore") };
  if (retriaging) return { action: publishDraft(`re-triage answered ${result.verdict}`) };
  return { action: result.verdict === "NO-CHANGE-NEEDED" ? "report" : `terminate ${flatLine(terminationReason(result))}` };
}

// The exploration: one relaunch, then the architect with what the artifact has.
function exploreNext(ctx) {
  if (!isMissing(ctx)) return { action: launch("architect") };
  return missed(ctx.still ? launch("architect") : launch("explore", { note: problemNote(ctx) }));
}

// The first coder lane of the plan the check read.
function firstCoderLane(ctx) {
  const [first] = ctx.stages.length >= 2 ? ctx.stages : [null];
  return { action: launch("coder", { stage: first }), set: { stage: first } };
}

// The plan: one relaunch of a missing part, the one pause, then the QA row it was holding or the first coder lane.
function planNext(ctx) {
  if (isMissing(ctx)) {
    const note = problemNote(ctx);
    if (!ctx.still) return missed(launch("architect", { note }));
    return missed(ctx.loops.retriage >= 1 ? publishDraft(note) : `terminate ${note}`);
  }
  const [question] = linesWith(ctx, CONFIRM_QUESTION_PREFIX);
  if (question !== undefined) return { action: `gate ${flatLine(question.slice(CONFIRM_QUESTION_PREFIX.length))}` };
  if (ctx.loops.pendingQaRow !== null) return counted(ctx.loops.pendingQaRow, { pendingQaRow: null });
  return firstCoderLane(ctx);
}

// The lane a staged run is in before its QA: the one recorded, else the highest stage the artifact reports, else the first of the plan.
function activeLane(ctx) {
  if (ctx.loops.stage !== null) return ctx.loops.stage;
  if (ctx.stages.length < 2 || !beforeQa(ctx.state)) return null;
  const reported = [...String(ctx.result.evaluated).matchAll(STAGE_BLOCK_RE)].map((match) => Number(match[1]));
  return reported.length > 0 ? Math.max(...reported) : ctx.stages[0];
}

// The implementation: nothing changed stops the run, a lane or a fix goes to the verifier, the last lane to the QA.
function implementationNext(ctx) {
  if (isMissing(ctx)) return { action: `terminate ${flatLine(ctx.result.first)}` };
  const note = ctx.result.first === "GENERATED" ? `the file list is in ${MANIFEST.fileListFallback}` : null;
  const stage = activeLane(ctx);
  if (stage !== null) return { action: launch("verifier", { stage, note }), set: { stage } };
  return { action: ctx.loops.fixPending ? launch("verifier", { note }) : afterImplementation(ctx.loops, note) };
}

// The QA triage: its mode decides; a mode that stays unreadable falls to `lite`.
function qaTriageNext(ctx) {
  if (isMissing(ctx)) return missed(ctx.still ? launch("qa-lite") : launch("qa-triage", { note: problemNote(ctx) }));
  const mode = ctx.result.qaMode?.mode;
  if (mode === "skip") return { action: launch("verifier") };
  return { action: launch(mode === "full" ? "qa-analyst" : "qa-lite") };
}

// The QA analyst: its provers, or straight to the consolidation with no hypothesis.
function qaAnalystNext(ctx) {
  if (isMissing(ctx)) return missed(ctx.still ? launch("verifier") : launch("qa-analyst", { note: problemNote(ctx) }));
  return { action: linesWith(ctx, "QA-STAGE: provers").length > 0 ? launch("qa-prover") : "check 05" };
}

// The row of the QA's verdict.
function qaVerdictRow(ctx) {
  if (ctx.result.verdict !== "NEEDS FIX") return counted(launch("verifier"));
  const breaks = itemsLine(ctx.result.evaluated, "## Proven breaks", "see ## Proven breaks");
  return counted(launch("coder-fix", { note: `iteration 1: ${breaks}` }), { fix: 1 });
}

// The invalidated assumptions: the architect revises the plan once per assumption, then records it and the verdict row waits for that.
function invalidatedRow(ctx, lines) {
  const items = lines.map((line) => line.slice("INVALIDATED: ".length));
  const { architect, invalidated } = ctx.loops;
  const set = { architect: architect + 1, invalidated: [...new Set([...invalidated, ...items])] };
  if (architect < MAX_ARCHITECT_ROUNDS && !items.some((item) => invalidated.includes(item))) return counted(launch("architect", { note: lines.join(" · ") }), set);
  const row = qaVerdictRow(ctx);
  return counted(launch("architect", { note: DECISIONS_TAKEN_NOTE }), { ...set, ...row.set, pendingQaRow: row.action });
}

// Whether this run's QA is the one-lane kind, whose relaunch is the same lane.
function isLiteQa(ctx) {
  return ctx.state?.qaMode?.mode === "lite" || (ctx.loops.lastNext ?? "").startsWith("launch qa-lite");
}

// The QA: one relaunch of a missing round, the invalidated assumptions, then its verdict.
function qaNext(ctx) {
  if (isMissing(ctx)) {
    if (ctx.still) return missed(launch("verifier"));
    return missed(launch(isLiteQa(ctx) ? "qa-lite" : "qa-analyst", { note: problemNote(ctx) }));
  }
  const invalidated = linesWith(ctx, "INVALIDATED: ");
  return invalidated.length > 0 ? invalidatedRow(ctx, invalidated) : qaVerdictRow(ctx);
}

// The lane after a stage: the plan's next one, else what comes after the implementation.
function nextLane(ctx, stage) {
  const following = ctx.stages.find((number) => number > stage);
  if (following === undefined) return counted(afterImplementation(ctx.loops), { stage: null, fix: 0 });
  return counted(launch("coder", { stage: following }), { stage: following, fix: 0 });
}

// A round of one stage: a failure takes its fix loop, and at the limit it stays an open item and the next lane starts.
function stageVerificationNext(ctx, stage) {
  if (ctx.result.verdict !== "FAILED" || ctx.loops.fix >= MAX_FIX) return nextLane(ctx, stage);
  return fixLoop(ctx, verificationFailures(ctx));
}

// The verification: one relaunch of a missing round, a stage's own row, the runtime lane, or the fix loop.
function verificationNext(ctx) {
  if (isMissing(ctx)) {
    return missed(ctx.still ? draftOnStage(ctx, ctx.loops.stage, NO_VERDICT) : launch("verifier", { stage: ctx.loops.stage, note: problemNote(ctx) }));
  }
  const stated = statedStage(ctx);
  if (stated !== null) return stageVerificationNext(ctx, stated);
  return ctx.result.verdict === "FAILED" ? fixLoop(ctx, verificationFailures(ctx)) : { action: launch("runtime") };
}

// A symptom that persists with the plan applied: one re-triage, then a draft.
function retriageRow(ctx) {
  if (ctx.loops.retriage >= 1) return counted(publishDraft("the symptom persists after the re-triage"));
  return counted(launch("triager", { note: DIAGNOSIS_INCOMPLETE }), { retriage: 1 });
}

// What makes a runtime answer go back to the coder or to the triage, or null when it goes to neither.
function runtimeLoopBack(ctx) {
  const { verdict } = ctx.result;
  const persists = verdict === "SYMPTOM-PERSISTS";
  if (persists && linesWith(ctx, "DIFF-APPLIES: yes").length > 0 && linesWith(ctx, "GATE: runtime-not-met").length === 0) return retriageRow(ctx);
  if (persists || verdict === "NOT-MET" || linesWith(ctx, "GATE: runtime-not-met").length > 0) return fixLoop(ctx, problemNote(ctx) || `runtime verdict ${verdict}`);
  return null;
}

// The runtime lane: a gate before a verdict; a lane that made no attempt is relaunched once, and every limit still publishes.
function runtimeNext(ctx) {
  const noAttempt = linesWith(ctx, "GATE: runtime-not-met").length === 0 && linesWith(ctx, "GATE: runtime-no-attempt").length > 0;
  if (isMissing(ctx) || noAttempt) return missed(ctx.still ? "publish" : launch("runtime", { note: problemNote(ctx) }));
  return runtimeLoopBack(ctx) ?? { action: "publish" };
}

const ROWS = {
  "00": briefNext,
  "01": triageNext,
  "02": exploreNext,
  "03": planNext,
  "04": implementationNext,
  "05-triage": qaTriageNext,
  "05-analyst": qaAnalystNext,
  "05": qaNext,
  "06": verificationNext,
  "07": runtimeNext,
};

const UNCHANGED_RELAUNCHES = {
  "03": (_ctx, note) => launch("architect", { note }),
  "05": (ctx, note) => launch(isLiteQa(ctx) ? "qa-lite" : "qa-analyst", { note }),
  "06": (ctx, note) => launch("verifier", { stage: rowStage(ctx), note }),
  "07": (_ctx, note) => launch("runtime", { note }),
};

// What an unchanged relaunch keeps owed: the QA row the plan answered, which the revised plan answers again.
function heldOnRelaunch(ctx) {
  return ctx.key === "03" ? { pendingQaRow: ctx.loops.counted.next } : {};
}

// What a counted row answers on a text unchanged since another check ran: its own lane once, then a draft.
function unchangedStep(ctx, unchanged) {
  const relaunch = UNCHANGED_RELAUNCHES[ctx.key];
  if (unchanged === 0 && relaunch !== undefined) return counted(relaunch(ctx, `${PHASE_ARTIFACTS.get(ctx.key).file} unchanged since the last check`), heldOnRelaunch(ctx), 1);
  return counted(draftOnStage(ctx, rowStage(ctx), `check ${ctx.key} ${NO_NEW_ROUND}`), {}, 2);
}

// The loops after a step: this check's miss counted or dropped, the fix a `coder-fix` leaves owed, the step's own changes and what a re-run must repeat.
function settledLoops(ctx, step) {
  const { key, digest, loops } = ctx;
  const { [key]: previous = 0, ...missing } = loops.missing;
  const fixPending = step.action.startsWith("launch coder-fix") || (loops.fixPending && key !== "06");
  return {
    ...loops,
    ...step.set,
    missing: step.missed === true ? { ...missing, [key]: countOf(previous) + 1 } : missing,
    fixPending,
    lastNext: step.action,
    counted: step.counted === true ? { key, digest, next: step.action, unchanged: step.unchanged } : loops.counted,
  };
}

// The record a step leaves for a later attempt: on a launch of coder-fix, architect or triager, or when a loop fact it keeps changed; null otherwise.
function decisionOf(ctx, step, settled) {
  const after = durableOf(settled);
  const changed = JSON.stringify(durableOf(ctx.loops)) !== JSON.stringify(after);
  if (!changed && !DECIDING_LAUNCH_RE.test(step.action)) return null;
  return { check: ctx.key, digest: ctx.digest, next: step.action, loops: after };
}

// The `NEXT:` action of a check's answer, the loops it leaves and the decision it records; a re-run of a counted row on the same text repeats its action, burns no iteration and records nothing, and the same text after another check ran relaunches its lane once, then ends in a draft.
export function nextOf({ result, repaired, state, memo, plan }) {
  const loops = loopsOf(state);
  const { key, digest } = memo;
  const sameText = loops.counted?.key === key && loops.counted?.digest === digest;
  const unchanged = sameText ? countOf(loops.counted.unchanged) : 0;
  if (sameText && unchanged === 0 && loops.lastNext === loops.counted.next) return { action: loops.counted.next, loops, decision: null };
  const ctx = { result, repaired, state, loops, key, digest, still: countOf(loops.missing[key]) >= 1, stages: planStageNumbers(plan) };
  const step = sameText ? unchangedStep(ctx, unchanged) : ROWS[key](ctx);
  const settled = settledLoops(ctx, step);
  return { action: step.action, loops: settled, decision: decisionOf(ctx, step, settled) };
}
