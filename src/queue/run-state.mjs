import { withLockSync } from "../config/lock.mjs";
import { runDir } from "../config/paths.mjs";
import { jobRef } from "../memory/refs.mjs";
import { PIPELINE_TASK_TYPES, PIPELINE_TIERS } from "../memory/runs.mjs";
import { isRunPath, isStateObject, readRunState, RESUME_PHASE_ORDER, RESUME_SCHEMA_VERSION, saveRunState } from "./resume.mjs";
import { offTierPhases } from "./routing.mjs";
import { isPrUrl } from "./stream.mjs";

// The lock of one run's state.json: a holder only ever keeps it for a single read and write, so a lock this old can only have been left behind by a dead process.
const RUN_LOCK = { timeoutMs: 5000, staleAfterMs: 15000 };

// The only two outcomes the pipeline may record in `state.json`; how the process ended stays the runtime's call.
export const RUN_OUTCOME_STATUSES = ["done", "gate"];

// The keys of `state.json` only the runtime writes: no pipeline writer may set them, whole or by a dotted name.
export const RUNTIME_ONLY_KEYS = ["job"];

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
  tier: PIPELINE_TIERS,
  tierRaiseReason: null,
  branch: null,
  worktree: null,
  [QA_STAGE_A]: null,
  origin: ["operator"],
  [EVIDENCE_LEVEL]: [1, 2, 3, 4],
  planStatus: ["draft", "approved"],
};

// Who may record a skip through `run_skip`: the pipeline's own agents; `tier` skips are written by the runtime only.
export const SKIP_AGENTS = ["orchestrator", "triager", "explore", "architect", "coder", "qa-guardian", "verifier"];

// The author of the skips the runtime derives from the run's tier and type.
const TIER_SKIP = "tier";

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

// Runs a write of one run's state.json under the lock of that run, so its read and its write are ONE critical section even across processes; a lock nobody releases refuses the write instead of losing another writer's.
function underRunLock({ projectId, slug, env, write }) {
  if (!isRunPath(projectId, slug)) return kept("unsafe project or slug");
  try {
    return withLockSync(`${runDir(projectId, slug, env)}.lock`, write, RUN_LOCK);
  } catch (err) {
    return kept(`the state of the run could not be locked: ${String(err?.message ?? err).split("\n")[0]}`);
  }
}

// The runtime-only key a field name writes, whole (`job`) or dotted (`job.id`), or null when it names none.
function runtimeOnlyKey(name) {
  return RUNTIME_ONLY_KEYS.find((key) => name === key || String(name).startsWith(`${key}.`)) ?? null;
}

// A pipeline change with every runtime-only key dropped, so the runtime's own record survives any writer.
function withoutRuntimeKeys(change) {
  return Object.fromEntries(Object.entries(isStateObject(change) ? change : {}).filter(([name]) => runtimeOnlyKey(name) === null));
}

// Writes one change into the state.json of a run: the runtime stamps the time, and an `updatedAt` written by an agent is overwritten, never trusted.
function record({ projectId, slug, env, change }) {
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => {
      const at = new Date().toISOString();
      const state = withFixedFields(readRunState({ projectId, slug, env }), { projectId, slug });
      return saveRunState({ projectId, slug, env, state: { ...state, ...withoutRuntimeKeys(change(state, at)), updatedAt: at } });
    },
  });
}

// Records a phase the pipeline completed; the list is append-only, so a phase recorded twice never erases the first record.
export function recordPhaseDone({ projectId, slug, phase, artifact, verdict, note, env = process.env } = {}) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  return record({
    projectId,
    slug,
    env,
    change: (state, at) => ({
      phases: [...(Array.isArray(state.phases) ? state.phases : []), withText({ phase, at }, { artifact, verdict, note })],
    }),
  });
}

// Records that the run stopped on purpose at a phase, which is what keeps a retry from resuming it.
export function recordTermination({ projectId, slug, phase, reason, env = process.env } = {}) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  if (trimmedText(reason) === null) return kept("a termination needs a reason: it is what the operator reads in the queue");
  return record({ projectId, slug, env, change: (_state, at) => ({ termination: { phase, reason: trimmedText(reason), at } }) });
}

