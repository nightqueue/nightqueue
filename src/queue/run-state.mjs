import { UserError } from "../config/errors.mjs";
import { withLockSync, withPathLock } from "../config/lock.mjs";
import { runDir } from "../config/paths.mjs";
import { truncateByCodePoint } from "../memory/jobs.mjs";
import { jobRef } from "../memory/refs.mjs";
import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { COMMIT_TYPES } from "./branch-name.mjs";
import {
  claimStamp,
  foreignStampOf,
  isRunPath,
  isStateObject,
  outcomeHostFacts,
  readRunState,
  RESUME_PHASE_ORDER,
  RESUME_SCHEMA_VERSION,
  RUN_LOCK,
  saveRunState,
  stampedAttempt,
  stampOrder,
  underRunLock,
} from "./resume.mjs";
import { isPrUrl } from "./stream.mjs";

// The only outcomes the pipeline may record in `state.json` (a delivery, a gate, or a deliberate conclusion that no code change is needed); how the process ended stays the runtime's call.
export const RUN_OUTCOME_STATUSES = ["done", "gate", "no_change"];

// The outcome of a run that concluded on purpose that no code change is needed: the job ends `done` with no pull request.
export const NO_CHANGE_OUTCOME = "no_change";

// The keys of `state.json` only the runtime writes: no pipeline writer may set them, whole or by a dotted name.
export const RUNTIME_ONLY_KEYS = ["job", "gateQuestionDigest", "draftPrUrl", "qaMode", "pipeline", "freshRetry", "pipelineUnpinned"];

// The QA modes a triage may decide.
const QA_MODES = ["skip", "lite", "full"];

// Why a second record of the same job's block is kept: the block is written once, and a retry keeps the first one.
export const JOB_BLOCK_ALREADY_RECORDED = "already recorded";

// Where the pull request template of a run came from: the repository's own, or nightqueue's fallback.
const PR_TEMPLATE_SOURCES = ["repo", "nightqueue"];

// The only sub-phase of the pipeline with a record of its own: a top-level marker, never an entry of `phases`.
const QA_STAGE_A = "qaStageA";

// The one numeric field of the run: the evidence level the triage reached, 1 to 4.
const EVIDENCE_LEVEL = "evidenceLevel";

// The fields of the run itself a phase may still discover, each with the values it accepts (`null` means any text).
const RUN_FIELDS = {
  type: PIPELINE_TASK_TYPES,
  branch: null,
  worktree: null,
  [QA_STAGE_A]: null,
  origin: ["operator"],
  [EVIDENCE_LEVEL]: [1, 2, 3, 4],
  planStatus: ["draft", "approved"],
  commitType: COMMIT_TYPES,
};

// Who may record a skip through `run_skip`: the pipeline's own agents.
export const SKIP_AGENTS = ["orchestrator", "triager", "explore", "architect", "coder", "qa-guardian", "verifier"];

// The author of the phase entries the runtime writes itself (`run check`, `run publish`).
export const RUNTIME_AUTHOR = "runtime";

// How many records one attempt keeps in `ignoredRecords`, and the longest late record kept whole: a session that outlived its claim cannot grow `state.json`.
const LATE_RECORDS_PER_ATTEMPT = 5;
const LATE_RECORD_TEXT_LIMIT = 4096;

// The answer of a consumption that found nothing to consume, with the same shape as a write.
const NOTHING_CONSUMED = { status: "absent", path: null, reason: null };

// Refusal to record, always with the same shape as a write.
function kept(reason) {
  return { status: "kept", path: null, reason };
}

// Refusal naming every accepted value, so a wrong enum is fixed on the next call instead of repeated.
function refuseEnum(field, value, accepted) {
  return kept(`unknown ${field} \`${String(value)}\`; accepted: ${accepted.join(", ")}`);
}

// A text field of the record: the trimmed value, or null when there is nothing to record.
function trimmedText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

// The record with its optional text fields dropped, so state.json never carries an empty key.
function withText(record, fields) {
  const filled = Object.entries(fields).filter(([, value]) => trimmedText(value) !== null);
  return { ...record, ...Object.fromEntries(filled.map(([name, value]) => [name, trimmedText(value)])) };
}

// The state as every writer needs it: the fields the contract fixes, over whatever the file already held.
function withFixedFields(state, { projectId, slug }) {
  const held = isStateObject(state) ? state : {};
  const resumeCount = Number.isInteger(held.resumeCount) && held.resumeCount >= 0 ? held.resumeCount : 0;
  return { ...held, schemaVersion: RESUME_SCHEMA_VERSION, projectId, slug, resumeCount };
}

