import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { isId } from "../config/ids.mjs";
import { withLockSync } from "../config/lock.mjs";
import { runDir, runsDir } from "../config/paths.mjs";
import { writeFileAtomic } from "../config/store.mjs";

// The lock of one run's state.json: a holder only ever keeps it for a single read and write, so a lock this old can only have been left behind by a dead process.
export const RUN_LOCK = { timeoutMs: 5000, staleAfterMs: 15000 };

// The phase names `state.json` validates with, and nothing more: nothing derives a next phase from this list.
export const PHASE_NAMES = [
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

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;

// Tells whether a value coming from the database is safe as a single path segment.
export function isSafeSegment(value) {
  return typeof value === "string" && SEGMENT_RE.test(value);
}

// A text field of a record as the facts carry it: a non-empty trimmed string, or null.
function factText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

// The entries a state's key holds, as a list of records.
function recordsOf(entries) {
  return (Array.isArray(entries) ? entries : []).filter(isStateObject);
}

// The phases a state recorded, in the order it recorded them; an entry with no phase name is dropped.
function phaseFacts(state) {
  const named = recordsOf(state.phases).filter((entry) => factText(entry.phase) !== null);
  return named.map((entry) => ({ phase: factText(entry.phase), verdict: factText(entry.verdict), artifact: factText(entry.artifact), at: factText(entry.at) }));
}

// The operator's recorded answers, oldest first; an entry with no text is dropped.
function answerFacts(state) {
  const answered = recordsOf(state.answers).filter((entry) => factText(entry.text) !== null);
  return answered.map((entry) => ({ text: factText(entry.text), at: factText(entry.at), attempt: Number.isInteger(entry.attempt) ? entry.attempt : null }));
}

// The wip commit a state recorded, or null when it holds none.
function wipFact(state) {
  const commit = isStateObject(state.wip) ? factText(state.wip.commit) : null;
  if (commit === null) return null;
  return { commit, short: factText(state.wip.short) ?? commit.slice(0, 7), files: Array.isArray(state.wip.files) ? state.wip.files : [] };
}

// The records of an already read state as data, with no order and no conclusion; null when the state cannot be read as one. It never reads disk and never throws.
export function runFacts(state, { runDir: dir = null } = {}) {
  if (!isStateObject(state)) return null;
  return { runDir: dir, branch: factText(state.branch), worktree: factText(state.worktree), phases: phaseFacts(state), answers: answerFacts(state), wip: wipFact(state) };
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
