import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isId } from "../config/ids.mjs";
import { withLockSync } from "../config/lock.mjs";
import { runDir, runsDir } from "../config/paths.mjs";
import { writeFileAtomic } from "../config/store.mjs";

// The lock of one run's state.json: a holder only ever keeps it for a single read and write, so a lock this old can only have been left behind by a dead process.
export const RUN_LOCK = { timeoutMs: 5000, staleAfterMs: 15000 };

// Canonical phase order written by the plugin into state.json; "next phase" derives from the highest one completed.
export const RESUME_PHASE_ORDER = [
  "triage",
  "explore",
  "architecture",
  "implementation",
  "qa",
  "verification",
  "runtime",
  "commit",
];

export const RESUME_SCHEMA_VERSION = 1;
export const TERMINAL_VERDICT_LABELS = ["NO-CHANGE-NEEDED", "NOT-REPRODUCIBLE", "NEEDS-CLARIFICATION", "PROPOSE-ALTERNATIVE"];
export const DEFAULT_MAX_RESUMES = 1;

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;
// The one artifact a QA stage A marker may name: the analyst's round lives in the QA's own artifact.
const QA_ARTIFACT = "05-qa.md";
const QA_SKIPPED_VERDICT_RE = /(?:^|-)SKIPPED$/;

// Tells whether a value coming from the database is safe as a single path segment.
export function isSafeSegment(value) {
  return typeof value === "string" && SEGMENT_RE.test(value);
}

// Tells whether the state declared a deliberate termination; any usable value counts as terminated.
function closedByTermination(parsed) {
  const marker = parsed?.termination;
  if (marker === null || marker === undefined) return false;
  if (typeof marker === "string") return Boolean(marker.trim());
  if (typeof marker === "object") return true;
  return marker === true;
}