// Runs an action on one run's files under the same lock as its state.json; never call a `record*` inside it, the lock is not re-entrant.
export function withRunLock({ projectId, slug, env = process.env }, action) {
  if (!isRunPath(projectId, slug)) throw new UserError(`unsafe project or slug: \`${projectId}\`/\`${slug}\``);
  return withLockSync(`${runDir(projectId, slug, env)}.lock`, action, RUN_LOCK);
}

// The runtime-only key a field name writes, whole (`job`) or dotted (`job.id`), or null when it names none.
function runtimeOnlyKey(name) {
  return RUNTIME_ONLY_KEYS.find((key) => name === key || String(name).startsWith(`${key}.`)) ?? null;
}

// A pipeline change with every runtime-only key dropped, so the runtime's own record survives any writer.
function withoutRuntimeKeys(change) {
  return Object.fromEntries(Object.entries(isStateObject(change) ? change : {}).filter(([name]) => runtimeOnlyKey(name) === null));
}

// The record with the stamp of the claim that wrote it, never whether that claim was over; a writer with no claim stamps nothing.
function withStamp(entry, claim) {
  return isStateObject(claim) ? { ...entry, claim: claimStamp(claim) } : entry;
}

// The records a run set aside, as a list.
function ignoredEntries(state) {
  return Array.isArray(state.ignoredRecords) ? state.ignoredRecords : [];
}

// Tells whether the slot holds a record of a later claim than the writer's; only `outcome` and `termination` are slots.
function newerClaimHolds(slot, claim) {
  return isStateObject(claim) && stampOrder(slot, claim) > 0;
}

// Tells whether the slot holds a record of an earlier claim than the writer's, which the new record replaces.
function isDisplacedBy(slot, claim) {
  return isStateObject(claim) && stampOrder(slot, claim) < 0;
}

// The change that moves a displaced slot's record to the ignored ones, or nothing when the slot holds none.
function displacedSlot(state, kind, claim, at) {
  if (!isDisplacedBy(state[kind], claim)) return {};
  const { claim: heldClaim, ...heldRecord } = state[kind];
  return { ignoredRecords: [...ignoredEntries(state), { kind, at, claim: heldClaim, record: heldRecord }] };
}

// A late record as `ignoredRecords` keeps it: whole up to the text limit, past it the start of its JSON.
function boundedLateRecord(record) {
  const text = JSON.stringify(record);
  return text.length <= LATE_RECORD_TEXT_LIMIT ? record : { truncated: truncateByCodePoint(text, LATE_RECORD_TEXT_LIMIT) };
}

// The ignored entries after one late write: kept up to its attempt's cap, then only counted on that attempt's last entry; nothing already held is evicted, so a looping session cannot grow the file or hide an attempt.
function entriesWithLate(entries, entry) {
  const ofAttempt = entries.filter((held) => stampedAttempt(held) === entry.claim.attempt);
  if (ofAttempt.length < LATE_RECORDS_PER_ATTEMPT) return [...entries, { ...entry, record: boundedLateRecord(entry.record) }];
  const last = ofAttempt.at(-1);
  return entries.map((held) => (held === last ? { ...held, notKept: (held.notKept ?? 0) + 1 } : held));
}

// Sets a late write aside, touching no slot and no phase, and answers the refusal that tells its writer the claim is over.
function setLateRecordAside({ projectId, slug, env, state, claim, late, at }) {
  const ignoredRecords = entriesWithLate(ignoredEntries(state), { kind: late.kind, at, claim, record: late.record });
  const saved = saveRunState({ projectId, slug, env, state: { ...state, ignoredRecords, updatedAt: at } });
  const refusal = `attempt ${claim.attempt} of this job is over, so this record is ignored; end this session`;
  return kept(saved.status === "written" ? refusal : `${refusal} (it could not be kept either: ${saved.reason})`);
}

// The state with the runtime's own fields applied: a null drops the key and an undefined leaves it alone.
function withRuntimeFields(state, runtimeFields) {
  const next = { ...state };
  for (const [name, value] of Object.entries(runtimeFields)) {
    if (value === null) delete next[name];
    else if (value !== undefined) next[name] = value;
  }
  return next;
}

