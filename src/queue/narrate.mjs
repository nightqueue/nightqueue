import { basename } from "node:path";
import { truncateByCodePoint } from "../memory/jobs.mjs";
import { clockLabel } from "./hints.mjs";
import { extractNotice, extractPrUrl, hasGateMarker, laneName, parseEventLine, parseSlugLine, tokensFromEvent } from "./stream.mjs";
import { jobRef } from "../memory/refs.mjs";
import { slotNumberOf, trackPhaseNumbers } from "./routing.mjs";
import { PHASE_ARTIFACTS } from "./phase-artifacts.mjs";

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
const BODY_CAP_BYTES = 32768;
const TOOL_ERROR_BODY_LINES = 40;
const HAND_BACK_LEAD = "The report follows:\n";
const RUN_CHECK_RE = /\bnightqueue run check\s+(\S+)/;

const FILE_TOOLS = new Set(["Read", "Edit", "Write", "NotebookEdit"]);
const MCP_TARGET_FIELDS = ["file_path", "path", "pattern", "project", "repo_root", "slug", "query", "name", "key", "id"];
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
export const PHASES = new Map([
  ["triager", 1],
  ["explore", 2],
  ["architect", 3],
  ["coder", 4],
  ["qa-guardian", 5],
  ["verifier", 6],
]);

// `run report` has no slot of its own: it is the tail of commit · PR, like publish.
const PHASE_MARKERS = [
  [/nightqueue run start\b/, 0],
  [/nightqueue run publish\b/, slotNumberOf("commit")],
  [/nightqueue run report\b/, slotNumberOf("commit")],
];

export const RUNTIME_PROMPT_RE = /^﻿?[ \t]*Mode: RUNTIME[ \t]*$/m;

// The track phase of a lane: the runtime lane is the verifier launched with prompts/runtime.md, told apart only by that template's own `Mode: RUNTIME` line.
export function lanePhase(name, prompt) {
  if (name === "verifier" && typeof prompt === "string" && RUNTIME_PROMPT_RE.test(prompt)) return slotNumberOf("runtime");
  return PHASES.get(name) ?? null;
}

export const GLYPHS = {
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
// The call is returned apart from the whole line, because it is the part a terminal prints dimmed: the intent carries the reading, the call stays as evidence.
function toolNarration(name, input) {
  const label = toolLabel(name);
  const target = shortTarget(name, input);
  const call = target ? `${label} ${target}` : label;
  const intent = clip(firstLine(input?.description), DESCRIPTION_LIMIT);
  return intent ? { text: `${intent} — ${call}`, dim: `— ${call}` } : { text: call, dim: "" };
}

// Label of a lane: its name, the phase of the pipeline and the model the orchestrator picked for it, each part only when it is known.
// The model comes from the `tool_use` block that launched the subagent, the only event of the stream that carries it: a lane opened from `task_started` has none.
function laneLabel(subagentType, model, phase) {
  const name = laneName(subagentType);
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

// One narration line, already carrying its relative time, the lane it belongs to and the structured fields a renderer reads instead of the text.
function narrationEvent(state, kind, text, { indent = false, lane = null, dim = "", fields = {} } = {}) {
  return { kind, text, indent, lane, dim, elapsedMs: elapsedOf(state), ...fields };
}

// One narration line of a lane child, labelled only when more than one lane is open at that moment.
function laneLine(state, kind, text, lane, { dim = "", fields = {} } = {}) {
  if (!lane) return narrationEvent(state, kind, text, { dim, fields });
  const placed = state.rich ? { laneId: lane.id ?? null, ...fields } : fields;
  return narrationEvent(state, kind, text, { indent: true, lane: state.lanes.size > 1 ? lane.name : null, dim, fields: placed });
}

// A buffer cut to at most `maxBytes`, backing off so a multibyte character is never split.
export function cutUtf8(buffer, maxBytes) {
  if (buffer.length <= maxBytes) return buffer;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end);
}

// The body fields of a studio event: the text capped at 32 KiB, and the log offset of its line when the cap cut it.
function capBody(text, state) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= BODY_CAP_BYTES) return { body: text, body_truncated: false, body_offset: null };
  return { body: cutUtf8(buffer, BODY_CAP_BYTES).toString("utf8"), body_truncated: true, body_offset: state.lineOffset ?? null };
}

