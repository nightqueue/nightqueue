import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runDir } from "../config/paths.mjs";
import { NAME_RE } from "../config/schema.mjs";

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

// Decides whether a run resumes from an already read state.json; it never reads disk and never throws.
export function decideResume({ state, maxResumes = DEFAULT_MAX_RESUMES } = {}) {
  if (state === null || state === undefined || state === "") return stop("no-state");
  let parsed = state;
  if (typeof state === "string") {
    try {
      parsed = JSON.parse(state);
    } catch {
      return stop("corrupt-state");
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return stop("invalid-state");
  if (!hasRequiredFields(parsed)) return stop("invalid-state");
  if (parsed.schemaVersion !== RESUME_SCHEMA_VERSION) return stop("unknown-schema");
  if (closedByTermination(parsed)) return stop("terminated-by-verdict");

  const resumeCount = parsed.resumeCount;
  if (!Number.isInteger(resumeCount) || resumeCount < 0 || resumeCount >= maxResumes) return stop("resume-cap");

  const last = lastCompletedPhase(parsed.phases);
  if (!last) return stop("unknown-phase");
  if (last.index < 0) return stop("no-completed-phase");

  const lastPhase = RESUME_PHASE_ORDER[last.index];
  if (hasTerminalVerdict(last.entry)) return stop("terminated-by-verdict", { resumeCount, lastPhase });
  if (last.index >= RESUME_PHASE_ORDER.length - 1) return stop("run-already-done", { resumeCount, lastPhase });

  const fromPhase = RESUME_PHASE_ORDER[last.index + 1];
  return {
    resume: true,
    fromPhase,
    fromStage: fromPhase === "qa" && qaStageArtifact(parsed) ? "qa-stage-b" : null,
    reuseWorktree: Boolean(parsed.branch || parsed.worktree),
    reason: "resume",
    resumeCount: resumeCount + 1,
    lastPhase,
  };
}

// Reads the state.json of a run; an unsafe segment, a missing file or broken JSON all return null.
export function readRunState({ project, slug, env = process.env } = {}) {
  if (!NAME_RE.test(String(project ?? "")) || !isSafeSegment(slug)) return null;
  try {
    return JSON.parse(readFileSync(join(runDir(project, slug, env), "state.json"), "utf8"));
  } catch {
    return null;
  }
}