// Writes one change into the state.json of a run, with the runtime's own fields in the same write: the runtime stamps the time, an `updatedAt` written by an agent is overwritten, never trusted, and a `late` record of a claim that is over is set aside instead.
function record({ projectId, slug, env, change, runtimeFields = {}, claim = null, late = null }) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const at = new Date().toISOString();
      const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
      if (late !== null && (claim?.over === true || newerClaimHolds(state[late.kind], claim))) {
        return setLateRecordAside({ projectId, slug, env, state, claim, late, at });
      }
      return saveRunState({ projectId, slug, env, state: { ...withRuntimeFields({ ...state, ...withoutRuntimeKeys(change(state, at)) }, runtimeFields), updatedAt: at } });
    },
  });
}

// The phase entries a state holds, as a list.
function phaseEntries(state) {
  return Array.isArray(state?.phases) ? state.phases : [];
}

// The last entry `phases` holds for one phase, or null when the phase was never recorded.
function lastEntryOf(phases, phase) {
  return [...phases].reverse().find((entry) => isStateObject(entry) && entry.phase === phase) ?? null;
}

// The index of the runtime's entry a plain `run_phase_done` call repeats (same phase, last entry, same or no artifact), or -1 when the call appends.
function repeatedRuntimeEntry(phases, { phase, artifact, by, reason }) {
  if (trimmedText(by) !== null || trimmedText(reason) !== null) return -1;
  const index = phases.length - 1;
  const last = phases[index];
  if (!isStateObject(last) || last.phase !== phase || last.by !== RUNTIME_AUTHOR) return -1;
  const sent = trimmedText(artifact);
  return sent === null || sent === last.artifact ? index : -1;
}

// The phases after one phase record: a repeat of the runtime's own entry merges into it, anything else is appended.
function phasesWithRecord(phases, { phase, artifact, verdict, note, reason, by, claim }, at) {
  const repeated = repeatedRuntimeEntry(phases, { phase, artifact, by, reason });
  if (repeated >= 0) return phases.map((entry, index) => (index === repeated ? withText(entry, { verdict, note }) : entry));
  return [...phases, withStamp(withText({ phase, at }, { artifact, verdict, note, reason, by }), claim)];
}

// Records a phase the pipeline completed; the list is append-only, so a phase recorded twice never erases the first record.
export function recordPhaseDone({ projectId, slug, phase, artifact, verdict, note, reason, by, claim = null, env = process.env } = {}) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  return record({
    projectId,
    slug,
    env,
    claim,
    late: { kind: "phase", record: withText({ phase }, { artifact, verdict, note, reason, by }) },
    change: (state, at) => ({ phases: phasesWithRecord(phaseEntries(state), { phase, artifact, verdict, note, reason, by, claim }, at) }),
  });
}

// The check memos a state holds, keyed by check.
function checkMemos(state) {
  return isStateObject(state?.checks) ? state.checks : {};
}

// The memos after one check: its own entry replaced and, when it did not pass, the run's last failure.
function memosWithCheck(checks, check, memo, at) {
  const entry = { line: String(memo.line ?? ""), ok: memo.ok === true, completed: memo.completed === true, digest: String(memo.digest ?? ""), at };
  return { ...checks, [check]: entry, ...(entry.ok ? {} : { lastFailure: { check, line: entry.line, at } }) };
}

// Why a phase a check completes is recorded again: the failure the same check answered before, else what failed since the phase's last record.
function reRunReason({ previous, phases, phase, lastFailure }) {
  if (isStateObject(previous) && previous.ok === false && trimmedText(previous.line) !== null) return previous.line;
  const last = lastEntryOf(phases, phase);
  if (last === null) return null;
  const failedSince = isStateObject(lastFailure) && String(lastFailure.at ?? "") > String(last.at ?? "");
  return failedSince ? `re-run after ${lastFailure.check} ${lastFailure.line}` : "re-run";
}

// Whether a completed check repeats the runtime's last entry of the phase: a decision while that entry states it, any other check on the same artifact.
function repeatsRuntimeEntry({ previous, memo, done, last }) {
  if (last?.by !== RUNTIME_AUTHOR) return false;
  if (done.decision === true) return last.verdict === done.verdict;
  return isStateObject(previous) && previous.completed === true && previous.digest === memo.digest;
}

// The phases after a completed check, and what was decided: `already` when it repeats the runtime's last entry, else `appended` with its reason.
function phasesAfterCheck({ state, check, memo, done, claim, at }) {
  const phases = phaseEntries(state);
  const checks = checkMemos(state);
  const previous = checks[check];
  if (repeatsRuntimeEntry({ previous, memo, done, last: lastEntryOf(phases, done.phase) })) return { phases, decided: { status: "already", reason: null } };
  const reason = trimmedText(done.reason) ?? reRunReason({ previous, phases, phase: done.phase, lastFailure: checks.lastFailure });
  const entry = withStamp(withText({ phase: done.phase, at }, { artifact: done.artifact, verdict: done.verdict, note: done.note, reason, by: RUNTIME_AUTHOR }), claim);
  return { phases: [...phases, entry], decided: { status: "appended", reason } };
}