// The body fields of an event in rich mode only, so the CLI shape never carries them; an empty text has a null body.
function richBody(state, text) {
  if (!state.rich) return {};
  const trimmed = String(text ?? "").trimEnd();
  return trimmed ? capBody(trimmed, state) : { body: null, body_truncated: false, body_offset: null };
}

// Removes a two-space indent when every non-empty line carries it.
function dedentTwo(text) {
  const lines = text.split("\n");
  const indented = lines.every((line) => line.trim() === "" || line.startsWith("  "));
  return indented ? lines.map((line) => line.slice(2)).join("\n") : text;
}

// The subagent's own report inside a Task tool_result: the harness frame, its indent, the agentId line and the usage block removed.
export function handBackText(text) {
  let body = String(text ?? "");
  const lead = body.indexOf(HAND_BACK_LEAD);
  if (lead >= 0) body = body.slice(lead + HAND_BACK_LEAD.length);
  body = body.replace(/<usage>[\s\S]*?<\/usage>/g, "");
  const agentLine = body.lastIndexOf("\nagentId:");
  if (agentLine >= 0) body = body.slice(0, agentLine);
  return dedentTwo(body).trim();
}

// The structured fields of a lane event: the agent, its pipeline phase, the model and the lane's tool_use id, each null when unknown.
function laneFields(lane, laneId = lane?.id ?? null) {
  const agent = lane?.name ?? null;
  return { agent, phase: lane?.phase ?? PHASES.get(agent) ?? null, model: lane?.model ?? null, laneId };
}

// The phase an orchestrator Bash command marks (`nightqueue run start|publish|report`), or null.
function markedPhase(command) {
  const marker = PHASE_MARKERS.find(([pattern]) => pattern.test(String(command ?? "")));
  return marker ? marker[1] : null;
}

// The structured fields of a tool call: its label, the file an edit touched and the phase an orchestrator command marks.
function toolFields(name, input, lane) {
  const fields = { tool: toolLabel(name) };
  if (EDIT_TOOLS.has(name) && typeof input?.file_path === "string" && input.file_path.trim()) fields.file = basename(input.file_path.trim());
  const phase = !lane && name === "Bash" ? markedPhase(input?.command) : null;
  if (phase !== null) fields.phase = phase;
  return fields;
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
  state.bashTasks.clear();
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
  return `${body}\n    read the whole notice with: nightqueue queue status ${jobRef(jobId)}`;
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

// What the orchestrator said, plus the markers of that same text. A subagent speaks too, indented in its lane: its own words
// ("Now update the store") are the only readable intent its tool calls ever carry, since Edit/Read/Write have no description
// and a model often leaves the one of Bash empty. Markers stay the orchestrator's alone.
function narrateText(state, raw, lane) {
  const text = String(raw ?? "");
  if (!text.trim()) return [];
  const line = clip(firstLine(text), TEXT_LIMIT);
  const fields = richBody(state, text);
  if (lane) return [laneLine(state, "text", line, lane, { fields })];
  return [narrationEvent(state, "text", line, { fields }), ...narrateMarkers(state, text)];
}

// Opens a lane for a subagent, the only event that indents everything reported under it.
function openLane(state, { toolUseId, subagentType, description, model = null, prompt = null }) {
  const name = laneName(subagentType);
  const phase = lanePhase(name, prompt);
  const lane = { id: toolUseId ?? null, name, phase, label: laneLabel(subagentType, model, phase), model: clip(model, MODEL_LIMIT) || null, openMs: state.clockMs, tools: 0, edits: 0 };
  if (toolUseId) state.lanes.set(toolUseId, lane);
  const detail = clip(description, DESCRIPTION_LIMIT);
  return narrationEvent(state, "laneOpen", detail ? `${lane.label} — ${detail}` : lane.label, { fields: laneFields(lane) });
}

// A tool call: the one that carries a `subagent_type` opens a lane, whatever the tool happens to be named.
function narrateToolUse(state, block, lane) {
  const name = String(block.name ?? "").trim() || "tool";
  const id = typeof block.id === "string" && block.id ? block.id : null;
  if (id) state.tools.set(id, toolLabel(name));
  const subagentType = block.input?.subagent_type;
  if (typeof subagentType === "string" && subagentType.trim()) {
    return [openLane(state, { toolUseId: id, subagentType, description: block.input?.description, model: block.input?.model, prompt: block.input?.prompt })];
  }
  if (lane) {
    lane.tools += 1;
    if (EDIT_TOOLS.has(name)) lane.edits += 1;
  }
  const narration = toolNarration(name, block.input);
  const line = laneLine(state, "tool", narration.text, lane, { dim: narration.dim, fields: toolFields(name, block.input, lane) });
  return [line, ...reportEvents(state, name, block.input, lane)];
}

// The artifact a tool call reports as written: the file of a `nightqueue run check <NN>` or the basename a `run_phase_done` names; null otherwise.
function reportedArtifact(name, input) {
  if (name === "Bash") {
    const match = RUN_CHECK_RE.exec(String(input?.command ?? ""));
    return match ? (PHASE_ARTIFACTS.get(match[1].toLowerCase())?.file ?? null) : null;
  }
  if (toolLabel(name) !== "run_phase_done") return null;
  const artifact = input?.artifact;
  return typeof artifact === "string" && artifact.endsWith(".md") && basename(artifact) === artifact ? artifact : null;
}

// The provisional report event of a tool call in rich mode; the phase pass dedups it and reads its title and size.
function reportEvents(state, name, input, lane) {
  if (!state.rich || !state.readArtifact) return [];
  const artifact = reportedArtifact(name, input);
  return artifact ? [laneLine(state, "report", `report ${artifact}`, lane, { fields: { artifact } })] : [];
}

// First readable text of a tool result, which the CLI writes either as a string or as blocks.
function resultContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (typeof block?.text === "string" ? block.text : "")).join("\n");
}

