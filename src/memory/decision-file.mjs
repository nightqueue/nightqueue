import { UserError } from "../config/errors.mjs";
import { DECISION_STATUSES } from "./decisions.mjs";
import { ownerLabel, ownerOf } from "./scope.mjs";

const NUMBER_PREFIX = /^\d{4}\s+[-–—]\s+/;
const STATUS_WORD = /\bStatus\b\W*([A-Za-z]+)/;
const DATE = /\d{4}-\d{2}-\d{2}/;
const POINTER = /Decision\s+((?:[\w.-]+)?#\d+)\s+in the\s+(\S+)\s+store/;
const SUCCESSOR = /Superseded by\s+((?:[\w.-]+)?#\d+)/;
const FIELD_HEADING = /^##\s+(\S+)(.*)$/;
const FIELD_NAMES = new Map([
  ["context", "context"],
  ["decision", "decision"],
  ["consequences", "consequences"],
]);
const HEADING_SEPARATOR = /^\s*[-–—:]?\s*/;
const HTML_COMMENT = /(<!--[\s\S]*?(?:-->|$))/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SLUG_MAX = 60;

// The file name number of a decision: four digits, like the ADR files already published.
export function paddedNumber(number) {
  return String(number).padStart(4, "0");
}

// The status as the file header spells it: capitalized.
function statusWord(status) {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

// The words a file names its row by, without the closing period.
function pointerText(label, owner) {
  return `Decision ${label} in the ${owner} store`;
}

// The line a file names its row by, the one `stampPointer` writes.
export function pointerLine(label, owner) {
  return `${pointerText(label, owner)}.`;
}

// The header line of an exported file: status, creation date, the row it is and, when replaced, its successor.
function statusLine(row, successorLabel) {
  const date = String(row.created_at ?? "").slice(0, 10);
  const successor = row.status === "superseded" && successorLabel ? ` Superseded by ${successorLabel}.` : "";
  return `Status: ${statusWord(row.status)} (${date}). ${pointerLine(ownerLabel(row), ownerOf(row))}${successor}`;
}

// Markdown of one decision row, in the shape of the published ADR files.
export function renderDecisionFile(row, { successorLabel = null } = {}) {
  const sections = [
    `# ${paddedNumber(row.number)} - ${String(row.title).replace(/\s+/g, " ")}`,
    statusLine(row, successorLabel),
    "## Context",
    row.context,
    "## Decision",
    row.decision,
    ...(row.consequences ? ["## Consequences", row.consequences] : []),
  ];
  return `${sections.join("\n\n")}\n`;
}

// Index of the title line and of the first level-2 heading, the bounds of the header zone.
function headerBounds(lines) {
  const title = lines.findIndex((line) => line.startsWith("# "));
  const start = title === -1 ? 0 : title + 1;
  const firstHeading = lines.findIndex((line, index) => index >= start && line.startsWith("## "));
  return { title, start, end: firstHeading === -1 ? lines.length : firstHeading };
}

// The number part of a label like `#23` or `acme#3`.
function labelNumber(label) {
  return Number(label.slice(label.lastIndexOf("#") + 1));
}

// The text split into alternating parts: outside an HTML comment at even indexes, the comments (an unclosed one runs to the end) at odd ones.
function commentParts(text) {
  return text.split(HTML_COMMENT);
}

// The text without its HTML comments.
function withoutComments(text) {
  return commentParts(text)
    .filter((_, index) => index % 2 === 0)
    .join("");
}

// Status, date, pointer and successor read from the lines between the title and the first section, HTML comments ignored.
function parseHeader(zone) {
  const header = withoutComments(zone);
  const statusMatch = header.match(STATUS_WORD);
  const status = statusMatch ? statusMatch[1].toLowerCase() : null;
  const pointer = header.match(POINTER);
  const successor = header.match(SUCCESSOR);
  return {
    status: DECISION_STATUSES.includes(status) ? status : null,
    date: header.match(DATE)?.[0] ?? null,
    pointer: pointer ? { label: pointer[1], number: labelNumber(pointer[1]), owner: pointer[2] } : null,
    successor: successor ? { label: successor[1], number: labelNumber(successor[1]) } : null,
  };
}

// The field a level-2 heading opens, with the rest of its line; null for any other section.
function fieldHeading(line) {
  const match = line.match(FIELD_HEADING);
  const field = match ? FIELD_NAMES.get(match[1].replace(/\W+$/, "").toLowerCase()) : undefined;
  if (!field) return null;
  return { field, rest: match[2].replace(HEADING_SEPARATOR, "").trim() };
}

// The fence a line leaves open: the opening marker when it opens one, null when it closes the open one, the open one otherwise.
function nextFence(line, open) {
  const marker = line.match(FENCE)?.[1];
  if (!marker) return open;
  if (open === null) return marker;
  return marker[0] === open[0] && marker.length >= open.length && !line.trim().slice(marker.length) ? null : open;
}

// Context, decision and consequences of the body; any other section, and any heading inside a fenced block, stays inside the field it follows.
function parseBody(lines) {
  const fields = { context: [], decision: [], consequences: [] };
  const seen = new Set();
  let current = "context";
  let fence = null;
  for (const line of lines) {
    const heading = fence === null ? fieldHeading(line) : null;
    fence = nextFence(line, fence);
    if (!heading) {
      fields[current].push(line);
      continue;
    }
    current = heading.field;
    seen.add(current);
    if (heading.rest) fields[current].push(heading.rest);
  }
  const text = (field) => (seen.has(field) ? fields[field].join("\n").trim() : "");
  return { context: text("context"), decision: text("decision"), consequences: text("consequences") || null };
}

// Refuses a file whose required sections are missing or empty, naming the file.
function requireFields(parsed, source) {
  for (const field of ["title", "context", "decision"]) {
    if (parsed[field]) continue;
    const where = field === "title" ? "`# <title>` line" : `non-empty \`## ${statusWord(field)}\` section`;
    throw new UserError(`${source} has no ${where}; nothing imported`);
  }
}

// Reads a decision file (an exported one or a hand-written ADR) into the fields of a decision row.
export function parseDecisionFile(text, source = "the decision file") {
  if (typeof text !== "string") throw new UserError(`${source} is not text`);
  const lines = text.split(/\r?\n/);
  const bounds = headerBounds(lines);
  const title = bounds.title === -1 ? "" : lines[bounds.title].slice(2).replace(NUMBER_PREFIX, "").trim();
  const header = parseHeader(lines.slice(bounds.start, bounds.end).join("\n"));
  const body = parseBody(lines.slice(bounds.end));
  const parsed = { title, ...header, context: body.context, decision: body.decision, consequences: body.consequences };
  requireFields(parsed, source);
  return parsed;
}

// File name slug of a title: ASCII, lower-case, dashes, at most 60 characters cut at a dash.
export function slugOf(title) {
  const slug = String(title ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= SLUG_MAX) return slug || "decision";
  const lastDash = slug.slice(0, SLUG_MAX + 1).lastIndexOf("-");
  return lastDash > 0 ? slug.slice(0, lastDash) : slug.slice(0, SLUG_MAX);
}

// The zone with its first pointer outside an HTML comment replaced.
function replaceFirstPointer(zone, replacement) {
  const parts = commentParts(zone);
  const index = parts.findIndex((part, position) => position % 2 === 0 && POINTER.test(part));
  if (index === -1) return zone;
  parts[index] = parts[index].replace(POINTER, replacement);
  return parts.join("");
}

// The file with its pointer naming the row it was imported as: replaced in the header, or inserted after the title.
export function stampPointer(text, label, owner) {
  const lines = String(text ?? "").split("\n");
  const { start, end } = headerBounds(lines);
  const zone = lines.slice(start, end).join("\n");
  if (POINTER.test(withoutComments(zone))) {
    const stamped = replaceFirstPointer(zone, () => pointerText(label, owner));
    return [...lines.slice(0, start), stamped, ...lines.slice(end)].join("\n");
  }
  const inserted = start > 0 ? ["", pointerLine(label, owner)] : [pointerLine(label, owner), ""];
  return [...lines.slice(0, start), ...inserted, ...lines.slice(start)].join("\n");
}