// Records the answer of one `run check` and, when it completed a phase, the phase itself, in one write so the reason reads the memo it replaces.
export function recordCheck({ projectId, slug, check, memo, done = null, claim = null, env = process.env } = {}) {
  if (trimmedText(check) === null || !isStateObject(memo)) return kept("a check record needs its check and its memo");
  if (done !== null && !RESUME_PHASE_ORDER.includes(done?.phase)) return refuseEnum("phase", done?.phase, RESUME_PHASE_ORDER);
  let decided = null;
  const written = record({
    projectId,
    slug,
    env,
    claim,
    late: { kind: "check", record: { check, memo, done } },
    change: (state, at) => {
      const checks = memosWithCheck(checkMemos(state), check, memo, at);
      if (done === null) return { checks };
      const after = phasesAfterCheck({ state, check, memo, done, claim, at });
      decided = after.decided;
      return { checks, phases: after.phases };
    },
  });
  return { ...written, phase: written.status === "written" ? decided : null };
}

// Whether a phase entry is the runtime's record of a QA skip.
function isRuntimeQaSkip(entry) {
  return isStateObject(entry) && entry.phase === "qa" && entry.by === RUNTIME_AUTHOR && entry.verdict === "SKIPPED";
}

// Whether a QA mode leaves a recorded skip behind: a lite or full decision on a state that still holds one.
export function leavesStaleQaSkip(state, mode) {
  return mode !== "skip" && phaseEntries(state).some(isRuntimeQaSkip);
}

// Records the QA mode the triage decided and its reason, a key only the runtime writes; in the same write a lite or full decision drops the skip it supersedes.
export function recordQaMode({ projectId, slug, mode, reason, env = process.env } = {}) {
  if (!QA_MODES.includes(mode)) return refuseEnum("QA mode", mode, QA_MODES);
  const why = trimmedText(reason);
  if (why === null) return kept("a QA mode needs its reason");
  const change = (state) => (leavesStaleQaSkip(state, mode) ? { phases: phaseEntries(state).filter((entry) => !isRuntimeQaSkip(entry)) } : {});
  return record({ projectId, slug, env, change, runtimeFields: { qaMode: { mode, reason: why, at: new Date().toISOString() } } });
}

// Records that the run stopped on purpose at a phase; a retry consumes the stop, and whether the run resumes is `decideResume`'s call.
export function recordTermination({ projectId, slug, phase, reason, by, wip = null, claim = null, env = process.env } = {}) {
  const refused = terminationRefusal(phase, reason);
  if (refused) return refused;
  const stop = withText({ phase, reason: trimmedText(reason) }, { by });
  return record({
    projectId,
    slug,
    env,
    claim,
    late: { kind: "termination", record: isStateObject(wip) ? { ...stop, wip } : stop },
    change: (state, at) => ({
      termination: withStamp(withText({ phase, reason: trimmedText(reason), at }, { by }), claim),
      ...(isStateObject(wip) ? { wip: { ...wip, at } } : {}),
      ...displacedSlot(state, "termination", claim, at),
    }),
  });
}

// Why a termination cannot be recorded (an unknown phase or no reason), or null when it can.
export function terminationRefusal(phase, reason) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  if (trimmedText(reason) === null) return kept("a termination needs a reason: it is what the operator reads in the queue");
  return null;
}

// Records what the runtime did with a terminated run's work (its wip commit, or why there is none).
export function recordWip({ projectId, slug, wip, env = process.env } = {}) {
  if (!isStateObject(wip)) return kept("a wip record needs the wip commit's result");
  return record({ projectId, slug, env, change: (_state, at) => ({ wip: { ...wip, at } }) });
}

// Whether the state holds a termination of that author (and of that phase, when one is named).
function holdsTermination(state, { phase, onlyBy }) {
  const termination = isStateObject(state) ? state.termination : null;
  return isStateObject(termination) && termination.by === onlyBy && (phase === null || termination.phase === phase);
}