// A tool result: only a failure is narrated, and only its first line, never the output of a success.
function narrateToolResult(state, block, lane) {
  if (block?.is_error !== true) {
    stashHandBack(state, block);
    return [];
  }
  const name = state.tools.get(block.tool_use_id) ?? "tool";
  const content = resultContentText(block.content);
  const detail = clip(firstLine(content), TEXT_LIMIT);
  const fields = { tool: name, ...richBody(state, lastLines(content, TOOL_ERROR_BODY_LINES)) };
  return [laneLine(state, "toolError", detail ? `${name} failed: ${detail}` : `${name} failed`, lane, { fields })];
}

// The last `count` lines of a text, its trailing blank lines left out.
function lastLines(text, count) {
  return text.trimEnd().split("\n").slice(-count).join("\n");
}

// Keeps, in rich mode, the unframed report a Task tool_result hands back while its lane is still open, the fallback body of its close.
function stashHandBack(state, block) {
  if (!state.rich) return;
  const lane = state.lanes.get(block?.tool_use_id);
  if (lane) lane.handBack = handBackText(resultContentText(block.content));
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

// The silent usage event of an assistant message that carries usage, only when the narrator was asked for them; the four counters summed like the TOKENS column.
function usageEvents(state, event, lane) {
  if (!state.usage || event.type !== "assistant" || !event.message?.usage) return [];
  const counters = tokensFromEvent(event);
  const tokens = counters.tokensIn + counters.tokensOut + counters.cacheRead + counters.cacheCreation;
  const parent = typeof event.parent_tool_use_id === "string" && event.parent_tool_use_id ? event.parent_tool_use_id : null;
  const { agent, phase } = laneFields(lane);
  return [narrationEvent(state, "usage", "", { fields: { laneId: parent, agent, phase, messageId: counters.id, tokens } })];
}

// An `assistant` or `user` event, the two that carry the blocks of a message, followed by its usage when asked for.
function narrateMessage(state, event) {
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  const lane = laneOf(state, event);
  const out = [];
  for (const block of blocks) out.push(...narrateBlock(state, block, lane));
  out.push(...usageEvents(state, event, lane));
  return out;
}

// How long a finished lane ran: the duration it reported, else the clock since it opened, null when neither is known.
function laneDurationMs(state, lane, usage) {
  return Number.isFinite(usage?.duration_ms) ? usage.duration_ms : elapsedBetween(lane?.openMs, state.clockMs);
}

// What is known about a finished lane; anything the narrator did not observe is reported as unknown.
function laneSummary(state, lane, usage) {
  const durationMs = laneDurationMs(state, lane, usage);
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
  if (id) state.closedLanes.set(id, lane ?? { name: "subagent", label: "subagent", model: null, openMs: null, tools: 0, edits: 0 });
  const status = typeof event.status === "string" && event.status ? event.status : "finished";
  const label = lane?.label ?? "subagent";
  const laneTokens = Number.isFinite(event.usage?.total_tokens) ? event.usage.total_tokens : null;
  const fields = { ...laneFields(lane, id || null), durationMs: laneDurationMs(state, lane, event.usage), laneTokens, ...richBody(state, handBackOf(event, lane)) };
  return [narrationEvent(state, "laneClose", `${label} ${status} (${laneSummary(state, lane, event.usage)})`, { fields })];
}

// What a closing lane handed back: the notification's summary, else the report its tool_result carried before the close.
function handBackOf(event, lane) {
  if (typeof event.summary === "string" && event.summary.trim()) return event.summary;
  return lane?.handBack ?? "";
}

// A `system` event: only the two that open and close a subagent lane say anything to the operator, and a background Bash task is no subagent.
function narrateSystem(state, event) {
  if (event.subtype === "task_started") {
    const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
    if (!id || state.lanes.has(id)) return [];
    if (event.task_type === "local_bash") {
      state.bashTasks.add(id);
      return [];
    }
    return [openLane(state, { toolUseId: id, subagentType: event.subagent_type, description: event.description, prompt: event.prompt })];
  }
  if (event.subtype === "task_notification") return state.bashTasks.has(event.tool_use_id) ? [] : closeLane(state, event);
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
    const options = { fields: laneFields(lane) };
    out.push(running ? narrationEvent(state, "laneOpen", `${lane.label} still running`, options) : narrationEvent(state, "laneOrphan", `${lane.label} never reported back`, options));
  }
  state.lanes.clear();
  return [...out, ...flushSkipped(state)];
}

