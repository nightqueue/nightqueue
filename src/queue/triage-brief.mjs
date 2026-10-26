import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIPELINE_TASK_TYPES } from "../memory/runs.mjs";
import { COMMIT_TYPES } from "./branch-name.mjs";
import { skillReferencesDir } from "./skill-template.mjs";
import { wholeHeadingSectionOf } from "./stream.mjs";

// The `## Brief` the triage writes: the section `run check 01` copies into `00-brief.md`, and the gates it must pass first.

const BRIEF_HEADING = "## Brief";
// The fields a PROCEED triage must fill, in the order the gate names them.
export const REQUIRED_FIELDS = ["Affected area", "Context", "Objective", "Expected outcome", "Commit type"];
// The closed list of words that stand for "nothing" in a field, compared lower-cased.
const PLACEHOLDER_WORDS = ["n/a", "na", "not applicable", "tbd", "todo", "-", "—", "...", "…"];

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

// The field hints of the triager template the runtime renders; an unreadable template gives none, leaving only the placeholder words.
function templateHints() {
  if (cachedHints) return cachedHints;
  try {
    cachedHints = hintPatterns(readFileSync(join(skillReferencesDir(), "prompts", "triager.md"), "utf8"));
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

// The plain, lower-cased value of a field, or null when it is absent or unfilled.
function loweredField(text, field) {
  const value = briefFieldOf(briefSection(text), field);
  return value === null || isUnfilled(field, value) ? null : plainValue(value).toLowerCase();
}

// The Type the Brief states, only when it is one the pipeline runs; null otherwise.
export function briefType(text) {
  const type = loweredField(text, "Type");
  return PIPELINE_TASK_TYPES.includes(type) ? type : null;
}

// The commit type the Brief states, only when it is an accepted one; null otherwise.
export function briefCommitType(text) {
  const commitType = loweredField(text, "Commit type");
  return COMMIT_TYPES.includes(commitType) ? commitType : null;
}

// The run slug the Brief names, without decoration; null when absent or blank.
export function briefSlug(text) {
  const value = briefFieldOf(briefSection(text), "Slug");
  return value === null || isUnfilled("Slug", value) ? null : plainValue(value);
}

// The required fields a PROCEED Brief leaves absent or unfilled, in the gate's order.
function emptyFields(section) {
  return REQUIRED_FIELDS.filter((field) => {
    const value = briefFieldOf(section, field);
    return value === null || isUnfilled(field, value);
  });
}

// The gate of a stated field whose value is outside the accepted list, or none when it is absent, unfilled or accepted.
function invalidValueGates(section, { field, code, accepted }) {
  const value = briefFieldOf(section, field);
  if (value === null || isUnfilled(field, value)) return [];
  return accepted.includes(plainValue(value).toLowerCase()) ? [] : [{ code, evidence: plainValue(value) }];
}

// The gates of the triage's Brief: absent on any verdict; on PROCEED, a required field left empty or a Type or commit type outside its list.
export function briefGates(text, verdict) {
  const section = briefSection(text);
  if (section === null) return [{ code: "brief-missing", evidence: `${BRIEF_HEADING} absent` }];
  if (verdict !== "PROCEED") return [];
  return [
    ...emptyFields(section).map((field) => ({ code: "brief-field-empty", evidence: field })),
    ...invalidValueGates(section, { field: "Type", code: "brief-type-invalid", accepted: PIPELINE_TASK_TYPES }),
    ...invalidValueGates(section, { field: "Commit type", code: "brief-commit-type-invalid", accepted: COMMIT_TYPES }),
  ];
}