// Lifts a termination the given author wrote (the runtime's by default), so a stop answered or contradicted later no longer refuses the resume.
export function clearTermination({ projectId, slug, phase = null, onlyBy = RUNTIME_AUTHOR, env = process.env } = {}) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const state = readRunState({ projectId, slug, env });
      if (!holdsTermination(state, { phase, onlyBy })) return { status: "absent", path: null, reason: null };
      const { termination: _lifted, ...rest } = state;
      return saveRunState({ projectId, slug, env, state: { ...rest, updatedAt: new Date().toISOString() } });
    },
  });
}

// What an outcome write starts from: the host facts alone over a displaced record, so an old notice never merges into the new one, else the record as held without its old stamp.
function outcomeToKeep(state, claim) {
  if (!isStateObject(state.outcome)) return {};
  if (isDisplacedBy(state.outcome, claim)) return outcomeHostFacts(state.outcome);
  const { claim: _stamp, ...held } = state.outcome;
  return held;
}

// How many failures a delivery leaves open, in the words of the sentence that names them.
function failuresRemain(failures) {
  return failures === 1 ? "1 failure remains" : `${failures} failures remain`;
}

// The line naming a draft delivery and the failures it leaves open, with the pull request's URL when the caller has it.
export function draftLine(failures, url = "") {
  return `draft pull request ${url ? `${url} ` : ""}— ${failuresRemain(failures)}`;
}

// The line naming a normal pull request opened because gh refused the draft, and the failures it leaves open.
export function refusedDraftLine(failures, url = "") {
  return `pull request ${url ? `${url} ` : ""}— ${failuresRemain(failures)} (gh refused the draft)`;
}

// Whether a value is a count of failures a delivery can record.
function isFailureCount(failures) {
  return Number.isInteger(failures) && failures > 0;
}

// An outcome without any earlier draft record, carrying this call's own: the failures whenever they remain, the draft only when the pull request really is one.
function withDraftRecord(outcome, { draft, failures, staysDraft }) {
  const { draft: _draft, draftFailures: _draftFailures, staysDraft: _staysDraft, ...rest } = outcome;
  return {
    ...rest,
    ...(draft === true ? { draft: true } : {}),
    ...(isFailureCount(failures) ? { draftFailures: failures } : {}),
    ...(staysDraft === true ? { staysDraft: true } : {}),
  };
}

// Records how the run ended (with the files it delivered when known) and, at the top level of the state where they outlive the outcome the next attempt clears, the digest of the question a pause showed and the draft the run opened (each dropped by a null, left alone when not sent); the pull request URL is the runtime's to write, so an outcome already carrying one keeps it.
export function recordOutcome({ projectId, slug, status, notice, files, questionDigest, draft = false, failures = 0, draftPrUrl, staysDraft = false, claim = null, env = process.env } = {}) {
  if (!RUN_OUTCOME_STATUSES.includes(status)) return refuseEnum("status", status, RUN_OUTCOME_STATUSES);
  if (status === NO_CHANGE_OUTCOME && trimmedText(notice) === null) {
    return kept("a no_change outcome needs the run's conclusion as its notice: it is what the origins are told on close");
  }
  if (draft === true && !isFailureCount(failures)) return kept(`a draft outcome needs a positive failure count, not \`${String(failures)}\``);
  return record({
    projectId,
    slug,
    env,
    claim,
    late: { kind: "outcome", record: withText({ status }, { notice }) },
    change: (state, at) => ({
      outcome: withStamp(withText(withDraftRecord({ ...outcomeToKeep(state, claim), status, at, ...(Array.isArray(files) ? { files } : {}) }, { draft, failures, staysDraft }), { notice }), claim),
      ...displacedSlot(state, "outcome", claim, at),
    }),
    runtimeFields: { gateQuestionDigest: questionDigest, draftPrUrl },
  });
}

// Tells whether a retry of this claim consumes the record: a stamp of an earlier claim belongs to one already over, and it stays on disk.
function isConsumable(record, claim) {
  return !Number.isInteger(claim.attempt) || stampOrder(record, claim) >= 0;
}

// Tells whether the state holds what the last claim concluded: a recorded status or notice, a termination, or the terminal witness; a published pull request alone is a fact about the host.
function holdsAttemptConclusion(state, claim) {
  if (!isStateObject(state)) return false;
  const outcome = isStateObject(state.outcome) ? state.outcome : {};
  const holdsOutcome = (outcome.status !== undefined || outcome.notice !== undefined) && isConsumable(outcome, claim);
  const holdsSlot = (slot) => slot !== undefined && isConsumable(slot, claim);
  return holdsOutcome || holdsSlot(state.termination) || holdsSlot(state.terminal);
}

