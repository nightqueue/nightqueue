import { withLockSync } from "../config/lock.mjs";
import { runDir } from "../config/paths.mjs";
import { PIPELINE_TASK_TYPES, PIPELINE_TIERS } from "../memory/runs.mjs";
import { isRunPath, isStateObject, readRunState, RESUME_PHASE_ORDER, RESUME_SCHEMA_VERSION, saveRunState } from "./resume.mjs";
import { isPrUrl } from "./stream.mjs";

// The lock of one run's state.json: a holder only ever keeps it for a single read and write, so a lock this old can only have been left behind by a dead process.
const RUN_LOCK = { timeoutMs: 5000, staleAfterMs: 15000 };

// The only two outcomes the pipeline may record in `state.json`; how the process ended stays the runtime's call.
export const RUN_OUTCOME_STATUSES = ["done", "gate"];

// The only sub-phase of the pipeline with a record of its own: a top-level marker, never an entry of `phases`.
const QA_STAGE_A = "qaStageA";

// The fields of the run itself a phase may still discover, each with the values it accepts (`null` means any text).
const RUN_FIELDS = {
  type: PIPELINE_TASK_TYPES,
  tier: PIPELINE_TIERS,
  tierRaiseReason: null,
  branch: null,
  worktree: null,
  [QA_STAGE_A]: null,
};

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
function withFixedFields(state, { project, slug }) {
  const held = isStateObject(state) ? state : {};
  const resumeCount = Number.isInteger(held.resumeCount) && held.resumeCount >= 0 ? held.resumeCount : 0;
  return { ...held, schemaVersion: RESUME_SCHEMA_VERSION, project, slug, resumeCount };
}

// Runs a write of one run's state.json under the lock of that run, so its read and its write are ONE critical section even across processes; a lock nobody releases refuses the write instead of losing another writer's.
function underRunLock({ project, slug, env, write }) {
  if (!isRunPath(project, slug)) return kept("unsafe project or slug");
  try {
    return withLockSync(`${runDir(project, slug, env)}.lock`, write, RUN_LOCK);
  } catch (err) {
    return kept(`the state of the run could not be locked: ${String(err?.message ?? err).split("\n")[0]}`);
  }
}

// Writes one change into the state.json of a run: the runtime stamps the time, and an `updatedAt` written by an agent is overwritten, never trusted.
function record({ project, slug, env, change }) {
  return underRunLock({
    project,
    slug,
    env,
    write: () => {
      const at = new Date().toISOString();
      const state = withFixedFields(readRunState({ project, slug, env }), { project, slug });
      return saveRunState({ project, slug, env, state: { ...state, ...change(state, at), updatedAt: at } });
    },
  });
}

// Records a phase the pipeline completed; the list is append-only, so a phase recorded twice never erases the first record.
export function recordPhaseDone({ project, slug, phase, artifact, verdict, note, env = process.env } = {}) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  return record({
    project,
    slug,
    env,
    change: (state, at) => ({
      phases: [...(Array.isArray(state.phases) ? state.phases : []), withText({ phase, at }, { artifact, verdict, note })],
    }),
  });
}

// Records that the run stopped on purpose at a phase, which is what keeps a retry from resuming it.
export function recordTermination({ project, slug, phase, reason, env = process.env } = {}) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  if (trimmedText(reason) === null) return kept("a termination needs a reason: it is what the operator reads in the queue");
  return record({ project, slug, env, change: (_state, at) => ({ termination: { phase, reason: trimmedText(reason), at } }) });
}

// Records how the run ended; the pull request URL is the runtime's to write, so an outcome already carrying one keeps it.
export function recordOutcome({ project, slug, status, notice, env = process.env } = {}) {
  if (!RUN_OUTCOME_STATUSES.includes(status)) return refuseEnum("status", status, RUN_OUTCOME_STATUSES);
  return record({
    project,
    slug,
    env,
    change: (state, at) => ({
      outcome: withText({ ...(isStateObject(state.outcome) ? state.outcome : {}), status, at }, { notice }),
    }),
  });
}

// Records the pull request of the run, which the runtime reads from the host and the agent never sends as a parameter.
export function recordPrUrl({ project, slug, prUrl, env = process.env } = {}) {
  if (!isPrUrl(prUrl)) return kept(`\`${String(prUrl)}\` is not a pull request URL`);
  return record({
    project,
    slug,
    env,
    change: (state, at) => ({ outcome: { ...(isStateObject(state.outcome) ? state.outcome : {}), prUrl, at } }),
  });
}

// Refusal of a QA stage A marker without the artifact the resume decision reads to re-enter the QA phase at stage B.
function invalidQaStageA(value) {
  const artifact = isStateObject(value) ? trimmedText(value.artifact) : null;
  return artifact === null ? kept(`field \`${QA_STAGE_A}\` needs the \`artifact\` of the stage A report`) : null;
}

// Refusal of a field `run_set` does not own, or of a value outside the enum of a field that has one.
function invalidRunField([name, value]) {
  if (!(name in RUN_FIELDS)) return refuseEnum("field", name, Object.keys(RUN_FIELDS));
  if (name === QA_STAGE_A) return invalidQaStageA(value);
  const accepted = RUN_FIELDS[name];
  if (accepted && !accepted.includes(value)) return refuseEnum(name, value, accepted);
  return trimmedText(value) === null ? kept(`field \`${name}\` cannot be empty`) : null;
}

// The fields as state.json keeps them: the text ones trimmed, and the QA stage A marker stamped by the runtime.
function runFieldsRecord(fields, at) {
  const { [QA_STAGE_A]: marker, ...text } = fields;
  const written = withText({}, text);
  if (!marker) return written;
  return { ...written, [QA_STAGE_A]: withText({ artifact: trimmedText(marker.artifact), at }, { verdict: marker.verdict }) };
}

// Records the fields of the run a phase discovered: its type, its tier, where its code lives and the QA stage it already paid for.
export function recordRunFields({ project, slug, fields, env = process.env } = {}) {
  const changes = isStateObject(fields) ? fields : {};
  const entries = Object.entries(changes);
  if (entries.length === 0) return kept(`no field to record; accepted: ${Object.keys(RUN_FIELDS).join(", ")}`);
  const refused = entries.map(invalidRunField).find(Boolean);
  if (refused) return refused;
  return record({ project, slug, env, change: (_state, at) => runFieldsRecord(changes, at) });
}

// The resume count over the state already on disk: a run the pipeline never recorded anything into is not created by a resume.
function saveResumeCount({ project, slug, resumeCount, env }) {
  const state = readRunState({ project, slug, env });
  if (!isStateObject(state)) return kept("there is no state.json to record the resume into");
  return saveRunState({ project, slug, env, state: { ...state, resumeCount, updatedAt: new Date().toISOString() } });
}

// Records the resume the runtime decided on: the only writer of `resumeCount`, which the agent never touches again.
export function recordResume({ project, slug, resumeCount, env = process.env } = {}) {
  if (!Number.isInteger(resumeCount) || resumeCount < 0) {
    return kept(`resumeCount must be a non-negative integer, got \`${String(resumeCount)}\``);
  }
  return underRunLock({ project, slug, env, write: () => saveResumeCount({ project, slug, resumeCount, env }) });
}
