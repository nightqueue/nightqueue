import { basename } from "node:path";
import { truncateByCodePoint } from "../memory/jobs.mjs";
import { clockLabel } from "./hints.mjs";
import { extractNotice, extractPrUrl, hasGateMarker, laneName, parseEventLine, parseSlugLine } from "./stream.mjs";

const ATTEMPT_LINE_RE = /^=== attempt (\d+) @ (\S+) ===$/;
const RATE_PAUSE_LINE_RE = /^=== rate limit until (\S+) @ (\S+) ===$/;
const RATE_RESUME_LINE_RE = /^=== rate limit over @ (\S+) ===$/;
const MARKER_LINE_RE = /^=== (.+) @ (\S+) ===$/;

const TEXT_LIMIT = 200;
const NOTICE_LIMIT = 400;
const TARGET_LIMIT = 40;
const DESCRIPTION_LIMIT = 80;
const MODEL_LIMIT = 20;
const MAX_PLAIN_LINES = 20;

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);
const MCP_TARGET_FIELDS = ["file_path", "path", "pattern", "project", "repo_root", "slug", "query", "name", "key", "id"];
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
const PHASES = new Map([
  ["triager", 1],
  ["explore", 2],
  ["architect", 3],
  ["coder", 4],
  ["qa-guardian", 5],
  ["verifier", 6],
]);

const GLYPHS = {
  ratePause: "⏸",
  rateResume: "▶",
  attempt: "═",
  resultEnd: "═",
  text: "»",
  tool: "·",
  quiet: "·",
  laneOpen: "▶",
  laneClose: "◀",
  slug: "⚑",
  gate: "⚠",
  marker: "⚠",
  laneOrphan: "⚠",
  truncated: "⚠",
  pr: "✓",
  notice: "ℹ",
  plain: "ℹ",
  skippedSummary: "ℹ",
  toolError: "✗",
};

const COLORS = {
  ratePause: "33",
  rateResume: "32",
  laneOpen: "36",
  laneClose: "36",
  gate: "31",
  marker: "31",
  laneOrphan: "31",
  truncated: "31",
  toolError: "31",
  pr: "32",
};

// Milliseconds of an ISO timestamp, or null when the value is not a date.
function isoMs(value) {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Trims and truncates a text by code point, so a surrogate pair is never cut in half.
function clip(value, max) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? truncateByCodePoint(text, max) : "";
}

// First non empty line of a text, the only part of it a narration line ever shows.
function firstLine(value) {
  const lines = String(value ?? "").split("\n");
  return lines.find((line) => line.trim() !== "") ?? "";
}

// Relative clock of a narration line as `mm:ss`; an unknown time is `--:--`, never a zero nobody measured.
export function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "--:--";
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

// Human duration of a finished lane: seconds under a minute, minutes under an hour, hours above it.
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

// Readable name of a tool: an MCP tool shows only the last segment of its qualified name.
function toolLabel(name) {
  const text = String(name ?? "").trim() || "tool";
  return text.startsWith("mcp__") ? (text.split("__").pop() || text) : text;
}