// The state without what the last claim concluded: the facts of its publication, its phases, its work and every older claim's record stay.
function withoutAttemptConclusion(state, claim) {
  const { termination, terminal, ...rest } = state;
  if (termination !== undefined && !isConsumable(termination, claim)) rest.termination = termination;
  if (terminal !== undefined && !isConsumable(terminal, claim)) rest.terminal = terminal;
  if (isStateObject(state.outcome) && isConsumable(state.outcome, claim)) rest.outcome = outcomeHostFacts(state.outcome);
  return rest;
}

// Consumes, in one write under the run lock, what the last claim concluded, only while `stillCurrent` holds; a run another job stamped answers `foreign` with that job, so nothing speaks for the next attempt and nothing a later claim recorded is erased.
export async function consumeRunConclusion({ projectId, slug, jobId, attempt = null, ordinal = null, env = process.env, stillCurrent = async () => true } = {}) {
  const claim = { attempt, ordinal };
  const first = readRunState({ projectId, slug, env });
  if (foreignStampOf(first, jobId) === null && !holdsAttemptConclusion(first, claim)) return NOTHING_CONSUMED;
  try {
    return await withPathLock(`${runDir(projectId, slug, env)}.lock`, async () => {
      if (!(await stillCurrent())) return { status: "moved", path: null, reason: null };
      const state = readRunState({ projectId, slug, env });
      const stampedBy = foreignStampOf(state, jobId);
      if (stampedBy !== null) return { status: "foreign", path: null, reason: null, stampedBy };
      if (!holdsAttemptConclusion(state, claim)) return NOTHING_CONSUMED;
      return saveRunState({ projectId, slug, env, state: { ...withoutAttemptConclusion(state, claim), updatedAt: new Date().toISOString() } });
    }, RUN_LOCK);
  } catch (err) {
    return kept(String(err?.message ?? err).split("\n")[0]);
  }
}

// What a pull request record starts from: with no claim the outcome as held, stamp included, else what an outcome of that claim would keep.
function outcomeUnderPrUrl(state, claim) {
  if (isStateObject(claim)) return outcomeToKeep(state, claim);
  return isStateObject(state.outcome) ? state.outcome : {};
}

// Records the pull request of the run and, when known, its title, for the claim that published it; both are the runtime's and the agent never sends them as a parameter.
export function recordPrUrl({ projectId, slug, prUrl, prTitle, claim = null, env = process.env } = {}) {
  if (!isPrUrl(prUrl)) return kept(`\`${String(prUrl)}\` is not a pull request URL`);
  return record({
    projectId,
    slug,
    env,
    claim,
    late: { kind: "outcome", record: withText({ prUrl }, { prTitle }) },
    change: (state, at) => ({
      outcome: withStamp(withText({ ...outcomeUnderPrUrl(state, claim), prUrl, at }, { prTitle }), claim),
      ...displacedSlot(state, "outcome", claim, at),
    }),
  });
}

// Refusal of a pull request template the record cannot trust, or null when its shape is the one state.json keeps.
function invalidPrTemplate(template) {
  if (!isStateObject(template) || !PR_TEMPLATE_SOURCES.includes(template.source)) {
    return refuseEnum("template source", template?.source, PR_TEMPLATE_SOURCES);
  }
  if (!Array.isArray(template.headings) || !template.headings.every((heading) => typeof heading === "string")) {
    return kept("the template `headings` must be an array of heading lines");
  }
  return template.source === "repo" && trimmedText(template.path) === null ? kept("a repository template needs its `path`") : null;
}

// Records the pull request template the runtime found for the run, the one Phase 8 writes the body for; the latest call wins.
export function recordPrTemplate({ projectId, slug, template, env = process.env } = {}) {
  const refused = invalidPrTemplate(template);
  if (refused) return refused;
  const { source, headings, path } = template;
  return record({ projectId, slug, env, change: (_state, at) => ({ prTemplate: withText({ source, headings, at }, { path }) }) });
}

// Refusal of a QA stage A marker without the artifact the resume decision reads to re-enter the QA phase at stage B.
function invalidQaStageA(value) {
  const artifact = isStateObject(value) ? trimmedText(value.artifact) : null;
  return artifact === null ? kept(`field \`${QA_STAGE_A}\` needs the \`artifact\` of the stage A report`) : null;
}

