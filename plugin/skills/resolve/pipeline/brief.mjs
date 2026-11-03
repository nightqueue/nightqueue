import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "../../../../src/host/paths.mjs";
import { PIPELINE_TASK_TYPES } from "../../../../src/memory/runs.mjs";
import { COMMIT_TYPES } from "../../../../src/queue/branch-name.mjs";
import { PLACEHOLDER_WORDS } from "../../../../src/queue/question-text.mjs";
import { wholeHeadingSectionOf } from "../../../../src/queue/stream.mjs";

// The `## Brief` the triage writes: the section `run check 01` copies into `00-brief.md`, and the gates it must pass first.

const BRIEF_HEADING = "## Brief";
const STAGES_FIELD = "**Stages:**";
// The fields a PROCEED triage must fill, in the order the gate names them.
export const REQUIRED_FIELDS = ["Affected area", "Context", "Objective", "Expected outcome", "Commit type"];
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

// A literal piece of text escaped for use inside a regular expression.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The anchored, case-insensitive pattern of one template hint, every `{{NAME}}` inside it matching any rendered value.
function hintPattern(hint) {
  const pieces = comparableValue(hint).split(/\{\{[A-Z_]+\}\}/).map(escapeRegExp);
  return new RegExp(`^${pieces.join(".*")}$`, "i");
}

// The hint of each `**Field:** <…>` line of a triager template, keyed by field, as the pattern a copied-verbatim hint matches.
export function hintPatterns(templateText) {
  const patterns = new Map();
  for (const rawLine of String(templateText ?? "").split("\n")) {
    const line = rawLine.replace(/\{\{[#/][A-Z_]+\}\}/g, "").trim();
    const match = /^\*\*([^*]+):\*\*\s+(<.*>)$/.exec(line);
    if (match) patterns.set(match[1].trim(), hintPattern(match[2]));
  }
  return patterns;
}

let cachedHints = null;

// The field hints of the Brief layout the triager agent carries; an unreadable agent file gives none, leaving only the placeholder words.
function templateHints() {
  if (cachedHints) return cachedHints;
  try {
    cachedHints = hintPatterns(readFileSync(join(packageRoot(), "plugin", "agents", "triager.md"), "utf8"));
  } catch {
    cachedHints = new Map();
  }
  return cachedHints;
}

// Whether a field value says nothing: blank, a closed placeholder word, or the template's own hint for that field copied as is.
function isUnfilled(field, value) {
  const plain = comparableValue(value);
  if (plain === "" || PLACEHOLDER_WORDS.includes(plain.toLowerCase())) return true;
  return templateHints().get(field)?.test(plain) === true;
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
  return value === null || isUnfilled(field, value) ? null : decidedToken(value, ACCEPTED_VALUES[field]);
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
  return value === null || isUnfilled("Slug", value) ? null : plainValue(value);
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

// The required fields a PROCEED Brief leaves absent or unfilled, in the gate's order.
function emptyFields(section) {
  return REQUIRED_FIELDS.filter((field) => {
    const value = briefFieldOf(section, field);
    return value === null || isUnfilled(field, value);
  });
}

// The gate of a stated field whose value is outside the accepted list, or none when it is absent, unfilled or accepted.
function invalidValueGates(section, { field, code }) {
  const value = briefFieldOf(section, field);
  if (value === null || isUnfilled(field, value)) return [];
  const accepted = ACCEPTED_VALUES[field];
  return accepted.includes(decidedToken(value, accepted)) ? [] : [{ code, evidence: plainValue(value) }];
}

// The gates of the triage's Brief: absent on any verdict; on PROCEED, a required field left empty or a Type or commit type outside its list.
export function briefGates(text, verdict) {
  const section = briefSection(text);
  if (section === null) return [{ code: "brief-missing", evidence: `${BRIEF_HEADING} absent` }];
  if (verdict !== "PROCEED") return [];
  return [
    ...emptyFields(section).map((field) => ({ code: "brief-field-empty", evidence: field })),
    ...invalidValueGates(section, { field: "Type", code: "brief-type-invalid" }),
    ...invalidValueGates(section, { field: "Commit type", code: "brief-commit-type-invalid" }),
  ];
}
