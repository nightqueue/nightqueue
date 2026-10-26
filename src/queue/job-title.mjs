import { briefBody } from "./prompt-brief.mjs";
import { COMMIT_TYPES } from "./branch-name.mjs";

// A `Tier:`/`Tier raised:` header line an older runtime or operator wrote above the brief, kept as the compatibility shim for prompts queued before the tier was removed.
const RUNTIME_HEADER = /^\s*tier(\s+raised)?\s*:/i;

export const TITLE_LIMIT = 120;
const HEADING_MARKER = /^#{1,6}\s+/;
const BARE_HEADINGS = new Set(["brief", "task"]);
const LEADING_LABEL = /^\s*(?:\*\*[^*\n]+?:\*\*|\*\*[^*\n]+?\*\*:)\s*/;
const OBJECTIVE_LINE = /^\s*(?:\*\*Objective:\*\*|\*\*Objective\*\*:)\s*(.*)$/i;
const CONTINUATION_BREAK = /^\s*(?:\*\*|#|[-*]\s|$)/;
const CONVENTIONAL_PREFIX = new RegExp(`^(?:${COMMIT_TYPES.join("|")})(?:\\([^)]*\\))?!?:\\s+`, "i");
const FIRST_SENTENCE = /^(.+?[.!?])(?=\s|$)/;

// The prompt text without its leading blank and runtime-header lines.
function withoutRuntimeHeader(text) {
  const lines = String(text ?? "").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "" && !RUNTIME_HEADER.test(line));
  return first < 0 ? "" : lines.slice(first).join("\n");
}

// The text a provisional slug falls back to: the brief of the prompt when it has one, the whole prompt otherwise, never a runtime header.
function slugSource(prompt) {
  const brief = withoutRuntimeHeader(briefBody(prompt));
  return brief.trim() ? brief : withoutRuntimeHeader(prompt);
}

// Whether a prompt line is a heading that only names a section (`## Brief`, `# Task`) and says nothing itself.
function isBareHeading(line) {
  return HEADING_MARKER.test(line) && BARE_HEADINGS.has(line.replace(HEADING_MARKER, "").trim().toLowerCase());
}

// Text on one line with markdown emphasis and backticks taken out.
function plainLine(text) {
  return String(text ?? "").replace(/\*\*|__|[*`]/g, "").replace(/\s+/g, " ").trim();
}

// Cuts a title to the limit, the ellipsis included in it.
function clipTitle(text) {
  const points = Array.from(text);
  return points.length <= TITLE_LIMIT ? text : `${points.slice(0, TITLE_LIMIT - 1).join("")}…`;
}

// A title as an operator or a pull request gave it: one line cut to the limit, or null when it is blank or not text.
export function storableTitle(text) {
  if (typeof text !== "string") return null;
  const title = text.replace(/\s+/g, " ").trim();
  return title ? clipTitle(title) : null;
}

// A title as shown: one plain line cut to the limit, or null when nothing is left.
export function normalizeTitle(text) {
  const title = plainLine(text);
  return title ? clipTitle(title) : null;
}

// The first useful line of the prompt's brief (else of the prompt), heading marker and leading `**Label:**` removed.
function firstBriefLine(prompt) {
  const lines = slugSource(prompt).split("\n").map((entry) => entry.trim());
  for (const line of lines) {
    if (line === "" || isBareHeading(line)) continue;
    const title = normalizeTitle(line.replace(HEADING_MARKER, "").replace(LEADING_LABEL, ""));
    if (title) return title;
  }
  return null;
}

// The text of the brief's `**Objective:**` field: its line and the plain lines that continue it, or null without one.
function objectiveText(prompt) {
  const lines = String(briefBody(prompt) ?? "").split("\n");
  const start = lines.findIndex((line) => OBJECTIVE_LINE.test(line));
  if (start < 0) return null;
  const parts = [OBJECTIVE_LINE.exec(lines[start])[1]];
  for (const line of lines.slice(start + 1)) {
    if (CONTINUATION_BREAK.test(line)) break;
    parts.push(line);
  }
  return plainLine(parts.join(" ")) || null;
}

// The first sentence of the brief's objective, or null when the prompt has none.
function objectiveTitle(prompt) {
  const text = objectiveText(prompt);
  return text ? normalizeTitle(FIRST_SENTENCE.exec(text)?.[1] ?? text) : null;
}

// A pull request title without its Conventional Commits `type(scope): ` prefix.
function prTitleText(prTitle) {
  return normalizeTitle(plainLine(prTitle).replace(CONVENTIONAL_PREFIX, ""));
}

// The readable title of a job, first non-empty of: the pull request title, the operator title, the brief's objective, the first brief line; else null.
export function jobTitle(job) {
  return prTitleText(job?.pr_title) ?? normalizeTitle(job?.title) ?? objectiveTitle(job?.prompt) ?? firstBriefLine(job?.prompt);
}

// The text a provisional slug is taken from: the operator title, the brief's objective, then the brief's text with its field labels removed; never the pull request.
export function slugText(job) {
  const stated = normalizeTitle(job?.title) ?? objectiveTitle(job?.prompt);
  return stated ?? slugSource(job?.prompt).replace(/^\s*\*\*[^*\n]+?:\*\*/gm, "");
}