// Refusal of a field `run_set` does not own, or of a value outside the enum of a field that has one.
function invalidRunField([name, value]) {
  const reserved = runtimeOnlyKey(name);
  if (reserved !== null) return kept(`\`${reserved}\` is written by the runtime only`);
  if (!(name in RUN_FIELDS)) return refuseEnum("field", name, Object.keys(RUN_FIELDS));
  if (name === QA_STAGE_A) return invalidQaStageA(value);
  const accepted = RUN_FIELDS[name];
  if (name === EVIDENCE_LEVEL) return Number.isInteger(value) && accepted.includes(value) ? null : refuseEnum(name, value, accepted);
  if (accepted && !accepted.includes(value)) return refuseEnum(name, value, accepted);
  return trimmedText(value) === null ? kept(`field \`${name}\` cannot be empty`) : null;
}

// The fields as state.json keeps them: the text ones trimmed, the evidence level as its number, and the QA stage A marker stamped by the runtime.
function runFieldsRecord(fields, at) {
  const { [QA_STAGE_A]: marker, [EVIDENCE_LEVEL]: evidenceLevel, ...text } = fields;
  const written = { ...withText({}, text), ...(evidenceLevel === undefined ? {} : { [EVIDENCE_LEVEL]: evidenceLevel }) };
  if (!marker) return written;
  return { ...written, [QA_STAGE_A]: withText({ artifact: trimmedText(marker.artifact), at }, { verdict: marker.verdict }) };
}


// Records the fields of the run a phase discovered: its type, where its code lives and the QA stage it already paid for.
export function recordRunFields({ projectId, slug, fields, claim = null, env = process.env } = {}) {
  const changes = isStateObject(fields) ? fields : {};
  const entries = Object.entries(changes);
  if (entries.length === 0) return kept(`no field to record; accepted: ${Object.keys(RUN_FIELDS).join(", ")}`);
  const refused = entries.map(invalidRunField).find(Boolean);
  if (refused) return refused;
  return record({ projectId, slug, env, claim, late: { kind: "fields", record: changes }, change: (_state, at) => runFieldsRecord(changes, at) });
}

// Refusal of a skip `run_skip` cannot record, or null when its phase, author and reason are the ones state.json keeps.
function invalidSkip({ phase, by, reason }) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  if (!SKIP_AGENTS.includes(by)) return refuseEnum("by", by, SKIP_AGENTS);
  return trimmedText(reason) === null ? kept("a skip needs a reason: it is what the studio track shows on the slot") : null;
}

// Writes one agent skip into the run's state.json, refused when the phase already ran.
function saveSkip({ projectId, slug, phase, skip, env }) {
  const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
  const ran = Array.isArray(state.phases) && state.phases.some((entry) => entry?.phase === phase);
  if (ran) return kept(`\`${phase}\` already ran: only a later phase can be skipped`);
  const skips = { ...(isStateObject(state.skips) ? state.skips : {}), [phase]: skip };
  return saveRunState({ projectId, slug, env, state: { ...state, skips, updatedAt: skip.at } });
}

// Sets aside the skip of a claim that is over, in the same list as every other late record.
function setLateSkipAside({ projectId, slug, phase, skip, claim, env }) {
  const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
  const { at, ...fields } = skip;
  return setLateRecordAside({ projectId, slug, env, state, claim, late: { kind: "skip", record: { phase, ...fields } }, at });
}

// Records that an agent skips a later phase, for display only: routing and resume never read it.
export function recordSkip({ projectId, slug, phase, by, reason, claim = null, env = process.env } = {}) {
  const refused = invalidSkip({ phase, by, reason });
  if (refused) return refused;
  const skip = { by, reason: trimmedText(reason), at: new Date().toISOString() };
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => (claim?.over === true ? setLateSkipAside({ projectId, slug, phase, skip, claim, env }) : saveSkip({ projectId, slug, phase, skip, env })),
  });
}

// Sets where the code of a run lives to what git actually holds: `branch` and `worktree` each recorded, or dropped when null.
export function recordHeldWorktree({ projectId, slug, branch = null, worktree = null, env = process.env } = {}) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const at = new Date().toISOString();
      const held = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
      const rest = Object.fromEntries(Object.entries(held).filter(([name]) => name !== "branch" && name !== "worktree"));
      return saveRunState({ projectId, slug, env, state: { ...withText(rest, { branch, worktree }), updatedAt: at } });
    },
  });
}

// Records the linked worktree a job was queued to start in as where its code lives, marked as adopted so the runtime never removes it; one write.
export function recordAdoptedWorktree({ projectId, slug, branch, worktree, env = process.env } = {}) {
  const held = { branch: trimmedText(branch), worktree: trimmedText(worktree) };
  if (held.branch === null || held.worktree === null) return kept("an adopted worktree needs its branch and its path");
  return record({ projectId, slug, env, change: () => ({ ...held, adoptedWorktree: held.worktree }) });
}