// Normalizes a verdict for comparison: uppercase, every non-alphanumeric run collapsed into a dash.
function normalizeVerdict(text) {
  return String(text)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Tells whether a phase entry ended on a verdict that closes the pipeline on purpose.
function hasTerminalVerdict(entry) {
  const verdict = entry?.verdict;
  if (typeof verdict !== "string" || !verdict.trim()) return false;
  const normalized = normalizeVerdict(verdict);
  return TERMINAL_VERDICT_LABELS.some((label) => normalized === label || normalized.startsWith(`${label}-`));
}

// The `at` of the last recorded entry of a phase, or an empty text when it has none.
function lastPhaseAt(phases, phase) {
  const entry = (Array.isArray(phases) ? phases : []).findLast((candidate) => candidate?.phase === phase);
  return typeof entry?.at === "string" ? entry.at : "";
}

// Whether the QA stage A marker still holds: on `05-qa.md` and newer than the last implementation; an invalid shape or a missing `at` never does.
function qaStageAHolds(parsed) {
  const marker = parsed?.qaStageA;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false;
  if (marker.artifact !== QA_ARTIFACT || typeof marker.at !== "string" || marker.at === "") return false;
  const implementedAt = lastPhaseAt(parsed.phases, "implementation");
  return implementedAt !== "" && marker.at > implementedAt;
}

// Refusal to resume, always with the same shape as an acceptance.
function stop(reason, { resumeCount = 0, lastPhase = null } = {}) {
  return { resume: false, fromPhase: null, fromStage: null, reuseWorktree: false, reason, resumeCount, lastPhase };
}

// Index of the last completed phase and its entry; a phase name outside the contract discards the state.
function lastCompletedPhase(phases) {
  let index = -1;
  let entry = null;
  for (const candidate of phases) {
    const position = RESUME_PHASE_ORDER.indexOf(candidate?.phase);
    if (position < 0) return null;
    if (position >= index) {
      index = position;
      entry = candidate;
    }
  }
  return { index, entry };
}

// Tells whether the parsed state has the fixed fields the resume decision needs.
function hasRequiredFields(parsed) {
  return typeof parsed.schemaVersion === "number" && typeof parsed.slug === "string" && Array.isArray(parsed.phases);
}

// Tells whether a state was recorded by an operator session rather than by a job.
function isOperatorRun(parsed) {
  return parsed?.origin === "operator";
}

// Tells whether the state recorded a completed entry of the phase.
function hasPhase(parsed, phase) {
  return Array.isArray(parsed?.phases) && parsed.phases.some((entry) => entry?.phase === phase);
}

// The earliest recorded phase of an operator run the runtime refuses to skip, with its reason, as a one-item list; empty for any other run.
export function operatorReruns(state) {
  if (!isOperatorRun(state)) return [];
  const level = state.evidenceLevel;
  if (hasPhase(state, "triage") && state.type !== "feature/refactor" && !(Number.isInteger(level) && level >= 3)) {
    return [{ phase: "triage", reason: `evidence level ${Number.isInteger(level) ? level : "not recorded"} is below 3 on a bug (operator run)` }];
  }
  if (hasPhase(state, "architecture") && state.planStatus !== "approved") {
    return [{ phase: "architecture", reason: `plan status ${state.planStatus === "draft" ? "draft" : "not recorded"}, not approved (operator run)` }];
  }
  return [];
}

// One prompt line per recorded phase of an operator run the runtime refuses to skip.
export function rerunLines(reruns) {
  return (Array.isArray(reruns) ? reruns : []).map((rerun) => `Re-run: ${rerun.phase} — ${rerun.reason}`);
}

// Position of the earliest phase that must re-run, or the end of the order when none does.
function firstRerunIndex(reruns) {
  return Math.min(RESUME_PHASE_ORDER.length, ...reruns.map((rerun) => RESUME_PHASE_ORDER.indexOf(rerun.phase)));
}

// The phases the resume may count: every entry before the first re-run phase, unknown names kept so they still discard the state.
function phasesBeforeRerun(phases, reruns) {
  if (reruns.length === 0) return phases;
  const firstTrap = firstRerunIndex(reruns);
  return phases.filter((entry) => RESUME_PHASE_ORDER.indexOf(entry?.phase) < firstTrap);
}

// Whether the QA is still owed: the last QA entry is a skip the recorded QA mode does not back, or a lite or full decision stands with no QA recorded since it.
function owesQa(state) {
  const decided = state.qaMode;
  if (decided?.mode === "skip") return false;
  const lastQa = state.phases.findLast((entry) => entry?.phase === "qa");
  if (QA_SKIPPED_VERDICT_RE.test(normalizeVerdict(lastQa?.verdict))) return true;
  return typeof decided?.at === "string" && lastPhaseAt(state.phases, "qa") < decided.at;
}

// The phases the resume may count once the QA is owed: every entry before the QA, unknown names kept so they still discard the state.
function phasesBeforeOwedQa(phases, state) {
  if (!owesQa(state)) return phases;
  const qaIndex = RESUME_PHASE_ORDER.indexOf("qa");
  return phases.filter((entry) => RESUME_PHASE_ORDER.indexOf(entry?.phase) < qaIndex);
}

// Parses the state handed to the decision, or returns the refusal of a state that cannot be read.
function parseState(state) {
  if (state === null || state === undefined || state === "") return { refusal: stop("no-state") };
  let parsed = state;
  if (typeof state === "string") {
    try {
      parsed = JSON.parse(state);
    } catch {
      return { refusal: stop("corrupt-state") };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { refusal: stop("invalid-state") };
  if (!hasRequiredFields(parsed)) return { refusal: stop("invalid-state") };
  if (parsed.schemaVersion !== RESUME_SCHEMA_VERSION) return { refusal: stop("unknown-schema") };
  return { parsed };
}

// The decision with the re-runs of an operator run attached, and the key absent when there is none.
function withReruns(decision, reruns) {
  return reruns.length === 0 ? decision : { ...decision, reruns };
}

// Decides whether a run resumes from an already read state.json; it never reads disk and never throws.
export function decideResume({ state, maxResumes = DEFAULT_MAX_RESUMES } = {}) {
  const { parsed, refusal } = parseState(state);
  if (refusal) return refusal;
  if (closedByTermination(parsed)) return stop("terminated-by-verdict");

  const cap = isOperatorRun(parsed) ? maxResumes + 1 : maxResumes;
  const resumeCount = parsed.resumeCount;
  if (!Number.isInteger(resumeCount) || resumeCount < 0 || resumeCount >= cap) return stop("resume-cap");

  const reruns = operatorReruns(parsed);
  const last = lastCompletedPhase(phasesBeforeOwedQa(phasesBeforeRerun(parsed.phases, reruns), parsed));
  if (!last) return stop("unknown-phase");
  if (last.index < 0 && reruns.length > 0) {
    const fromPhase = RESUME_PHASE_ORDER[firstRerunIndex(reruns)];
    return { resume: true, fromPhase, fromStage: null, reuseWorktree: false, reason: "operator-rerun", resumeCount: resumeCount + 1, lastPhase: null, reruns };
  }
  if (last.index < 0) return stop("no-completed-phase");

  const lastPhase = RESUME_PHASE_ORDER[last.index];
  if (hasTerminalVerdict(last.entry)) return stop("terminated-by-verdict", { resumeCount, lastPhase });
  if (last.index >= RESUME_PHASE_ORDER.length - 1) return stop("run-already-done", { resumeCount, lastPhase });

  const fromPhase = RESUME_PHASE_ORDER[last.index + 1];
  return withReruns(
    {
      resume: true,
      fromPhase,
      fromStage: fromPhase === "qa" && qaStageAHolds(parsed) ? "qa-stage-b" : null,
      reuseWorktree: Boolean(parsed.branch || parsed.worktree),
      reason: "resume",
      resumeCount: resumeCount + 1,
      lastPhase,
    },
    reruns,
  );
}

// A fixed field of the state as the agent may read it back: a non-empty trimmed string, or null.
function fixedField(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

// Everything the agent needs to resume a run - where it lives, what it kept and which phase comes next - or null when the decision refuses it.
export function resumeHandoff({ job, resume, state, env = process.env } = {}) {
  const slug = job?.slug;
  if (resume?.resume !== true || !isRunPath(job?.project_id, slug)) return null;
  const parsed = isStateObject(state) ? state : {};
  return {
    slug,
    runDir: runDir(job.project_id, slug, env),
    branch: fixedField(parsed.branch),
    worktree: fixedField(parsed.worktree),
    lastPhase: fixedField(resume.lastPhase),
    fromPhase: fixedField(resume.fromPhase),
    fromStage: fixedField(resume.fromStage),
    ...(Array.isArray(resume.reruns) && resume.reruns.length > 0 ? { reruns: resume.reruns } : {}),
  };
}

// Tells whether a run can be addressed on disk at all: a project that is an id and a slug that is one safe segment.
export function isRunPath(projectId, slug) {
  return isId(projectId) && isSafeSegment(slug);
}

// Reads the state.json of a run; an unsafe segment, a missing file or broken JSON all return null.
export function readRunState({ projectId, slug, env = process.env } = {}) {
  if (!isRunPath(projectId, slug)) return null;
  try {
    return JSON.parse(readFileSync(join(runDir(projectId, slug, env), "state.json"), "utf8"));
  } catch {
    return null;
  }
}

// The id of the other job whose terminal witness stamps this state, or null when no other job does.
export function foreignStampOf(state, jobId) {
  const stamp = isStateObject(state) && isStateObject(state.terminal) ? state.terminal.jobId : undefined;
  return Number.isInteger(stamp) && stamp !== Number(jobId) ? stamp : null;
}

// Reads the state.json of a job's run, or null when its terminal witness was stamped by another job and so never speaks for this one.
export function ownRunState({ projectId, slug, jobId, env = process.env } = {}) {
  const state = readRunState({ projectId, slug, env });
  return foreignStampOf(state, jobId) === null ? state : null;
}

// Tells whether a parsed state.json is an object the witness can be merged into.
export function isStateObject(state) {
  return Boolean(state) && typeof state === "object" && !Array.isArray(state);
}

// The attempt a record's stamp names, or null for a record with no stamp, which reads as current.
export function stampedAttempt(record) {
  const attempt = isStateObject(record) && isStateObject(record.claim) ? record.claim.attempt : null;
  return Number.isInteger(attempt) ? attempt : null;
}

// The ordinal of the claim a record's stamp names, or null for a stamp older than the ordinal.
function stampedOrdinal(record) {
  const ordinal = isStateObject(record) && isStateObject(record.claim) ? record.claim.ordinal : null;
  return Number.isInteger(ordinal) ? ordinal : null;
}

// The stamp of a claim on a record: its attempt, its session and, when known, its ordinal.
export function claimStamp({ attempt, session = null, ordinal = null }) {
  return { attempt, session, ...(Number.isInteger(ordinal) ? { ordinal } : {}) };
}

// The ordinal of a row's current claim: the one the claim answered, else its last attempt row, else null.
export function rowClaimOrdinal(row) {
  if (Number.isInteger(row?.claim_attempt)) return row.claim_attempt;
  const last = Array.isArray(row?.attempt_rows) ? row.attempt_rows.at(-1)?.attempt : null;
  return Number.isInteger(last) ? last : null;
}

// Where a record's stamp stands against a claim: below zero for an earlier claim, above for a later one, zero for this one or no stamp; the ordinal decides when both hold one, else the attempt.
export function stampOrder(record, { attempt, ordinal = null }) {
  const stamped = stampedAttempt(record);
  if (stamped === null) return 0;
  const own = stampedOrdinal(record);
  return own !== null && Number.isInteger(ordinal) ? own - ordinal : stamped - attempt;
}

// An outcome reduced to the facts of its publication: what the host holds stays, whichever claim wrote the rest.
export function outcomeHostFacts(outcome) {
  const { status: _status, notice: _notice, claim: _claim, ...facts } = outcome;
  return facts;
}

// The attempts named by the records a run already set aside as late or displaced.
function ignoredRecordAttempts(state) {
  const entries = Array.isArray(state.ignoredRecords) ? state.ignoredRecords : [];
  return entries.map(stampedAttempt).filter((attempt) => attempt !== null);
}

// The state as one claim reads it: a record stamped by another claim does not speak, and `ignoredAttempts` says which attempts were ignored; nothing is written.
export function recordsOfClaim(state, attempt, ordinal = null) {
  if (!isStateObject(state) || !Number.isInteger(attempt)) return state;
  const isStale = (record) => stampOrder(record, { attempt, ordinal }) !== 0;
  const { termination, terminal, ...view } = state;
  if (termination !== undefined && !isStale(termination)) view.termination = termination;
  if (terminal !== undefined && !isStale(terminal)) view.terminal = terminal;
  if (isStale(state.outcome)) view.outcome = outcomeHostFacts(state.outcome);
  const stale = [state.outcome, termination, terminal].filter(isStale).map(stampedAttempt);
  const ignored = [...new Set([...stale, ...ignoredRecordAttempts(state)])].sort((a, b) => a - b);
  return ignored.length > 0 ? { ...view, ignoredAttempts: ignored } : view;
}

// Reads the state.json of a job's run as its current claim reads it, or null when another job stamped it.
export function claimRunState({ projectId, slug, jobId, attempt, ordinal = null, env = process.env } = {}) {
  return recordsOfClaim(ownRunState({ projectId, slug, jobId, env }), attempt, ordinal);
}

// Runs a write of one run's state.json under the lock of that run, so its read and its write are ONE critical section even across processes; a lock nobody releases refuses the write instead of losing another writer's.
export function underRunLock({ projectId, slug, env, write }) {
  if (!isRunPath(projectId, slug)) return { status: "kept", path: null, reason: "unsafe project or slug" };
  try {
    return withLockSync(`${runDir(projectId, slug, env)}.lock`, write, RUN_LOCK);
  } catch (err) {
    return { status: "kept", path: null, reason: `the state of the run could not be locked: ${String(err?.message ?? err).split("\n")[0]}` };
  }
}

// Writes the state.json of a run atomically, creating its directory; an unsafe project or slug writes nothing.
export function saveRunState({ projectId, slug, env, state }) {
  if (!isRunPath(projectId, slug)) {
    return { status: "kept", path: null, reason: "unsafe project or slug" };
  }
  const path = join(runDir(projectId, slug, env), "state.json");
  try {
    mkdirSync(runDir(projectId, slug, env), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
    return { status: "written", path, reason: null };
  } catch (err) {
    return { status: "kept", path, reason: String(err?.message ?? err).split("\n")[0] };
  }
}

// Writes the terminal section of a run: the witness of the outcome, durable and independent of the database.
export function writeRunTerminal({ projectId, slug, terminal, env = process.env } = {}) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const state = readRunState({ projectId, slug, env });
      return saveRunState({ projectId, slug, env, state: { ...(isStateObject(state) ? state : {}), terminal } });
    },
  });
}

// Moves the run directory of a project onto another slug, which is how the pipeline renames the run the runtime opened for it.
// A name another run already took is REFUSED instead of merged into: the run that asked keeps the slug it was given.
export function renameRunDir({ projectId, from, to, env = process.env } = {}) {
  if (!isId(projectId) || !isSafeSegment(from) || !isSafeSegment(to)) {
    return { status: "kept", dir: null, reason: "unsafe project or slug" };
  }
  const target = runDir(projectId, to, env);
  if (existsSync(target)) return { status: "kept", dir: target, reason: `runs/${projectId}/${to} already exists` };
  const source = runDir(projectId, from, env);
  if (!existsSync(source)) return { status: "absent", dir: target, reason: null };
  try {
    renameSync(source, target);
  } catch (err) {
    return { status: "kept", dir: target, reason: String(err?.message ?? err).split("\n")[0] };
  }
  return { status: "renamed", dir: target, reason: null };
}

// State of a path WITHOUT following a link, the only reading that tells a run directory from a link into somebody else's tree.
function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

// Real path of a directory, links of every component already followed, or null when nothing is there.
function realPathOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// Refusal to delete, always with the same shape as a deletion.
export function keptRunDir(dir, reason) {
  return { dir, status: "kept", reason };
}

// Deletes the run directory of a job, and only when the segments are safe, no component of the path was redirected by a link and what is there is a plain directory.
export function discardRunDir({ projectId, slug, env = process.env } = {}) {
  if (!isRunPath(projectId, slug)) return keptRunDir(null, "unsafe project or slug");
  const dir = resolve(runDir(projectId, slug, env));
  const runsRoot = realPathOrNull(runsDir(env));
  const projectDir = realPathOrNull(join(runsDir(env), projectId));
  if (!runsRoot || !projectDir) return { dir, status: "not present", reason: null };
  if (projectDir !== join(runsRoot, projectId)) return keptRunDir(dir, `runs/${projectId} resolves outside the runs directory`);
  const leaf = join(projectDir, slug);
  const stats = lstatOrNull(leaf);
  if (!stats) return { dir, status: "not present", reason: null };
  if (stats.isSymbolicLink() || !stats.isDirectory()) return keptRunDir(dir, "the run directory is not a plain directory");
  try {
    rmSync(leaf, { recursive: true, force: true });
  } catch (err) {
    return keptRunDir(dir, String(err?.message ?? err).split("\n")[0]);
  }
  return { dir, status: "removed", reason: null };
}
