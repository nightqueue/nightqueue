import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homeDir, runDir } from "../config/paths.mjs";
import { NAME_RE } from "../config/schema.mjs";
import { writeFileAtomic } from "../config/store.mjs";

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
export const TERMINAL_VERDICT_LABELS = ["NOT-REPRODUCIBLE", "NEEDS-CLARIFICATION"];
export const DEFAULT_MAX_RESUMES = 1;

const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/;

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

// Artifact of the QA stage A marker; an invalid shape is ignored, never invalidating the whole state.
function qaStageArtifact(parsed) {
  const marker = parsed?.qaStageA;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
  return typeof marker.artifact === "string" && marker.artifact.trim() ? marker.artifact.trim() : null;
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
    if (position > index) {
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
  const last = lastCompletedPhase(phasesBeforeRerun(parsed.phases, reruns));
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
      fromStage: fromPhase === "qa" && qaStageArtifact(parsed) ? "qa-stage-b" : null,
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
  if (resume?.resume !== true || !isSafeSegment(slug) || !NAME_RE.test(String(job?.project ?? ""))) return null;
  const parsed = isStateObject(state) ? state : {};
  return {
    slug,
    runDir: runDir(job.project, slug, env),
    branch: fixedField(parsed.branch),
    worktree: fixedField(parsed.worktree),
    lastPhase: fixedField(resume.lastPhase),
    fromPhase: fixedField(resume.fromPhase),
    fromStage: fixedField(resume.fromStage),
    ...(Array.isArray(resume.reruns) && resume.reruns.length > 0 ? { reruns: resume.reruns } : {}),
  };
}

// Tells whether a run can be addressed on disk at all: a project that is a name and a slug that is one safe segment.
export function isRunPath(project, slug) {
  return NAME_RE.test(String(project ?? "")) && isSafeSegment(slug);
}

// Reads the state.json of a run; an unsafe segment, a missing file or broken JSON all return null.
export function readRunState({ project, slug, env = process.env } = {}) {
  if (!isRunPath(project, slug)) return null;
  try {
    return JSON.parse(readFileSync(join(runDir(project, slug, env), "state.json"), "utf8"));
  } catch {
    return null;
  }
}

// Reads the state.json of a job's run, or null when its terminal witness was stamped by another job and so never speaks for this one.
export function ownRunState({ project, slug, jobId, env = process.env } = {}) {
  const state = readRunState({ project, slug, env });
  const stamp = isStateObject(state) && isStateObject(state.terminal) ? state.terminal.jobId : undefined;
  return Number.isInteger(stamp) && stamp !== Number(jobId) ? null : state;
}

// Tells whether a parsed state.json is an object the witness can be merged into.
export function isStateObject(state) {
  return Boolean(state) && typeof state === "object" && !Array.isArray(state);
}

// Writes the state.json of a run atomically, creating its directory; an unsafe project or slug writes nothing.
export function saveRunState({ project, slug, env, state }) {
  if (!isRunPath(project, slug)) {
    return { status: "kept", path: null, reason: "unsafe project or slug" };
  }
  const path = join(runDir(project, slug, env), "state.json");
  try {
    mkdirSync(runDir(project, slug, env), { recursive: true });
    writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
    return { status: "written", path, reason: null };
  } catch (err) {
    return { status: "kept", path, reason: String(err?.message ?? err).split("\n")[0] };
  }
}

// Writes the terminal section of a run: the witness of the outcome, durable and independent of the database.
export function writeRunTerminal({ project, slug, terminal, env = process.env } = {}) {
  const state = readRunState({ project, slug, env });
  return saveRunState({ project, slug, env, state: { ...(isStateObject(state) ? state : {}), terminal } });
}

// Drops the terminal section of a run, so the witness of the previous attempt never speaks for the next one.
export function clearRunTerminal({ project, slug, env = process.env } = {}) {
  const state = readRunState({ project, slug, env });
  if (!isStateObject(state) || state.terminal === undefined) return { status: "absent", path: null, reason: null };
  const { terminal, ...rest } = state;
  return saveRunState({ project, slug, env, state: rest });
}

// Drops the outcome the pipeline recorded, so the record of the previous attempt never speaks for the next one.
export function clearRunOutcome({ project, slug, env = process.env } = {}) {
  const state = readRunState({ project, slug, env });
  if (!isStateObject(state) || state.outcome === undefined) return { status: "absent", path: null, reason: null };
  const { outcome, ...rest } = state;
  return saveRunState({ project, slug, env, state: rest });
}

// Moves the run directory of a project onto another slug, which is how the pipeline renames the run the runtime opened for it.
// A name another run already took is REFUSED instead of merged into: the run that asked keeps the slug it was given.
export function renameRunDir({ project, from, to, env = process.env } = {}) {
  if (!NAME_RE.test(String(project ?? "")) || !isSafeSegment(from) || !isSafeSegment(to)) {
    return { status: "kept", dir: null, reason: "unsafe project or slug" };
  }
  const target = runDir(project, to, env);
  if (existsSync(target)) return { status: "kept", dir: target, reason: `runs/${project}/${to} already exists` };
  const source = runDir(project, from, env);
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
function keptRunDir(dir, reason) {
  return { dir, status: "kept", reason };
}

// Deletes the run directory of a job, and only when the segments are safe, no component of the path was redirected by a link and what is there is a plain directory.
export function discardRunDir({ project, slug, env = process.env } = {}) {
  if (!NAME_RE.test(String(project ?? "")) || !isSafeSegment(slug)) return keptRunDir(null, "unsafe project or slug");
  const dir = resolve(runDir(project, slug, env));
  const runsRoot = realPathOrNull(join(homeDir(env), "runs"));
  const projectDir = realPathOrNull(join(homeDir(env), "runs", project));
  if (!runsRoot || !projectDir) return { dir, status: "not present", reason: null };
  if (projectDir !== join(runsRoot, project)) return keptRunDir(dir, `runs/${project} resolves outside the runs directory`);
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