// The resume count over the state already on disk: a run the pipeline never recorded anything into is not created by a resume.
function saveResumeCount({ projectId, slug, resumeCount, env }) {
  const state = readRunState({ projectId, slug, env });
  if (!isStateObject(state)) return kept("there is no state.json to record the resume into");
  return saveRunState({ projectId, slug, env, state: { ...state, resumeCount, updatedAt: new Date().toISOString() } });
}

// Records the resume the runtime decided on: the only writer of `resumeCount`, which the agent never touches again.
export function recordResume({ projectId, slug, resumeCount, env = process.env } = {}) {
  if (!Number.isInteger(resumeCount) || resumeCount < 0) {
    return kept(`resumeCount must be a non-negative integer, got \`${String(resumeCount)}\``);
  }
  return underRunLock({ projectId, slug, env, write: () => saveResumeCount({ projectId, slug, resumeCount, env }) });
}

// Refusal of a job block the run could not identify itself by, or null when its shape is the one state.json keeps.
function invalidJobBlock(block) {
  if (!isStateObject(block) || !Number.isSafeInteger(block.id) || block.id <= 0) return kept("a job block needs the positive integer `id` of its job");
  if (trimmedText(block.createdAt) === null) return kept("a job block needs its `createdAt`");
  return null;
}

// The job block as state.json keeps it: exactly its four fields, an absent project key recorded as null.
function jobBlockRecord(block) {
  return {
    id: block.id,
    ref: trimmedText(block.ref) ?? jobRef(block.id),
    projectKey: trimmedText(block.projectKey),
    createdAt: trimmedText(block.createdAt),
  };
}

// Writes the job block into the run's state.json once: the same job keeps its first record, and another job's run is never claimed.
function saveJobBlock({ projectId, slug, block, env }) {
  const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
  const held = isStateObject(state.job) ? state.job : null;
  if (held !== null && held.id === block.id) return kept(JOB_BLOCK_ALREADY_RECORDED);
  if (held !== null) return kept(`the run directory belongs to ${jobRef(held.id)}`);
  return saveRunState({ projectId, slug, env, state: { ...state, job: jobBlockRecord(block), updatedAt: new Date().toISOString() } });
}

// The pipeline a run with recorded phases started under, its name null when it recorded none; null when no version is recorded or no phase ran yet.
export function pinnedPipeline(state) {
  const version = isStateObject(state?.pipeline) ? trimmedText(state.pipeline.version) : null;
  if (version === null || phaseEntries(state).length === 0) return null;
  return { name: trimmedText(state.pipeline.name), version };
}

// Records the pipeline a run starts under; a run that already has phases started earlier, under what it recorded then or nothing, and answers `unchanged`.
export function recordPipeline({ projectId, slug, pipeline, env = process.env } = {}) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
      if (phaseEntries(state).length > 0) return { status: "unchanged", path: null, reason: null };
      const { pipelineUnpinned: _dropped, ...pinned } = state;
      return saveRunState({ projectId, slug, env, state: { ...pinned, pipeline, updatedAt: new Date().toISOString() } });
    },
  });
}

// Records why a run stayed with no pipeline version, so its notice can say so; a state that already records a version answers `unchanged`.
export function recordPipelineUnpinned({ projectId, slug, reason, env = process.env } = {}) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
      if (isStateObject(state.pipeline) && trimmedText(state.pipeline.version) !== null) return { status: "unchanged", path: null, reason: null };
      const at = new Date().toISOString();
      return saveRunState({ projectId, slug, env, state: { ...state, pipelineUnpinned: { reason, at }, updatedAt: at } });
    },
  });
}

// Records that a fresh retry of a job is leaving this run behind, so a directory it could not delete stays listed by doctor.
export function recordFreshRetry({ projectId, slug, jobId, env = process.env } = {}) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
      const at = new Date().toISOString();
      return saveRunState({ projectId, slug, env, state: { ...state, freshRetry: { jobId, at }, updatedAt: at } });
    },
  });
}

// Records who the run belongs to — the runtime's own block, written before the spawn, which lets the run know itself without the database.
export function recordJobBlock({ projectId, slug, block, env = process.env } = {}) {
  const refused = invalidJobBlock(block);
  if (refused) return refused;
  return underRunLock({ projectId, slug, env, write: () => saveJobBlock({ projectId, slug, block, env }) });
}