// Records how the run ended; the pull request URL is the runtime's to write, so an outcome already carrying one keeps it.
export function recordOutcome({ projectId, slug, status, notice, env = process.env } = {}) {
  if (!RUN_OUTCOME_STATUSES.includes(status)) return refuseEnum("status", status, RUN_OUTCOME_STATUSES);
  return record({
    projectId,
    slug,
    env,
    change: (state, at) => ({
      outcome: withText({ ...(isStateObject(state.outcome) ? state.outcome : {}), status, at }, { notice }),
    }),
  });
}

// Records the pull request of the run, which the runtime reads from the host and the agent never sends as a parameter.
export function recordPrUrl({ projectId, slug, prUrl, env = process.env } = {}) {
  if (!isPrUrl(prUrl)) return kept(`\`${String(prUrl)}\` is not a pull request URL`);
  return record({
    projectId,
    slug,
    env,
    change: (state, at) => ({ outcome: { ...(isStateObject(state.outcome) ? state.outcome : {}), prUrl, at } }),
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

// Records the pull request template the runtime found for the run, the one Phase 7 writes the body for; the latest call wins.
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

// The skip records held in a state, each kept only when it is an object naming its author.
function heldSkips(skips) {
  if (!isStateObject(skips)) return {};
  return Object.fromEntries(Object.entries(skips).filter(([, entry]) => isStateObject(entry) && typeof entry.by === "string"));
}

// The skips after a tier or type write: agent entries kept as they are, one `tier` entry per phase off the run's routing, an existing one keeping its time.
function tierSkips(skips, tier, type, at) {
  const held = heldSkips(skips);
  const agents = Object.fromEntries(Object.entries(held).filter(([, entry]) => entry.by !== TIER_SKIP));
  const derived = offTierPhases(tier, type)
    .filter((phase) => !(phase in agents))
    .map((phase) => [phase, { by: TIER_SKIP, at: held[phase]?.by === TIER_SKIP && typeof held[phase].at === "string" ? held[phase].at : at }]);
  return { ...agents, ...Object.fromEntries(derived) };
}

// The change of a run fields write, with the tier skips recomputed whenever the tier or the type is written and the tier is known.
function runFieldsChange(changes, state, at) {
  const written = runFieldsRecord(changes, at);
  if (!("tier" in changes) && !("type" in changes)) return written;
  const tier = written.tier ?? state.tier;
  if (!PIPELINE_TIERS.includes(tier)) return written;
  return { ...written, skips: tierSkips(state.skips, tier, written.type ?? state.type, at) };
}

// Records the fields of the run a phase discovered: its type, its tier, where its code lives and the QA stage it already paid for.
export function recordRunFields({ projectId, slug, fields, env = process.env } = {}) {
  const changes = isStateObject(fields) ? fields : {};
  const entries = Object.entries(changes);
  if (entries.length === 0) return kept(`no field to record; accepted: ${Object.keys(RUN_FIELDS).join(", ")}`);
  const refused = entries.map(invalidRunField).find(Boolean);
  if (refused) return refused;
  return record({ projectId, slug, env, change: (state, at) => runFieldsChange(changes, state, at) });
}

// Refusal of a skip `run_skip` cannot record, or null when its phase, author and reason are the ones state.json keeps.
function invalidSkip({ phase, by, reason }) {
  if (!RESUME_PHASE_ORDER.includes(phase)) return refuseEnum("phase", phase, RESUME_PHASE_ORDER);
  if (by === TIER_SKIP) return kept("`tier` skips are written by the runtime only");
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

// Records that an agent skips a later phase, for display only: routing and resume never read it.
export function recordSkip({ projectId, slug, phase, by, reason, env = process.env } = {}) {
  const refused = invalidSkip({ phase, by, reason });
  if (refused) return refused;
  return underRunLock({
    projectId,
    slug,
    env,
    write: () => saveSkip({ projectId, slug, phase, skip: { by, reason: trimmedText(reason), at: new Date().toISOString() }, env }),
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

// Records who the run belongs to — the runtime's own block, written before the spawn, which lets the run know itself without the database.
export function recordJobBlock({ projectId, slug, block, env = process.env } = {}) {
  const refused = invalidJobBlock(block);
  if (refused) return refused;
  return underRunLock({ projectId, slug, env, write: () => saveJobBlock({ projectId, slug, block, env }) });
}
