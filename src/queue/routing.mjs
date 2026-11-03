/*
 * The agent models of the pipeline and its constants, read from its package's manifest, with the merger the runtime's own.
 * `nightqueue run start` answers the models of the run's project and the orchestrator launches each block with them, so no prompt restates them.
 * The rationale of the models lives in docs/runtime-contract.md.
 */

import { UserError } from "../config/errors.mjs";
import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { phaseIdsOf, pipelineManifest } from "./pipeline-package.mjs";

const MANIFEST = pipelineManifest();

// The model aliases an agent may run on.
export const MODEL_NAMES = Object.freeze(["opus", "sonnet", "haiku"]);

// One line per agent with its default model: the pipeline's roles, then the merger, which runs in the close outside it.
export const AGENT_MODELS = Object.freeze({ ...MANIFEST.models, merger: "sonnet" });

// The agents a project may override: every agent the pipeline launches (the merger runs in the close, outside it).
export const OVERRIDABLE_AGENTS = Object.freeze(Object.keys(AGENT_MODELS).filter((agent) => agent !== "merger"));

// The values every run shares, whatever its project.
export const PIPELINE_CONSTANTS = Object.freeze({ ...MANIFEST.constants });

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

// The agent a phase of a manifest runs on: its track slot's model agent, else the first agent it declares, else null.
function phaseAgentOf(manifest, phaseId) {
  const slot = (Array.isArray(manifest?.track) ? manifest.track : []).find((candidate) => candidate?.phase === phaseId);
  if (typeof slot?.modelAgent === "string") return slot.modelAgent;
  const phase = (Array.isArray(manifest?.phases) ? manifest.phases : []).find((candidate) => candidate?.id === phaseId);
  const first = Array.isArray(phase?.agents) ? phase.agents[0] : null;
  return typeof first === "string" ? first : null;
}

// The model a phase of a manifest ran on, the project's valid override applied; null for a phase with no agent or an agent with no model, never a throw.
export function phaseModelOf(manifest, phaseId, projectAgents = null) {
  const agent = phaseAgentOf(manifest, phaseId);
  if (agent === null) return null;
  const override = projectAgents && Object.hasOwn(projectAgents, agent) ? projectAgents[agent]?.model : null;
  if (MODEL_NAMES.includes(override)) return override;
  const models = manifest?.models ?? {};
  return Object.hasOwn(models, agent) && typeof models[agent] === "string" ? models[agent] : null;
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
  return phaseIdsOf(MANIFEST);
}

// The slots of the studio track, in order: the number, the label, the agent, the agent whose model it shows and the canonical phase of each.
export const TRACK_SLOTS = MANIFEST.track;

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