// Value of the first allowlisted field of an MCP tool input; a field outside the list never reaches a line.
function safeTargetField(input) {
  for (const field of MCP_TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

// Short and safe target of a tool call: a file name, a command, a pattern; never the whole input.
function shortTarget(name, input) {
  if (!input || typeof input !== "object") return "";
  if (FILE_TOOLS.has(name)) return clip(basename(String(input.file_path ?? "")), TARGET_LIMIT);
  if (name === "Bash") return clip(firstLine(input.command), TARGET_LIMIT);
  if (name === "Grep" || name === "Glob") return clip(input.pattern, TARGET_LIMIT);
  if (String(name).startsWith("mcp__")) return clip(safeTargetField(input), TARGET_LIMIT);
  return "";
}

// What a tool call says in one line: the intent the model wrote for it first, because that is what a human reads the log for,
// then the tool and its target, which is what stays machine readable. A call without an intent keeps the tool-first shape it always had.
function toolNarration(name, input) {
  const label = toolLabel(name);
  const target = shortTarget(name, input);
  const call = target ? `${label} ${target}` : label;
  const intent = clip(firstLine(input?.description), DESCRIPTION_LIMIT);
  return intent ? `${intent} — ${call}` : call;
}

// Label of a lane: its name, the phase of the pipeline and the model the orchestrator picked for it, each part only when it is known.
// The model comes from the `tool_use` block that launched the subagent, the only event of the stream that carries it: a lane opened from `task_started` has none.
function laneLabel(subagentType, model) {
  const name = laneName(subagentType);
  const phase = PHASES.get(name);
  const detail = [phase ? `phase ${phase}` : null, clip(model, MODEL_LIMIT) || null].filter(Boolean);
  return detail.length ? `${name} (${detail.join(", ")})` : name;
}

// Distance between two clock readings, null when either of them is unknown.
function elapsedBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  return Math.max(0, toMs - fromMs);
}

// Relative time of the current position of the stream, null while no clock has been seen.
function elapsedOf(state) {
  return elapsedBetween(state.anchorMs, state.clockMs);
}

// One narration line, already carrying its relative time and the lane it belongs to.
function narrationEvent(state, kind, text, { indent = false, lane = null } = {}) {
  return { kind, text, indent, lane, elapsedMs: elapsedOf(state) };
}

// One narration line of a lane child, labelled only when more than one lane is open at that moment.
function laneLine(state, kind, text, lane) {
  if (!lane) return narrationEvent(state, kind, text);
  return narrationEvent(state, kind, text, { indent: true, lane: state.lanes.size > 1 ? lane.name : null });
}

// Moves the clock forward, anchoring the first timestamp when no attempt marker anchored it first.
function advanceClock(state, ms) {
  state.clockMs = ms;
  if (state.anchorMs === null) state.anchorMs = ms;
}

// Reports the lines that could not be read, so a corrupted stretch of the log never disappears in silence.
function flushSkipped(state) {
  if (state.skipped < 1) return [];
  const line = narrationEvent(state, "skippedSummary", `${state.skipped} unreadable log lines skipped`);
  state.skipped = 0;
  return [line];
}

// Opens an attempt: every attempt is its own session, so the clock and all the state restart with it.
function openAttempt(state, attempt, iso) {
  const pending = flushSkipped(state);
  const ms = isoMs(iso);
  state.anchorMs = ms;
  state.clockMs = ms;
  state.lanes.clear();
  state.closedLanes.clear();
  state.tools.clear();
  state.seen.clear();
  state.plain = 0;
  return [...pending, narrationEvent(state, "attempt", `attempt ${attempt}`)];
}

// A `=== <what> @ <iso> ===` line the runner wrote, such as the ownership it lost; it never restarts the clock.
function logMarker(state, what, iso) {
  const ms = isoMs(iso);
  if (ms !== null) advanceClock(state, ms);
  return [narrationEvent(state, "marker", clip(what, TEXT_LIMIT))];
}

// The marker the runner wrote when a rate limit put the run on hold, said as the wait it is instead of a raw status.
function rateLimitPause(state, untilIso, iso) {
  const ms = isoMs(iso);
  if (ms !== null) advanceClock(state, ms);
  const untilMs = isoMs(untilIso);
  const until = untilMs === null ? clip(untilIso, TEXT_LIMIT) : clockLabel(untilMs, ms ?? Date.now());
  return [narrationEvent(state, "ratePause", `rate limit hit - waiting until ${until}`)];
}

// The marker the runner wrote when the limit was over and the same run went on.
function rateLimitResume(state, iso) {
  const ms = isoMs(iso);
  if (ms !== null) advanceClock(state, ms);
  return [narrationEvent(state, "rateResume", "resumed")];
}

// A line that is not JSON: a corrupted event when it looks like one, otherwise plain text the runner wrote.
function narratePlain(state, line) {
  const text = line.trim();
  if (text.startsWith("{") || text.startsWith("[") || state.plain >= MAX_PLAIN_LINES) {
    state.skipped += 1;
    return [];
  }
  state.plain += 1;
  return [narrationEvent(state, "plain", clip(text, TEXT_LIMIT))];
}

// Last standalone `QUEUE_SLUG:` line of a text, the only shape the slug is ever read from.
function lastSlug(text) {
  let found = null;
  for (const line of text.split("\n")) found = parseSlugLine(line) ?? found;
  return found;
}

// Body of a notice, indented under its own line and clipped so a long summary never floods the narration.
function noticeBody(notice) {
  return clip(notice, NOTICE_LIMIT)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// Tells whether the narration had to cut the notice, the only case where the operator has to be sent somewhere else.
function noticeClipped(notice) {
  return Array.from(String(notice ?? "").trim()).length > NOTICE_LIMIT;
}

// Text of a `notice` narration line, so a notice read from the row of a job prints exactly like one that came from the stream; a notice the narration had to cut ends pointing at the command that shows it whole.
export function noticeNarration(notice, { jobId = null } = {}) {
  const body = `notice\n${noticeBody(notice)}`;
  if (jobId === null || !noticeClipped(notice)) return body;
  return `${body}\n    read the whole notice with: nightshift queue status ${jobId}`;
}

// Emits a marker only when its VALUE changed, because the slug and the pull request echo in many events.
function pushMarker(state, out, kind, value, text) {
  if (state.seen.get(kind) === value) return;
  state.seen.set(kind, value);
  out.push(narrationEvent(state, kind, text));
}

// The markers of the run the orchestrator wrote in a text: slug, gate, pull request and notice.
function narrateMarkers(state, text) {
  const out = [];
  const slug = lastSlug(text);
  if (slug) pushMarker(state, out, "slug", slug, `slug: ${slug}`);
  if (hasGateMarker(text)) pushMarker(state, out, "gate", "gate", "gate: the pipeline is waiting for a human decision");
  const prUrl = extractPrUrl(text);
  if (prUrl) pushMarker(state, out, "pr", prUrl, `pull request: ${prUrl}`);
  const notice = extractNotice(text);
  if (notice) pushMarker(state, out, "notice", notice, noticeNarration(notice, { jobId: state.jobId }));
  return out;
}

// What the orchestrator said, plus the markers of that same text; a subagent only speaks under `--all`.
function narrateText(state, raw, lane) {
  const text = String(raw ?? "");
  if (!text.trim()) return [];
  const line = clip(firstLine(text), TEXT_LIMIT);
  if (lane) return state.all ? [laneLine(state, "text", line, lane)] : [];
  return [narrationEvent(state, "text", line), ...narrateMarkers(state, text)];
}

// Opens a lane for a subagent, the only event that indents everything reported under it.
function openLane(state, { toolUseId, subagentType, description, model = null }) {
  const lane = { name: laneName(subagentType), label: laneLabel(subagentType, model), openMs: state.clockMs, tools: 0, edits: 0 };
  if (toolUseId) state.lanes.set(toolUseId, lane);
  const detail = clip(description, DESCRIPTION_LIMIT);
  return narrationEvent(state, "laneOpen", detail ? `${lane.label} — ${detail}` : lane.label);
}

// A tool call: the one that carries a `subagent_type` opens a lane, whatever the tool happens to be named.
function narrateToolUse(state, block, lane) {
  const name = String(block.name ?? "").trim() || "tool";
  const id = typeof block.id === "string" && block.id ? block.id : null;
  if (id) state.tools.set(id, toolLabel(name));
  const subagentType = block.input?.subagent_type;
  if (typeof subagentType === "string" && subagentType.trim()) {
    return [openLane(state, { toolUseId: id, subagentType, description: block.input?.description, model: block.input?.model })];
  }
  if (lane) {
    lane.tools += 1;
    if (EDIT_TOOLS.has(name)) lane.edits += 1;
  }
  return [laneLine(state, "tool", toolNarration(name, block.input), lane)];
}

// First readable text of a tool result, which the CLI writes either as a string or as blocks.
function resultContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
}

// A tool result: only a failure is narrated, and only its first line, never the output of a success.
function narrateToolResult(state, block, lane) {
  if (block?.is_error !== true) return [];
  const name = state.tools.get(block.tool_use_id) ?? "tool";
  const detail = clip(firstLine(resultContentText(block.content)), TEXT_LIMIT);
  return [laneLine(state, "toolError", detail ? `${name} failed: ${detail}` : `${name} failed`, lane)];
}

// One block of a message, which is a text, a tool call, a tool result or something the narration ignores.
function narrateBlock(state, block, lane) {
  if (block?.type === "text") return narrateText(state, block.text, lane);
  if (block?.type === "tool_use") return narrateToolUse(state, block, lane);
  if (block?.type === "tool_result") return narrateToolResult(state, block, lane);
  return [];
}

// The lane an event belongs to, open or already closed, or null when it is the orchestrator.
function laneOf(state, event) {
  const parent = event?.parent_tool_use_id;
  if (typeof parent !== "string" || !parent) return null;
  return state.lanes.get(parent) ?? state.closedLanes.get(parent) ?? null;
}

// An `assistant` or `user` event, the two that carry the blocks of a message.
function narrateMessage(state, event) {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  const lane = laneOf(state, event);
  const out = [];
  for (const block of blocks) out.push(...narrateBlock(state, block, lane));
  return out;
}

// What is known about a finished lane; anything the narrator did not observe is reported as unknown.
function laneSummary(state, lane, usage) {
  const durationMs = Number.isFinite(usage?.duration_ms) ? usage.duration_ms : elapsedBetween(lane?.openMs, state.clockMs);
  const reported = Number.isFinite(usage?.tool_uses) ? usage.tool_uses : null;
  const tools = reported ?? lane?.tools ?? null;
  const observed = lane !== null && (lane.tools > 0 || (reported ?? 0) === 0);
  const edits = observed ? `${lane.edits} edits` : "edits unknown";
  const toolsText = tools === null ? "tools unknown" : `${tools} tools`;
  return `${formatDuration(durationMs)} · ${toolsText} · ${edits}`;
}

// Closes the lane of a subagent that reported back, keeping its id known so a late block still belongs to it.
function closeLane(state, event) {
  const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
  const lane = state.lanes.get(id) ?? null;
  state.lanes.delete(id);
  if (id) state.closedLanes.set(id, lane ?? { name: "subagent", label: "subagent", openMs: null, tools: 0, edits: 0 });
  const status = typeof event.status === "string" && event.status ? event.status : "finished";
  const label = lane?.label ?? "subagent";
  return [narrationEvent(state, "laneClose", `${label} ${status} (${laneSummary(state, lane, event.usage)})`)];
}

// A `system` event: only the two that open and close a subagent lane say anything to the operator.
function narrateSystem(state, event) {
  if (event.subtype === "task_started") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (!id || state.lanes.has(id)) return [];
    return [openLane(state, { toolUseId: id, subagentType: event.subagent_type, description: event.description })];
  }
  if (event.subtype === "task_notification") return closeLane(state, event);
  return [];
}

