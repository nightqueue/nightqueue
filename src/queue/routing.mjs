/*
 * The agent models of the /resolve pipeline and its constants: the single source of every model an agent runs on.
 * `nightqueue run start` answers the models of the run's project and `phase_prompt` reads them, so no prompt restates them.
 *
 * Model rationale:
 *
 * The agent models below are the single source. The dominant capability of the agent decides its model:
 * - writes/edits code or carries the design judgment every later phase builds on → `opus` (architect, coder);
 * - reasons and critiques without writing code in bulk → `sonnet` (triager: writes the Brief, critiques the
 *   request and reproduces the bug; qa-analyst: adversarial analysis grouped by root, the lite QA included);
 * - bounded, mechanical or command-driven work over material another agent already reasoned about → `haiku`
 *   (explore maps files the triage already scoped; provers write and run one PoC for one pre-analysed
 *   hypothesis; verifier runs the project's checks and the PoCs; reflector distils lessons from written artifacts).
 * The merger keeps `sonnet`. A project overrides any of them with `nightqueue project models`.
 * Phases 0/8/9 run in the orchestrator, on the skill's model. Every run executes every phase.
 */

import { UserError } from "../config/errors.mjs";
import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { RESUME_PHASE_ORDER } from "./resume.mjs";

// The model aliases an agent may run on.
export const MODEL_NAMES = Object.freeze(["opus", "sonnet", "haiku"]);

// One line per agent with its default model (decided 2026-10-23).
export const AGENT_MODELS = Object.freeze({
  triager: "sonnet",
  explore: "haiku",
  architect: "opus",
  coder: "opus",
  "qa-analyst": "sonnet",
  "qa-prover": "haiku",
  verifier: "haiku",
  reflector: "haiku",
  merger: "sonnet",
});

// The agents a project may override: every agent phase_prompt renders (the merger runs in the close, outside phase_prompt).
export const OVERRIDABLE_AGENTS = Object.freeze(Object.keys(AGENT_MODELS).filter((agent) => agent !== "merger"));

// The values every run shares, whatever its project.
export const PIPELINE_CONSTANTS = Object.freeze({
  verifierScope: "the project's real checks (typecheck, lint, build, tests) + the QA's PoCs",
  maxFixIterations: 2,
  qaMethods:
    "automated; + api for an API change; + emulator for a UI change in an Expo repo; + browser for a UI change in a web repo",
});

const GLYPHS = Object.freeze({
  triager: "🔍",
  explore: "🧭",
  architect: "📐",
  coder: "⚙️",
  "qa-guardian": "🛡️",
  verifier: "✅",
});

// Refuses an agent a project cannot override, naming the accepted ones.
export function requireAgent(agent) {
  if (OVERRIDABLE_AGENTS.includes(agent)) return agent;
  throw new UserError(`unknown agent \`${String(agent)}\`; accepted: ${OVERRIDABLE_AGENTS.join(", ")}`);
}

// Refuses a model outside the accepted aliases, naming them.
export function requireModel(model) {
  if (MODEL_NAMES.includes(model)) return model;
  throw new UserError(`unknown model \`${String(model)}\`; accepted: ${MODEL_NAMES.join(", ")}`);
}

// Refuses a task type outside the pipeline's own, naming the accepted ones.
function requireType(type) {
  if (PIPELINE_TASK_TYPES.includes(type)) return type;
  throw new UserError(`unknown type \`${String(type)}\`; accepted: ${PIPELINE_TASK_TYPES.join(", ")}`);
}

// The model an agent runs on: the project's valid override of an overridable agent, else the default; an unknown agent is a programming error.
export function modelFor(agent, projectAgents = null) {
  if (!Object.hasOwn(AGENT_MODELS, agent)) throw new Error(`no default model for agent \`${String(agent)}\``);
  const overridable = OVERRIDABLE_AGENTS.includes(agent) && projectAgents && Object.hasOwn(projectAgents, agent);
  const entry = overridable ? projectAgents[agent] : null;
  const override = entry?.model;
  return MODEL_NAMES.includes(override) ? override : AGENT_MODELS[agent];
}

// The model of every agent, the project's overrides applied.
export function agentModels(projectAgents = null) {
  return Object.fromEntries(Object.keys(AGENT_MODELS).map((agent) => [agent, modelFor(agent, projectAgents)]));
}

// The agent model table as markdown, which `nightqueue run start --routing` prints.
export function modelTable(projectAgents = null) {
  const rows = Object.entries(agentModels(projectAgents)).map(([agent, model]) => {
    const glyph = agentGlyph(agent);
    return `| ${glyph ? `${glyph} ${agent}` : agent} | ${model} |`;
  });
  return ["| Agent | Model |", "| --- | --- |", ...rows].join("\n");
}

// The canonical phases every run goes through, in order; a type, when given, must be one of the pipeline's.
export function phasesFor(type) {
  if (type !== undefined && type !== null && type !== "") requireType(type);
  return [...RESUME_PHASE_ORDER];
}

// The nine slots of the studio track, in order: the number, the label, the agent, the agent whose model it shows and the canonical phase of each.
export const TRACK_SLOTS = [
  { number: 0, name: "brief", agent: null, modelAgent: null, phase: null },
  { number: 1, name: "triager", agent: "triager", modelAgent: "triager", phase: "triage" },
  { number: 2, name: "explore", agent: "explore", modelAgent: "explore", phase: "explore" },
  { number: 3, name: "architect", agent: "architect", modelAgent: "architect", phase: "architecture" },
  { number: 4, name: "coder", agent: "coder", modelAgent: "coder", phase: "implementation" },
  { number: 5, name: "qa-guardian", agent: "qaGuardian", modelAgent: "qa-analyst", phase: "qa" },
  { number: 6, name: "verifier", agent: "verifier", modelAgent: "verifier", phase: "verification" },
  { number: 7, name: "runtime", agent: null, modelAgent: null, phase: "runtime" },
  { number: 8, name: "commit · PR", agent: null, modelAgent: null, phase: "commit" },
];

// The track slot number of a canonical phase; throws on a phase with no slot.
export function slotNumberOf(phase) {
  const slot = TRACK_SLOTS.find((candidate) => candidate.phase === phase);
  if (!slot) throw new Error(`no track slot for phase "${phase}"`);
  return slot.number;
}

// The emoji of an agent, or null for a name with none (the orchestrator).
export function agentGlyph(agent) {
  const name = String(agent ?? "").toLowerCase();
  return Object.hasOwn(GLYPHS, name) ? GLYPHS[name] : null;
}
