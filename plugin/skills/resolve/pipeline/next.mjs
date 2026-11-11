import { MANIFEST, PHASE_ARTIFACTS } from "./artifacts.mjs";
import { CONFIRM_LINE, fixRoute, flatLine, planStageNumbers, planStageQa, qaWindow, sectionItems } from "./contract.mjs";
import { nextDefect } from "../../../../src/queue/pipeline-answer.mjs";
import { capped, terminationReason } from "./effects.mjs";

// What `run check` tells the orchestrator to do next: each stage of the plan is a front (coder → verifier → its QA), then the whole change is verified, run and published.

const MAX_FIX = MANIFEST.constants.maxFixIterations;
const FAILURES_MAX = 300;
const CONFIRM_QUESTION_PREFIX = `${CONFIRM_LINE} — `;
const DIAGNOSIS_INCOMPLETE = "the diagnosis is incomplete; look for the underestimated path (order of gates, preceding branch, race, data source)";
const PLAN_REVISED = "the plan was revised after a fix: design; implement the revision";
const NO_VERDICT = "verification produced no verdict";
const NO_NEW_ROUND = "wrote no new round after the last lane, so its failures stay open";
const WHOLE = "whole";
const TRIAGE_PHASE = PHASE_ARTIFACTS.get("01").phase;
const ARCHITECTURE_PHASE = PHASE_ARTIFACTS.get("03").phase;
const IMPLEMENTATION_PHASE =PHASE_ARTIFACTS.get("04").phase;
const QA_PHASE = PHASE_ARTIFACTS.get("05").phase;
const VERIFICATION_PHASE = PHASE_ARTIFACTS.get("06").phase;
const RUNTIME_PHASE = PHASE_ARTIFACTS.get("07").phase;
const RUNTIME_FIX_VERDICTS = new Set(["NOT-MET", "SYMPTOM-PERSISTS"]);
const FAILURE_HEADINGS = { "05": "## Proven breaks", "06": "## Failures", "07": "## Failures" };
const DURABLE_LOOPS = ["fix", "retriage", "stage", "fixPending", "final", "qaDone", "verified", "redesign", "counted", "unanswered"];
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

// Whether a value is a plain object.
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// A held PASSED mark, `{scope, impl}`, or null for any other shape.
function verifiedOf(held) {
  if (!isObject(held) || typeof held.scope !== "string" || typeof held.impl !== "string") return null;
  return { scope: held.scope, impl: held.impl };
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
  if (entry.phase === ARCHITECTURE_PHASE) return replay;
  const triggered = withTrigger(replay, entry);
  if (entry.phase === RUNTIME_PHASE) return { ...triggered, runtimeSeen: true };
  if (entry.phase === TRIAGE_PHASE && replay.runtimeSeen) return { ...triggered, retriage: 1 };
  return triggered;
}

// The fix and re-triage counts and the fix owed, replayed from the phases every attempt recorded.
function phaseLoops(phases) {
  const entries = Array.isArray(phases) ? phases.filter((entry) => entry !== null && typeof entry === "object") : [];
  const start = { fix: 0, retriage: 0, fixPending: false, trigger: null, runtimeSeen: false };
  const replay = entries.reduce(replayEntry, start);
  return { fix: replay.fix, retriage: replay.retriage, fixPending: replay.fixPending };
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
  const last = decisionsOf(state).at(-1);
  if (last === undefined) return phaseLoops(state?.phases);
  return { ...durableOf(last.loops), lastNext: isLatestCheck(state, last) ? last.next : null };
}

