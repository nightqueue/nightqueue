import { truncateByCodePoint } from "../memory/jobs.mjs";
import { PHASES } from "./narrate.mjs";
import { laneName, parseAttemptMarker, parseEventLine } from "./stream.mjs";
import { eachLineYielding } from "./yielding-lines.mjs";

const RECALL_TOOL_RE = /__(lesson_recall|memory_recall|decision_recall|index_recall)$/;
const LIST_KEYS = ["items", "hits", "results", "files", "decisions"];
const REF_PREFIX = { lesson_recall: "L", memory_recall: "M" };
const KIND_OF_TOOL = { decision_recall: "decision", lesson_recall: "lesson", index_recall: "index", memory_recall: "memory" };
const LESSON_TEXT_FIELDS = [
  ["root_cause", "Root cause"],
  ["solution", "Solution"],
  ["prevention", "Prevention"],
];
const TITLE_LIMIT = 120;
const TEXT_LIMIT = 2000;
const ERROR_LIMIT = 200;
const ORCHESTRATOR = "orchestrator";

// Milliseconds of an ISO timestamp, or null when the value is not a date.
function isoMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// The content blocks of an assistant or user event, an empty list for anything else.
function contentBlocks(event) {
  const content = event?.message?.content;
  return Array.isArray(content) ? content : [];
}

// The plain text of a tool_result content, whether a string or a list of text blocks.
function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

// The list of entries a recall answered: the array itself, the first known list field, or one whole record.
function entriesOf(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  const key = LIST_KEYS.find((name) => Array.isArray(value[name]));
  if (key) return value[key];
  return value.ref !== undefined || value.id !== undefined ? [value] : null;
}

// The ref a recalled entry is cited by: its own ref, a prefixed id, or the indexed path.
function refOf(tool, entry) {
  if (typeof entry.ref === "string" && entry.ref) return entry.ref;
  if (entry.id !== undefined && entry.id !== null) return `${REF_PREFIX[tool] ?? ""}${entry.id}`;
  return typeof entry.path === "string" ? entry.path : null;
}

// The short label of a recalled entry, clipped to the card's width.
function titleOf(entry) {
  const title = [entry.title, entry.name, entry.key, entry.responsibility, entry.path].find((value) => typeof value === "string" && value);
  return truncateByCodePoint(title ?? null, TITLE_LIMIT);
}

// The similarity a recalled entry scored: its cosine, else a score or similarity field; null when none is a number.
function scoreOf(entry) {
  const score = [entry.cosine, entry.score, entry.similarity].find((value) => typeof value === "number" && Number.isFinite(value));
  return score ?? null;
}

// The text the drawer shows for a hit: a lesson's labelled fields or a memory's value; null for the other kinds.
function textOf(tool, entry) {
  if (tool === "memory_recall") return typeof entry.value === "string" && entry.value ? truncateByCodePoint(entry.value, TEXT_LIMIT) : null;
  if (tool !== "lesson_recall") return null;
  const lines = LESSON_TEXT_FIELDS.filter(([field]) => typeof entry[field] === "string" && entry[field]).map(([field, label]) => `${label}: ${entry[field]}`);
  return lines.length ? truncateByCodePoint(lines.join("\n"), TEXT_LIMIT) : null;
}

// One hit of a recall: its ref, title and score, plus the fallback flag and the drawer text when present.
function hitOf(tool, entry) {
  const hit = { ref: refOf(tool, entry), title: titleOf(entry), score: scoreOf(entry) };
  if (typeof entry.via === "string" && entry.via) hit.via = entry.via;
  const text = textOf(tool, entry);
  if (text) hit.text = text;
  return hit;
}

// Turns a recall's tool_result into its hits, or the reason it cannot be read.
function parseRecallResult(tool, block) {
  const text = resultText(block.content);
  if (block.is_error === true) return { error: truncateByCodePoint(text || "the recall failed", ERROR_LIMIT) };
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "unreadable result" };
  }
  const entries = entriesOf(value);
  if (!entries) return { error: "unreadable result" };
  const hits = entries.filter((entry) => entry && typeof entry === "object").map((entry) => hitOf(tool, entry));
  return { hits };
}

// Seconds from the attempt's anchor to an event's instant, null when either is unknown.
function secondsSince(anchorMs, stampMs) {
  if (anchorMs === null || stampMs === null) return null;
  return Math.max(0, Math.round((stampMs - anchorMs) / 1000));
}

// Records the agent a subagent lane runs, from the tool call that launched it or its task_started event.
function trackLane(state, event) {
  if (event.type === "system" && event.subtype === "task_started" && typeof event.tool_use_id === "string" && event.subagent_type) {
    state.lanes.set(event.tool_use_id, laneName(event.subagent_type));
    return;
  }
  for (const block of contentBlocks(event)) {
    const type = block?.input?.subagent_type;
    if (block?.type === "tool_use" && typeof type === "string" && type.trim()) state.lanes.set(block.id, laneName(type));
  }
}

// Opens a pending recall for every recall tool call of an assistant event.
function collectCalls(state, event, stampMs) {
  if (event.type !== "assistant") return;
  const parent = typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id ? event.parent_tool_use_id : null;
  const agent = parent ? (state.lanes.get(parent) ?? "subagent") : ORCHESTRATOR;
  for (const block of contentBlocks(event)) {
    const match = block?.type === "tool_use" ? RECALL_TOOL_RE.exec(String(block.name ?? "")) : null;
    if (!match) continue;
    const recall = {
      id: block.id ?? null,
      tool: match[1],
      kind: KIND_OF_TOOL[match[1]],
      query: typeof block.input?.query === "string" ? block.input.query : null,
      agent,
      phase: PHASES.get(agent) ?? null,
      attempt: state.attempt,
      at_s: secondsSince(state.anchorMs, stampMs),
      pending: true,
      error: null,
      hits: [],
    };
    state.recalls.push(recall);
    if (recall.id) state.pending.set(recall.id, recall);
  }
}

// Settles the pending recalls whose tool_result arrives in a user event.
function collectResults(state, event) {
  if (event.type !== "user") return;
  for (const block of contentBlocks(event)) {
    const recall = block?.type === "tool_result" ? state.pending.get(block.tool_use_id) : null;
    if (!recall) continue;
    state.pending.delete(block.tool_use_id);
    Object.assign(recall, { pending: false, hits: [], error: null }, parseRecallResult(recall.tool, block));
  }
}

// The instant of an event, which also anchors the attempt's clock when no marker anchored it.
function eventStamp(state, event) {
  const stampMs = isoMs(event.timestamp);
  if (stampMs !== null && state.anchorMs === null) state.anchorMs = stampMs;
  return stampMs;
}

// Folds one raw log line into the scan state: an attempt marker, or a stream event.
function scanLine(state, line) {
  const marker = parseAttemptMarker(line);
  if (marker) {
    state.attempt = marker.attempt;
    state.anchorMs = isoMs(marker.at);
    return;
  }
  const event = parseEventLine(line);
  if (!event) return;
  const stampMs = eventStamp(state, event);
  trackLane(state, event);
  collectCalls(state, event, stampMs);
  collectResults(state, event);
}

// Every lesson/memory/decision/index recall of a job's whole log, in run order, scanned without stalling the event loop.
export async function jobRecalls(logText) {
  const state = { attempt: 1, anchorMs: null, lanes: new Map(), pending: new Map(), recalls: [] };
  await eachLineYielding(logText, (line) => scanLine(state, line));
  return state.recalls;
}