// The phase an event signals in rich mode: a lane opening for a pipeline phase or an orchestrator phase marker; null otherwise.
function signalledPhase(event) {
  if (!Number.isInteger(event.phase)) return null;
  if (event.kind === "laneOpen") return event.phase;
  return event.kind === "tool" && !event.indent ? event.phase : null;
}

// Moves the rich narration into a phase, emitting its `phase` event and restarting the dedup of its reports.
function enterPhase(state, out, phase, signal) {
  state.richPhase = phase;
  state.reported.clear();
  const lane = signal?.kind === "laneOpen";
  const fields = { phase, agent: lane ? (signal.agent ?? null) : ORCHESTRATOR, model: lane ? (signal.model ?? null) : null, at: isoOf(state.clockMs) };
  out.push(narrationEvent(state, "phase", `phase ${phase}`, { fields }));
}

// The title and size of an artifact through the injected reader, null when it answers nothing or fails.
function readArtifactSafely(state, artifact) {
  try {
    return state.readArtifact(artifact) ?? null;
  } catch {
    return null;
  }
}

// A provisional report completed with the artifact's title and size, or null when it was already reported in this phase or the file is not there; a sizeless answer defers the dedup to the reader's owner.
function resolvedReport(state, event) {
  if (state.reported.has(event.artifact)) return null;
  const summary = readArtifactSafely(state, event.artifact);
  if (!summary) return null;
  if (Number.isFinite(summary.bytes)) state.reported.add(event.artifact);
  return { ...event, title: summary.title ?? null, bytes: Number.isFinite(summary.bytes) ? summary.bytes : null };
}

// One event through the rich phase pass: the phase it opens first, then the event itself, a report only once per phase.
function placeRichEvent(state, out, event) {
  if (event.kind === "attempt") {
    out.push(event);
    return enterPhase(state, out, 0, null);
  }
  const phase = signalledPhase(event);
  if (phase !== null && phase !== state.richPhase) enterPhase(state, out, phase, event);
  else if (state.richPhase === null && event.kind !== "usage") enterPhase(state, out, 0, null);
  const placed = event.kind === "report" ? resolvedReport(state, event) : event;
  if (placed) out.push(placed);
}

