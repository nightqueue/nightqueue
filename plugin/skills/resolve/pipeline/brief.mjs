import { PIPELINE_TASK_TYPES } from "../../../../src/memory/runs.mjs";
import { COMMIT_TYPES } from "../../../../src/queue/branch-name.mjs";
import { PLACEHOLDER_WORDS } from "../../../../src/queue/question-text.mjs";
import { wholeHeadingSectionOf } from "../../../../src/queue/stream.mjs";

// The `## Brief` the triage writes: the section `run check 01` copies into `00-brief.md`, and the facts read from it.

const BRIEF_HEADING = "## Brief";
const STAGES_FIELD = "**Stages:**";
// The values each closed field accepts.
const ACCEPTED_VALUES = { Type: PIPELINE_TASK_TYPES, "Commit type": COMMIT_TYPES };
// What sits between two options of a list copied undecided.
const OPTION_SEPARATOR_RE = /^\s*(?:[|/,]|or\b|vs\b\.?)\s*/;

// The `## Brief` section of the triage, heading included, matched as a whole unfenced heading line; null when absent.
export function briefSection(text) {
  return wholeHeadingSectionOf(String(text ?? ""), BRIEF_HEADING);
}

// The value of one `**Field:** value` line of the Brief, read the way the phase prompts read `00-brief.md`; null when no line carries it.
function briefFieldOf(section, field) {
  const label = `**${field}:**`;
  const line = String(section ?? "")
    .split("\n")
    .find((candidate) => candidate.trim().startsWith(label));
  return line === undefined ? null : line.trim().slice(label.length).trim();
}

// A field value without its markdown decoration (bold, backticks).
function plainValue(value) {
  return String(value ?? "")
    .replace(/[*`]/g, "")
    .trim();
}

// A field value without decoration and with every run of whitespace collapsed to one space.
function comparableValue(value) {
  return plainValue(value).replace(/\s+/g, " ");
}

// Whether a field value says nothing: blank, a closed placeholder word, or a `<…>` hint copied as is.
function isUnfilled(value) {
  const plain = comparableValue(value);
  return plain === "" || PLACEHOLDER_WORDS.includes(plain.toLowerCase()) || /^<.*>$/.test(plain);
}

// The lower-cased run of type characters a value opens with, so a suffix such as ` (security)` or `(queue)` never decides it; empty when it opens with anything else.
function leadingToken(value) {
  return /^[a-z/_-]*/.exec(plainValue(value).toLowerCase())[0];
}

// The token a value decides on: its leading token, or empty, which no accepted list holds, when a list separator and another accepted value follow it.
function decidedToken(value, accepted) {
  const token = leadingToken(value);
  const rest = plainValue(value).toLowerCase().slice(token.length);
  const separator = OPTION_SEPARATOR_RE.exec(rest);
  if (separator === null) return token;
  return accepted.includes(leadingToken(rest.slice(separator[0].length))) ? "" : token;
}

// The decided token of a field, or null when it is absent or unfilled.
function fieldToken(text, field) {
  const value = briefFieldOf(briefSection(text), field);
  return value === null || isUnfilled(value) ? null : decidedToken(value, ACCEPTED_VALUES[field]);
}

// The Type the Brief states, only when it is one the pipeline runs; null otherwise.
export function briefType(text) {
  const type = fieldToken(text, "Type");
  return PIPELINE_TASK_TYPES.includes(type) ? type : null;
}

// The commit type the Brief states, only when it is an accepted one; null otherwise.
export function briefCommitType(text) {
  const commitType = fieldToken(text, "Commit type");
  return COMMIT_TYPES.includes(commitType) ? commitType : null;
}

// The run slug the Brief names, without decoration; null when absent or blank.
export function briefSlug(text) {
  const value = briefFieldOf(briefSection(text), "Slug");
  return value === null || isUnfilled(value) ? null : plainValue(value);
}

// The lines of the Brief's `**Stages:**` field, trimmed, blank ones left out; none when it has no such field.
export function briefStageLines(text) {
  const lines = String(text ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith(STAGES_FIELD));
  if (start < 0) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.trim() === "" || /^(\*\*|#)/.test(line));
  const field = [lines[start].slice(STAGES_FIELD.length), ...(end < 0 ? rest : rest.slice(0, end))];
  return field.map((line) => line.trim()).filter((line) => line !== "");
}
