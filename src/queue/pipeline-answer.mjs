import { UserError } from "../config/errors.mjs";
import { phaseIdsOf } from "./pipeline-package.mjs";

// The fields the runtime has a writer for: a manifest declares which of them its pipeline records.
export const RUNTIME_FIELDS = Object.freeze(["type", "commitType", "qaMode", "termination", "slug", "pipelineLoops"]);

const EFFECT_KINDS = Object.freeze(["writeRunFile", "recordFields", "recordDecision", "saveIndex", "say"]);

// The closed grammar of a `next` action: what the runtime can tell the orchestrator to do.
const NEXT_RE = /^(?:launch (\S+)(?: stage=\d+)?(?: note=\S.*)?|terminate \S.*|gate \S.*|publish(?: --draft)?(?: remaining=\S.*)?|report|check (\S+))$/;

// A run artifact named by its bare file name: no directory, no traversal.
const BARE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Whether a value is a list holding only strings.
function isStringList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// What is wrong with a `writeRunFile` effect, or null.
function writeDefect(effect) {
  if (typeof effect.name !== "string" || !BARE_FILE_RE.test(effect.name) || effect.name.includes("..")) return `run file \`${String(effect.name)}\` is not a bare file name`;
  return typeof effect.text === "string" ? null : `run file \`${effect.name}\` has no text`;
}

// What is wrong with a `recordFields` effect, or null.
function fieldsDefect(effect, manifest) {
  const fields = effect.fields;
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) return "recordFields has no fields";
  const declared = Array.isArray(manifest.recordable) ? manifest.recordable : [];
  const undeclared = Object.keys(fields).find((name) => !declared.includes(name) || !RUNTIME_FIELDS.includes(name));
  return undeclared === undefined ? null : `field \`${undeclared}\` is not recordable`;
}

// Whether a value is a plain object.
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// What is wrong with a `recordDecision` effect, or null.
function decisionDefect(effect, manifest) {
  if (!Array.isArray(manifest.recordable) || !manifest.recordable.includes("decisions")) return "`decisions` is not recordable";
  const { decision } = effect;
  if (!isPlainObject(decision) || typeof decision.check !== "string" || typeof decision.next !== "string") return "recordDecision has no decision";
  return isPlainObject(effect.loops) ? null : "recordDecision has no loops";
}

// What is wrong with one effect, or null.
function effectDefect(effect, manifest) {
  if (effect === null || typeof effect !== "object" || !EFFECT_KINDS.includes(effect.kind)) return `unknown effect \`${String(effect?.kind)}\``;
  if (effect.kind === "writeRunFile") return writeDefect(effect);
  if (effect.kind === "recordFields") return fieldsDefect(effect, manifest);
  if (effect.kind === "recordDecision") return decisionDefect(effect, manifest);
  if (effect.kind === "saveIndex") return typeof effect.text === "string" ? null : "saveIndex has no text";
  return typeof effect.line === "string" ? null : "say has no line";
}

// What is wrong with an answer's phase record, or null.
function recordDefect(record, manifest) {
  if (record === null) return null;
  if (typeof record !== "object") return "the record is not an object";
  if (!phaseIdsOf(manifest).includes(record.phase)) return `record of unknown phase \`${String(record.phase)}\``;
  const { verdicts } = manifest.phases.find((phase) => phase.id === record.phase);
  if (!Array.isArray(verdicts)) return `the manifest's phase \`${record.phase}\` has no \`verdicts\` list`;
  return verdicts.includes(record.verdict) ? null : `verdict \`${String(record.verdict)}\` is not one the phase \`${record.phase}\` may record`;
}

// What is wrong with an answer's check memo, or null.
function memoDefect(memo) {
  if (memo === null || typeof memo !== "object") return "the answer has no memo";
  return typeof memo.key === "string" && memo.key !== "" ? null : "the memo has no key";
}

// What is wrong with an answer's `next` action, or null: one line of the grammar, launching a target and checking a phase the manifest declares.
export function nextDefect(next, manifest) {
  if (typeof next !== "string" || next.includes("\n")) return "the answer has no one-line `next`";
  const match = NEXT_RE.exec(next);
  if (match === null) return `\`next\` \`${next}\` is off the grammar`;
  const [, target, check] = match;
  if (target !== undefined && !(manifest.targets ?? []).includes(target)) return `\`next\` launches \`${target}\`, which is not a target of the manifest`;
  if (check !== undefined && !manifest.phases.some((phase) => phase.check === check)) return `\`next\` checks \`${check}\`, which is not a check of the manifest`;
  return null;
}

// The first thing wrong with a whole answer, or null.
function answerDefect(answer, manifest) {
  if (answer === null || typeof answer !== "object") return "the answer is not an object";
  if (typeof answer.then === "function") return "`check` answered a promise; it must be synchronous";
  if (!isStringList(answer.lines) || answer.lines.length === 0) return "the answer has no `lines`";
  if (!isStringList(answer.script)) return "the answer has no `script`";
  if (!Array.isArray(answer.effects)) return "the answer has no `effects`";
  if (answer.record === undefined) return "the answer has no `record`";
  return nextDefect(answer.next, manifest) ?? memoDefect(answer.memo) ?? recordDefect(answer.record, manifest) ?? answer.effects.map((effect) => effectDefect(effect, manifest)).find(Boolean) ?? null;
}

// Refuses, before anything is written, an answer of a pipeline's `check` that breaks the contract.
export function refuseInvalidAnswer(answer, manifest) {
  const defect = answerDefect(answer, manifest);
  if (defect !== null) throw new UserError(`the pipeline \`${manifest.name}\` answered an invalid check, so nothing was written: ${defect}`);
}
