import { truncateByCodePoint } from "../memory/jobs.mjs";
import { PHASES } from "./narrate.mjs";
import { laneName, parseAttemptMarker, parseEventLine } from "./stream.mjs";
import { eachLineYielding } from "./yielding-lines.mjs";

const RECALL_TOOL_RE = /__(lesson_recall|memory_recall|decision_recall|index_recall)$/;
const LIST_KEYS = ["items", "hits", "results", "files", "decisions"];
const REF_PREFIX = { lesson_recall: "L", memory_recall: "M" };
const TITLE_LIMIT = 120;
const ERROR_LIMIT = 200;
const ORCHESTRATOR = "orchestrator";

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

// Turns a recall's tool_result into its refs/titles, or the reason it cannot be read.
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
  const results = entries.filter((entry) => entry && typeof entry === "object").map((entry) => ({ ref: refOf(tool, entry), title: titleOf(entry) }));
  return { results };
}

// The input fields of a recall worth showing beside its query.
function inputSubset(input) {
  const subset = {};
  for (const name of ["project", "target"]) {
    if (typeof input?.[name] === "string" && input[name]) subset[name] = input[name];
  }
  return subset;
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
function collectCalls(state, event) {
  if (event.type !== "assistant") return;
  const parent = typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id ? event.parent_tool_use_id : null;
  const agent = parent ? (state.lanes.get(parent) ?? "subagent") : ORCHESTRATOR;
  for (const block of contentBlocks(event)) {
    const match = block?.type === "tool_use" ? RECALL_TOOL_RE.exec(String(block.name ?? "")) : null;
    if (!match) continue;
    const recall = {
      id: block.id ?? null,
      tool: match[1],
      query: typeof block.input?.query === "string" ? block.input.query : null,
      input: inputSubset(block.input),
      agent,
      phase: PHASES.get(agent) ?? null,
      attempt: state.attempt,
      pending: true,
      results: [],
      error: null,
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
    Object.assign(recall, { pending: false, results: [], error: null }, parseRecallResult(recall.tool, block));
  }
}

// Folds one raw log line into the scan state: an attempt marker, or a stream event.
function scanLine(state, line) {
  const marker = parseAttemptMarker(line);
  if (marker) {
    state.attempt = marker.attempt;
    return;
  }
  const event = parseEventLine(line);
  if (!event) return;
  trackLane(state, event);
  collectCalls(state, event);
  collectResults(state, event);
}

// Groups recalls by phase and agent, in the order each group first appears in the log.
function groupRecalls(recalls) {
  const groups = new Map();
  for (const { agent, phase, ...recall } of recalls) {
    const key = `${phase ?? "-"}:${agent}`;
    if (!groups.has(key)) groups.set(key, { phase, agent, recalls: [] });
    groups.get(key).recalls.push(recall);
  }
  return [...groups.values()];
}

// Every lesson/memory/decision/index recall of a job's whole log, grouped by phase and agent, scanned without stalling the event loop.
export async function jobRecalls(logText) {
  const state = { attempt: 1, lanes: new Map(), pending: new Map(), recalls: [] };
  await eachLineYielding(logText, (line) => scanLine(state, line));
  return groupRecalls(state.recalls);
}