// The final event of a session: its markers and the subtype that says whether it succeeded.
function narrateResult(state, event) {
  const text = typeof event.result === "string" ? event.result : "";
  const subtype = String(event.subtype ?? "unknown");
  return [...narrateMarkers(state, text), narrationEvent(state, "resultEnd", `result: ${subtype}`)];
}

// A rate limit event, which is only worth a line when the provider stopped allowing the traffic.
function narrateRateLimit(state, event) {
  const status = event.rate_limit_info?.status;
  if (typeof status !== "string" || !status || status === "allowed") return [];
  return [narrationEvent(state, "plain", `rate limit: ${clip(status, TEXT_LIMIT)}`)];
}

// One parsed event of the stream, routed by its type.
function narrateEvent(state, event) {
  const stamp = isoMs(event.timestamp);
  if (stamp !== null) advanceClock(state, stamp);
  if (event.type === "assistant" || event.type === "user") return narrateMessage(state, event);
  if (event.type === "system") return narrateSystem(state, event);
  if (event.type === "result") return narrateResult(state, event);
  if (event.type === "rate_limit_event") return narrateRateLimit(state, event);
  return [];
}

// One raw line of the log, which is an attempt marker, another marker, an event or plain text.
function narrateLine(state, rawLine) {
  const line = String(rawLine ?? "");
  if (!line.trim()) return [];
  const attempt = ATTEMPT_LINE_RE.exec(line);
  if (attempt) return openAttempt(state, attempt[1], attempt[2]);
  const paused = RATE_PAUSE_LINE_RE.exec(line);
  if (paused) return rateLimitPause(state, paused[1], paused[2]);
  const resumed = RATE_RESUME_LINE_RE.exec(line);
  if (resumed) return rateLimitResume(state, resumed[1]);
  const marker = MARKER_LINE_RE.exec(line);
  if (marker) return logMarker(state, marker[1], marker[2]);
  const event = parseEventLine(line);
  return event ? narrateEvent(state, event) : narratePlain(state, line);
}