// The loops of this attempt from its cache, else the ones replayed from the run's records when the cache holds none or another attempt's.
function loopsOf(state) {
  const attempt = state?.lastClaim?.attempt ?? null;
  const held = state?.pipelineLoops;
  const usable = held !== null && typeof held === "object" && (held.attempt ?? null) === attempt;
  const loops = usable ? held : replayedLoops(state);
  return {
    attempt,
    missing: isObject(loops.missing) ? loops.missing : {},
    fix: countOf(loops.fix),
    retriage: countOf(loops.retriage),
    stage: isCount(loops.stage) ? loops.stage : null,
    final: loops.final === true,
    qaDone: loops.qaDone === true,
    verified: verifiedOf(loops.verified),
    redesign: loops.redesign === true,
    lastNext: actionOf(loops.lastNext),
    fixPending: loops.fixPending === true,
    counted: countedOf(loops.counted),
    unanswered: typeof loops.unanswered === "string" && loops.unanswered !== "" ? loops.unanswered : null,
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

// The stage of the front the run is in, the plan's first one when the held loops name none, null in the whole-change part or on a plan with no stages.
function frontStage(ctx) {
  return ctx.loops.final ? null : (ctx.loops.stage ?? ctx.fronts[0]);
}

// What the current verifier checks: `stage:<n>` in a staged front, else the whole change.
function scopeOf(ctx) {
  const stage = frontStage(ctx);
  return stage === null ? WHOLE : `stage:${stage}`;
}

// Whether the last PASSED covers a scope on the implementation as it is now.
function isVerified(verified, scope, impl) {
  return verified !== null && verified.scope === scope && verified.impl === impl;
}

// Whether a front is attacked by the QA: only `QA: none` skips it, read from its stage, or from the plan's first QA line with no stage.
function attacks(ctx, stage) {
  const word = stage === null ? [...ctx.qa.values()][0] : ctx.qa.get(stage);
  return word !== "none";
}

// The stages of the plan after a stage, none when the stage is unknown or the plan has no stages.
function stagesNotRun(ctx, stage) {
  if (stage === null) return [];
  return ctx.fronts.filter((number) => number !== null && number > stage);
}

// A `publish --draft` action that, on a stage row, also names the stages of the plan it leaves unrun.
function draftOnStage(ctx, stage, remaining) {
  const notRun = stagesNotRun(ctx, stage);
  return publishDraft(notRun.length === 0 ? remaining : `${remaining}; stages not run: ${notRun.join(", ")}`);
}

// The lines of the answer that start with a prefix.
function linesWith(ctx, prefix) {
  return ctx.result.lines.filter((line) => line.startsWith(prefix));
}

// Whether the answer's first line says a part is missing.
function isMissing(ctx) {
  return ctx.result.first.startsWith("MISSING");
}

// The `MISSING:` and `REPAIRED:` lines of the answer as one note.
function problemNote(ctx) {
  const lines = [...linesWith(ctx, "MISSING"), ...(ctx.repaired ? [ctx.repaired] : [])];
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

// The failures a negative round names, as one bounded line.
function failuresOf(ctx) {
  const file = PHASE_ARTIFACTS.get(ctx.key).file;
  const items = sectionItems(ctx.result.evaluated, FAILURE_HEADINGS[ctx.key], { fold: true });
  return capped(flatLine(items.length > 0 ? items.join("; ") : `${ctx.result.verdict}: see the last round of ${file}`), FAILURES_MAX);
}

// The text a negative report's `fix:` mark is read from: every QA round of this front, or the last round of the check.
function routeText(ctx) {
  return ctx.key === "05" ? qaWindow(ctx.raw) : ctx.result.evaluated;
}

// The front after this one: the plan's next stage, else the whole-change verification, skipped when its PASSED still holds.
function nextFront(ctx, { set = {}, note = null } = {}) {
  const current = frontStage(ctx);
  const following = current === null ? undefined : ctx.fronts.find((number) => number !== null && number > current);
  if (following !== undefined) return counted(launch("coder", { stage: following, note }), { ...set, stage: following, fix: 0, qaDone: false });
  const verified = set.verified ?? ctx.loops.verified;
  const whole = { ...set, final: true, fix: ctx.loops.final ? ctx.loops.fix : 0 };
  return counted(launch(isVerified(verified, WHOLE, ctx.implDigest) ? "runtime" : "verifier", { note }), whole);
}

// The fix of a negative round: the architect on `fix: design`, the coder otherwise; at the limit a stage stays open and the next front starts, and the whole change publishes a draft.
function fixRow(ctx, set = {}) {
  const failures = failuresOf(ctx);
  const stage = frontStage(ctx);
  if (ctx.loops.fix >= MAX_FIX) {
    if (stage === null) return counted(publishDraft(failures), set);
    return nextFront(ctx, { set, note: `stage ${stage} left open: ${failures}` });
  }
  const fix = ctx.loops.fix + 1;
  if (fixRoute(routeText(ctx)) === "design") return counted(launch("architect", { note: `fix: design — ${failures}` }), { ...set, fix, redesign: true });
  return counted(launch("coder-fix", { stage, note: `iteration ${fix}: ${failures}` }), { ...set, fix });
}

// What follows a PASSED of the current scope: the front's QA when owed, else the next front; in the whole-change part, the runtime.
function afterPassed(ctx, set = {}) {
  if (ctx.loops.final) return counted(launch("runtime"), set);
  const stage = frontStage(ctx);
  if (!ctx.loops.qaDone && attacks(ctx, stage)) return counted(launch("qa-triage", { stage }), set);
  return nextFront(ctx, { set });
}

// The brief: the triage is what writes it.
function briefNext() {
  return { action: launch("triager") };
}

// The triage: a relaunch, its verdict, or a re-triage's own limit.
function triageNext(ctx) {
  const { loops, result } = ctx;
  const retriaging = loops.retriage >= 1;
  if (isMissing(ctx)) {
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

// The first front of the plan the check read, every front fact starting over.
function firstFront(ctx) {
  const [first] = ctx.fronts;
  return { action: launch("coder", { stage: first }), set: { stage: first, fix: 0, qaDone: false, final: false, verified: null, redesign: false, unanswered: null } };
}

// The plan: one relaunch of a missing part, the one pause, the coder of a revised plan, the re-triage's coder, or the first front.
function planNext(ctx) {
  if (isMissing(ctx)) {
    const note = problemNote(ctx);
    if (!ctx.still) return missed(launch("architect", { note }));
    return missed(ctx.loops.retriage >= 1 ? publishDraft(note) : `terminate ${note}`);
  }
  const [question] = linesWith(ctx, CONFIRM_QUESTION_PREFIX);
  if (question !== undefined) return { action: `gate ${flatLine(question.slice(CONFIRM_QUESTION_PREFIX.length))}` };
  if (ctx.loops.redesign) return counted(launch("coder", { stage: frontStage(ctx), note: PLAN_REVISED }), { redesign: false });
  if (ctx.loops.retriage >= 1) return counted(launch("coder"), { final: true, fix: 0 });
  return firstFront(ctx);
}

// The implementation: nothing changed stops the run, else the verifier of the current scope, unless its PASSED already covers this implementation and no fix lane ran since.
function implementationNext(ctx) {
  if (isMissing(ctx)) return { action: `terminate ${flatLine(ctx.result.first)}` };
  if (!ctx.loops.fixPending && isVerified(ctx.loops.verified, scopeOf(ctx), ctx.implDigest)) {
    const { action, set } = afterPassed(ctx);
    return { action, set };
  }
  const note = ctx.result.first === "GENERATED" ? `the file list is in ${MANIFEST.fileListFallback}` : null;
  return { action: launch("verifier", { stage: frontStage(ctx), note }) };
}

// The QA triage of the front: its mode decides; a mode that stays unreadable falls to `lite`, and `skip` ends the front's QA.
function qaTriageNext(ctx) {
  const stage = frontStage(ctx);
  if (isMissing(ctx)) return missed(ctx.still ? launch("qa-lite", { stage }) : launch("qa-triage", { stage, note: problemNote(ctx) }));
  const mode = ctx.result.qaMode?.mode;
  if (mode === "skip") return nextFront(ctx, { set: { qaDone: true } });
  return { action: launch(mode === "full" ? "qa-analyst" : "qa-lite", { stage }) };
}

// The next front after a QA that stayed unreadable: the unanswered QA is named on the launch and kept for the publish.
function afterUnansweredQa(ctx) {
  const stage = frontStage(ctx);
  const what = `the QA of ${stage === null ? "the whole change" : `stage ${stage}`} never answered (${PHASE_ARTIFACTS.get("05").file})`;
  const unanswered = ctx.loops.unanswered === null ? what : `${ctx.loops.unanswered}; ${what}`;
  return { ...nextFront(ctx, { set: { qaDone: true, unanswered }, note: what }), missed: true };
}

// The publish of the change: a draft naming every QA that never answered, else the plain publish.
function publishAction(ctx) {
  return ctx.loops.unanswered === null ? "publish" : publishDraft(ctx.loops.unanswered);
}

// The QA analyst: its provers, or straight to the consolidation with no hypothesis; a round that stays unreadable ends the front's QA.
function qaAnalystNext(ctx) {
  if (isMissing(ctx)) {
    if (ctx.still) return afterUnansweredQa(ctx);
    return missed(launch("qa-analyst", { stage: frontStage(ctx), note: problemNote(ctx) }));
  }
  return { action: linesWith(ctx, "QA-STAGE: provers").length > 0 ? launch("qa-prover") : "check 05" };
}

// Whether this run's QA is the one-lane kind, whose relaunch is the same lane.
function isLiteQa(ctx) {
  return ctx.state?.qaMode?.mode === "lite" || (ctx.loops.lastNext ?? "").startsWith("launch qa-lite");
}

// The QA of the front: one relaunch of a missing round, then its verdict: NEEDS FIX takes the fix row, anything else the next front.
function qaNext(ctx) {
  if (isMissing(ctx)) {
    if (ctx.still) return afterUnansweredQa(ctx);
    return missed(launch(isLiteQa(ctx) ? "qa-lite" : "qa-analyst", { stage: frontStage(ctx), note: problemNote(ctx) }));
  }
  if (ctx.result.verdict === "NEEDS FIX") return fixRow(ctx, { qaDone: true });
  return nextFront(ctx, { set: { qaDone: true } });
}

// The verification of the current scope: one relaunch of a missing round, the row after a PASSED, or the fix row.
function verificationNext(ctx) {
  const stage = frontStage(ctx);
  if (isMissing(ctx)) return missed(ctx.still ? draftOnStage(ctx, stage, NO_VERDICT) : launch("verifier", { stage, note: problemNote(ctx) }));
  if (ctx.result.verdict === "FAILED") return fixRow(ctx);
  return afterPassed(ctx, { verified: { scope: scopeOf(ctx), impl: ctx.implDigest } });
}

// A symptom that persists with the plan applied: one re-triage, then a draft.
function retriageRow(ctx) {
  if (ctx.loops.retriage >= 1) return counted(publishDraft("the symptom persists after the re-triage"));
  return counted(launch("triager", { note: DIAGNOSIS_INCOMPLETE }), { retriage: 1 });
}

// The runtime lane: one relaunch of a missing round, the re-triage of a persisting symptom, the fix row of a NOT-MET, else publish.
function runtimeNext(ctx) {
  if (isMissing(ctx)) return missed(ctx.still ? publishAction(ctx) : launch("runtime", { note: problemNote(ctx) }));
  if (ctx.result.verdict === "SYMPTOM-PERSISTS") return retriageRow(ctx);
  if (ctx.result.verdict === "NOT-MET") return fixRow(ctx);
  return { action: publishAction(ctx) };
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
  "05": (ctx, note) => launch(isLiteQa(ctx) ? "qa-lite" : "qa-analyst", { stage: frontStage(ctx), note }),
  "06": (ctx, note) => launch("verifier", { stage: frontStage(ctx), note }),
  "07": (_ctx, note) => launch("runtime", { note }),
};

// What a counted row answers on a text unchanged since another check ran: the row after a PASSED that still holds, else its own lane once, then a draft.
function unchangedStep(ctx, unchanged) {
  if (ctx.key === "06" && isVerified(ctx.loops.verified, scopeOf(ctx), ctx.implDigest)) return afterPassed(ctx);
  const relaunch = UNCHANGED_RELAUNCHES[ctx.key];
  if (unchanged === 0 && relaunch !== undefined) return counted(relaunch(ctx, `${PHASE_ARTIFACTS.get(ctx.key).file} unchanged since the last check`), {}, 1);
  return counted(draftOnStage(ctx, frontStage(ctx), `check ${ctx.key} ${NO_NEW_ROUND}`), {}, 2);
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

// The fronts of a plan: each of its stages when it has two or more, else one front with no stage.
function frontsOf(plan) {
  const stages = planStageNumbers(plan);
  return stages.length >= 2 ? stages : [null];
}

// The `NEXT:` action of a check's answer, the loops it leaves and the decision it records; a re-run of a counted row on the same text repeats its action, burns no iteration and records nothing, and the same text after another check ran relaunches its lane once, then ends in a draft.
export function nextOf({ result, repaired, state, memo, plan, implDigest = "", raw = "" }) {
  const loops = loopsOf(state);
  const { key, digest } = memo;
  const sameText = loops.counted?.key === key && loops.counted?.digest === digest;
  const unchanged = sameText ? countOf(loops.counted.unchanged) : 0;
  if (sameText && unchanged === 0 && loops.lastNext === loops.counted.next) return { action: loops.counted.next, loops, decision: null };
  const fronts = frontsOf(plan);
  const qa = planStageQa(plan);
  const ctx = { result, repaired, state, loops, key, digest, implDigest, raw, still: countOf(loops.missing[key]) >= 1, fronts, qa };
  const step = sameText ? unchangedStep(ctx, unchanged) : ROWS[key](ctx);
  const settled = settledLoops(ctx, step);
  return { action: step.action, loops: settled, decision: decisionOf(ctx, step, settled) };
}