// The events of one line with the rich-only phase events inserted and the reports resolved.
function withRichPhases(state, events) {
  const out = [];
  for (const event of events) placeRichEvent(state, out, event);
  return out;
}

// Narrates one raw line; the byte offset of the line is kept for a capped body, and rich mode adds its phase pass.
function pushLine(state, rawLine, offset) {
  state.lineOffset = Number.isFinite(offset) ? offset : null;
  const events = narrateLine(state, rawLine);
  return state.rich ? withRichPhases(state, events) : events;
}

// A narrator of one job log: it takes raw lines, one at a time, and answers with the lines to print, plus silent usage events when `usage` is on; `rich` is the studio's shape alone, never the CLI's.
export function createNarrator({ all = false, jobId = null, usage = false, rich = false, readArtifact = null } = {}) {
  const state = { all: all === true, jobId: jobId ?? null, usage: usage === true, rich: rich === true, readArtifact: typeof readArtifact === "function" ? readArtifact : null, lineOffset: null, richPhase: null, reported: new Set(), anchorMs: null, clockMs: null, lanes: new Map(), closedLanes: new Map(), bashTasks: new Set(), tools: new Map(), seen: new Map(), skipped: 0, plain: 0 };
  return {
    push: (rawLine, { offset } = {}) => pushLine(state, rawLine, offset),
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

const ORCHESTRATOR = "orchestrator";

// A fresh reading of one attempt of the log: no lane open, the orchestrator before its first marker.
function freshLiveState(attempt, clockMs) {
  return { attempt, clockMs, lanes: new Map(), closed: new Set(), bashTasks: new Set(), orchPhase: 0, orchIntent: null, orchLast: null };
}

// Opens a lane in the live reading; a lane already open is left as the event that opened it first described it.
function liveOpenLane(state, { id, subagentType, description, model, prompt }) {
  if (!id || state.lanes.has(id)) return;
  const lane = { agent: laneName(subagentType), model: clip(model, MODEL_LIMIT) || null, intent: clip(description, DESCRIPTION_LIMIT) || null, openedMs: state.clockMs, last: null };
  lane.phase = lanePhase(lane.agent, prompt);
  state.lanes.set(id, lane);
  state.orchPhase = lane.phase ?? state.orchPhase;
}

// The open lane an event of the stream belongs to; a parent never seen opening is a lane that opened before the window of the tail.
function liveLaneOf(state, parent) {
  if (typeof parent !== "string" || !parent) return null;
  if (state.lanes.has(parent)) return state.lanes.get(parent);
  if (state.closed.has(parent)) return null;
  liveOpenLane(state, { id: parent, subagentType: null, description: null, model: null, prompt: null });
  const lane = state.lanes.get(parent);
  lane.agent = null;
  lane.phase = null;
  lane.openedMs = null;
  return lane;
}

// Records the last tool or text event of a lane, or of the orchestrator when the event belongs to no lane.
function liveRecord(state, lane, kind, text) {
  const entry = { kind, text, atMs: state.clockMs };
  if (lane) lane.last = entry;
  else state.orchLast = entry;
}

// Moves the orchestrator to the phase a `nightqueue run start|publish|report` command marks.
function livePhaseMarker(state, command) {
  const phase = markedPhase(command);
  if (phase !== null) state.orchPhase = phase;
}

// One block of a message in the live reading: a text or a tool call; a subagent launch opens a lane.
function liveBlock(state, block, lane) {
  if (block?.type === "text") {
    const text = clip(firstLine(block.text), TEXT_LIMIT);
    if (!text) return;
    if (!lane) state.orchIntent = text;
    liveRecord(state, lane, "text", text);
    return;
  }
  if (block?.type !== "tool_use") return;
  const input = block.input;
  if (typeof input?.subagent_type === "string" && input.subagent_type.trim()) {
    liveOpenLane(state, { id: block.id, subagentType: input.subagent_type, description: input.description, model: input.model, prompt: input.prompt });
    return;
  }
  if (!lane && block.name === "Bash") livePhaseMarker(state, input?.command);
  liveRecord(state, lane, "tool", toolNarration(String(block.name ?? "").trim() || "tool", input).text);
}

// A `system` event of the live reading: a subagent task starting opens its lane, its notification closes it.
function liveSystem(state, event) {
  const id = typeof event.tool_use_id === "string" ? event.tool_use_id : "";
  if (event.subtype === "task_started" && event.task_type === "local_bash") state.bashTasks.add(id);
  else if (event.subtype === "task_started") liveOpenLane(state, { id, subagentType: event.subagent_type, description: event.description, model: null, prompt: event.prompt });
  else if (event.subtype === "task_notification" && !state.bashTasks.has(id) && id) {
    state.lanes.delete(id);
    state.closed.add(id);
  }
}

// Applies one parsed event of the stream to the live reading.
function liveEvent(state, event) {
  const stamp = isoMs(event.timestamp);
  if (stamp !== null) state.clockMs = stamp;
  if (event.type === "system") return liveSystem(state, event);
  if (event.type !== "assistant" && event.type !== "user") return;
  const parent = event.parent_tool_use_id;
  const lane = liveLaneOf(state, parent);
  if (typeof parent === "string" && parent && !lane) return;
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  for (const block of blocks) liveBlock(state, block, lane);
}

// Reads the tail of a log into the state of its last attempt.
function readLiveTail(tail) {
  let state = freshLiveState(null, null);
  for (const line of String(tail ?? "").split("\n")) {
    const attempt = ATTEMPT_LINE_RE.exec(line);
    if (attempt) state = freshLiveState(Number(attempt[1]), isoMs(attempt[2]));
    else {
      const event = parseEventLine(line);
      if (event) liveEvent(state, event);
    }
  }
  return state;
}

// ISO instant of a clock reading, null when none was seen.
function isoOf(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Position of a pipeline phase in the tier's track as { phase, phases }, null parts when the tier or the phase is unknown.
function trackPosition(tier, number) {
  const numbers = trackPhaseNumbers(tier);
  if (!numbers) return { phase: null, phases: null };
  const index = Number.isFinite(number) ? numbers.indexOf(number) : -1;
  return { phase: index >= 0 ? index + 1 : null, phases: numbers.length };
}

// What a running job is doing right now, derived on demand from the tail of its log and never stored.
export function liveState(tail, { tier = null, nowMs = Date.now() } = {}) {
  const state = readLiveTail(tail);
  const lane = [...state.lanes.values()].pop() ?? null;
  const last = lane ? lane.last : state.orchLast;
  const number = lane ? lane.phase : state.orchPhase;
  return {
    attempt: state.attempt,
    agent: lane ? lane.agent : ORCHESTRATOR,
    model: lane ? lane.model : null,
    ...trackPosition(tier, number),
    intent: lane ? lane.intent : state.orchIntent,
    last: last ? { kind: last.kind, text: last.text, at: isoOf(last.atMs) } : null,
    lane_opened_at: lane ? isoOf(lane.openedMs) : null,
    quiet_s: last && Number.isFinite(last.atMs) && Number.isFinite(nowMs) ? Math.max(0, Math.round((nowMs - last.atMs) / 1000)) : null,
  };
}

// Wraps a text in an SGR color, or returns it untouched when there is no color to apply.
function paint(text, code) {
  return code ? `\u001b[${code}m${text}\u001b[0m` : text;
}

// Splits the text of an event into what it says and the tail a terminal prints dimmed; a tail the text does not end with is not a tail.
function splitDim(text, dim) {
  if (!dim || !text.endsWith(dim)) return [text, ""];
  return [text.slice(0, text.length - dim.length), dim];
}

// One printable line of the narration: relative time, lane indent, glyph and text.
// With color on, the tail an event marks as dim is printed faint, so the eye lands on the intent and the command stays readable underneath it.
export function formatNarration(event, { color = false } = {}) {
  const kind = event?.kind;
  const glyph = GLYPHS[kind] ?? GLYPHS.tool;
  const label = event?.lane ? `[${event.lane}] ` : "";
  const [said, tail] = splitDim(String(event?.text ?? ""), color ? event?.dim : "");
  const body = `${paint(`${glyph} ${label}${said}`, color ? COLORS[kind] : null)}${tail ? paint(tail, "2") : ""}`;
  return `${paint(formatElapsed(event?.elapsedMs), color ? "2" : null)}  ${event?.indent ? "    " : ""}${body}`;
}