// What is left to say when the stream ends: the lanes that never came back and the lines nobody could read.
// Closes the narration. A lane still open when the job is over never reported back; while the job is still running it is simply in progress, and saying otherwise would be a lie.
function finishNarration(state, { running = false } = {}) {
  const out = [];
  for (const lane of state.lanes.values()) {
    out.push(running ? narrationEvent(state, "laneOpen", `${lane.label} still running`) : narrationEvent(state, "laneOrphan", `${lane.label} never reported back`));
  }
  state.lanes.clear();
  return [...out, ...flushSkipped(state)];
}

// A narrator of one job log: it takes raw lines, one at a time, and answers with the lines to print.
export function createNarrator({ all = false, jobId = null } = {}) {
  const state = { all: all === true, jobId: jobId ?? null, anchorMs: null, clockMs: null, lanes: new Map(), closedLanes: new Map(), tools: new Map(), seen: new Map(), skipped: 0, plain: 0 };
  return {
    push: (rawLine) => narrateLine(state, rawLine),
    finish: (options) => finishNarration(state, options),
    note: (kind, text) => narrationEvent(state, kind, text),
  };
}

// Narrates a whole log that is already on disk, in one pass.
export function narrateLog(text, options = {}) {
  const narrator = createNarrator(options);
  const events = [];
  for (const line of String(text ?? "").split("\n")) events.push(...narrator.push(line));
  return [...events, ...narrator.finish({ running: options.running === true })];
}

// Last thing the orchestrator said in a log, the one narration line a table of jobs has room for.
export function lastOrchestratorLine(text) {
  let last = "";
  for (const event of narrateLog(text)) {
    if (event.kind === "text" && !event.indent) last = event.text;
  }
  return last;
}

// Kinds of narration that say what the job is doing right now; the bookkeeping of the narration (attempt separators, quiet ticks, summaries) never does.
const LIVE_KINDS = new Set(["text", "tool", "laneOpen", "laneClose", "slug", "gate", "marker", "pr", "notice", "ratePause", "rateResume"]);

// Last line of the narration as `queue log` prints it, glyph and lane label included: the same line the operator would read at the bottom of the log.
export function lastNarratedLine(text) {
  const narrator = createNarrator();
  let last = "";
  const events = [];
  for (const line of String(text ?? "").split("\n")) events.push(...narrator.push(line));
  for (const event of events) {
    if (!LIVE_KINDS.has(event.kind)) continue;
    const label = event.lane ? `[${event.lane}] ` : "";
    last = `${GLYPHS[event.kind] ?? GLYPHS.tool} ${label}${event.text ?? ""}`;
  }
  return last;
}

// Wraps a text in an SGR color, or returns it untouched when there is no color to apply.
function paint(text, code) {
  return code ? `\u001b[${code}m${text}\u001b[0m` : text;
}

// One printable line of the narration: relative time, lane indent, glyph and text.
export function formatNarration(event, { color = false } = {}) {
  const kind = event?.kind;
  const glyph = GLYPHS[kind] ?? GLYPHS.tool;
  const label = event?.lane ? `[${event.lane}] ` : "";
  const body = paint(`${glyph} ${label}${event?.text ?? ""}`, color ? COLORS[kind] : null);
  return `${paint(formatElapsed(event?.elapsedMs), color ? "2" : null)}  ${event?.indent ? "    " : ""}${body}`;
}
