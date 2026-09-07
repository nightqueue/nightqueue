const FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const QUOTED_LINE_RE = /^\s*\d+\t/;
const GATE_HEADING_RE = /^#{1,6}\s+Requires user confirmation\s*$/i;
const NOTICE_HEADING_RE = /^#{1,6}\s+Notice\s*$/i;
const SLUG_LINE_RE = /^\s*QUEUE_SLUG:\s*([A-Za-z0-9][A-Za-z0-9._+-]{0,79})\s*$/;
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
const PR_URL_SOURCE = "https?://github\\.com/[\\w.-]+/[\\w.-]+/pull/\\d+";
const PR_URL_RE = new RegExp(PR_URL_SOURCE, "g");
const PR_DELIVERY_LINE_RE = new RegExp(`${PR_URL_SOURCE}[)\\]>.,;:'"\`*_ \\t]*$`);
const PR_DENIAL_RE = /\b(?:fail(?:ed|s|ing|ure)?|could not|cannot|can't|unable|error|refused|denied|not opened?|no pull request|example|would be)\b/i;
const USAGE_FIELDS = ["tokensIn", "tokensOut", "cacheRead", "cacheCreation"];

// Parses one raw NDJSON line of the stream; a truncated or non-JSON line is simply not an event.
export function parseEventLine(rawLine) {
  try {
    const event = JSON.parse(rawLine);
    return event && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

// Tells whether the event belongs to a subagent: anchored on parent_tool_use_id, reinforced by subagent_type.
export function isSubagentEvent(event) {
  const parent = event?.parent_tool_use_id;
  if (typeof parent === "string" && parent !== "") return true;
  return typeof event?.subagent_type === "string" && event.subagent_type !== "";
}

// Text the ORCHESTRATOR said in an assistant event; null for a subagent, another event type or an event without text.
export function orchestratorText(event) {
  if (event?.type !== "assistant" || isSubagentEvent(event) || !Array.isArray(event.message?.content)) return null;
  const parts = [];
  for (const block of event.message.content) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.length ? parts.join("\n") : null;
}

// Text the orchestrator said in one raw NDJSON line, or null.
function orchestratorTextFromLine(rawLine) {
  return orchestratorText(parseEventLine(rawLine));
}

// Tells whether a fence marker closes the open one: same character and at least as long, as markdown requires.
function closesFence(open, marker) {
  return marker[0] === open[0] && marker.length >= open.length;
}

// Splits a text into lines flagged with whether they lie inside a markdown code fence, nesting included.
function linesWithFenceState(text) {
  const scanned = [];
  let open = null;
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const marker = FENCE_LINE_RE.exec(line)?.[1] ?? null;
    if (marker && (open === null || closesFence(open, marker))) {
      open = open === null ? marker : null;
      scanned.push({ line, inFence: true });
      continue;
    }
    scanned.push({ line, inFence: open !== null });
  }
  return scanned;
}

// Tells whether a scanned line can carry a marker: outside a fence and not a `cat -n` style quotation.
function isMarkerCandidate({ line, inFence }) {
  return !inFence && !QUOTED_LINE_RE.test(line);
}

// Extracts the run slug from a STANDALONE `QUEUE_SLUG: <slug>` line; an inline mention never matches.
export function parseSlugLine(line) {
  const match = SLUG_LINE_RE.exec(String(line ?? ""));
  return match ? match[1] : null;
}

// Extracts the run slug from a raw NDJSON line: only orchestrator text, last valid match of the event.
export function extractSlugFromEventLine(rawLine) {
  const text = orchestratorTextFromLine(rawLine);
  if (!text) return null;
  let found = null;
  for (const line of text.split("\n")) found = parseSlugLine(line) ?? found;
  return found;
}

// Tells whether a session id is safe to become argv of `claude --resume`: no dot, no slash, never a flag.
export function isSessionIdSafe(id) {
  return typeof id === "string" && SESSION_ID_RE.test(id);
}

// Reads the top-level session_id of any raw NDJSON event, returning only what passes the safety gate.
export function extractSessionIdFromEventLine(rawLine) {
  const event = parseEventLine(rawLine);
  return isSessionIdSafe(event?.session_id) ? event.session_id : null;
}

// Final text of the run: the last `result` event with a string; "" when a result event carried none, null when there was none.
export function extractResultText(log) {
  let text = null;
  let sawResult = false;
  for (const line of String(log ?? "").split("\n")) {
    const event = parseEventLine(line);
    if (event?.type !== "result") continue;
    sawResult = true;
    if (typeof event.result === "string") text = event.result;
  }
  if (text !== null) return text;
  return sawResult ? "" : null;
}

// Tells whether a text stops at the gate: a standalone heading outside any code fence, never an inline mention.
export function hasGateMarker(text) {
  return linesWithFenceState(text).some((entry) => isMarkerCandidate(entry) && GATE_HEADING_RE.test(entry.line));
}

// Tells whether the ORCHESTRATOR announced the gate anywhere in the stream.
export function hasGateMarkerInStream(log) {
  for (const line of String(log ?? "").split("\n")) {
    const text = orchestratorTextFromLine(line);
    if (text && hasGateMarker(text)) return true;
  }
  return false;
}

// Body of the LAST `## Notice` section of a text, ignoring headings quoted inside a code fence.
export function extractNotice(text) {
  const scanned = linesWithFenceState(text);
  let start = -1;
  scanned.forEach((entry, index) => {
    if (isMarkerCandidate(entry) && NOTICE_HEADING_RE.test(entry.line)) start = index;
  });
  if (start < 0) return null;
  const body = scanned
    .slice(start + 1)
    .map((entry) => entry.line)
    .join("\n")
    .trim();
  return body || null;
}

// Last `## Notice` the ORCHESTRATOR said in an intermediate event, the only fallback when the result has none.
function noticeFromAssistants(log) {
  const lines = String(log ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = orchestratorTextFromLine(lines[i]);
    if (!text) continue;
    const notice = extractNotice(text);
    if (notice) return notice;
  }
  return null;
}

// Notice of the run: the final `result` event has the authority, and an echo of an earlier event never wins.
export function extractNoticeFromStream(log) {
  const resultText = extractResultText(log);
  return (resultText ? extractNotice(resultText) : null) ?? noticeFromAssistants(log);
}

// Tells whether a line DELIVERS a pull request: the URL closes the line and nothing on it denies the delivery.
function deliversPrUrl({ line, inFence }) {
  if (inFence || QUOTED_LINE_RE.test(line)) return false;
  return PR_DELIVERY_LINE_RE.test(line) && !PR_DENIAL_RE.test(line);
}

// URL of the pull request the run DELIVERED; a URL cited inside a sentence, an example or a failure is not one.
export function extractPrUrl(text) {
  let found = null;
  for (const entry of linesWithFenceState(text)) {
    if (!deliversPrUrl(entry)) continue;
    const matches = entry.line.match(PR_URL_RE);
    found = matches[matches.length - 1];
  }
  return found;
}

// Turns an external value into a finite number (0 when it is not one).
function finite(value) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// A usage block with every kind of token at zero.
function emptyUsage() {
  return { tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0 };
}

// Aggregated usage of a result event, in the snake_case shape the CLI emits; null when the block is absent.
function usageFromAggregate(event) {
  const usage = event?.usage;
  if (!usage || typeof usage !== "object") return null;
  return {
    tokensIn: finite(usage.input_tokens),
    tokensOut: finite(usage.output_tokens),
    cacheRead: finite(usage.cache_read_input_tokens),
    cacheCreation: finite(usage.cache_creation_input_tokens),
  };
}

// Usage of a result event summed from its per-model breakdown (one session may use several models); null when absent.
function usageFromModels(event) {
  if (!event?.modelUsage || typeof event.modelUsage !== "object") return null;
  const total = emptyUsage();
  for (const model of Object.values(event.modelUsage)) {
    total.tokensIn += finite(model?.inputTokens);
    total.tokensOut += finite(model?.outputTokens);
    total.cacheRead += finite(model?.cacheReadInputTokens);
    total.cacheCreation += finite(model?.cacheCreationInputTokens);
  }
  return total;
}

// How many tokens a usage block reports, counting every kind of them.
function usageTotal(usage) {
  return usage ? USAGE_FIELDS.reduce((sum, field) => sum + finite(usage[field]), 0) : 0;
}

// Usage of one result event: the two blocks describe the SAME tokens, so each field keeps the larger of them and a truncated block never shadows a complete one; nothing is ever summed twice.
function resultUsage(event) {
  const aggregate = usageFromAggregate(event);
  const models = usageFromModels(event);
  if (!aggregate || !models) return aggregate ?? models;
  const merged = emptyUsage();
  for (const field of USAGE_FIELDS) merged[field] = Math.max(aggregate[field], models[field]);
  return merged;
}

// Adds one usage block into a running total.
function addUsage(total, usage) {
  for (const field of USAGE_FIELDS) total[field] += finite(usage?.[field]);
}

// Rule of what an assistant event contributes to the estimated fallback: only an assistant with message.usage adds up.
export function tokensFromEvent(event) {
  if (event?.type !== "assistant" || !event.message?.usage) {
    return { id: null, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0 };
  }
  const usage = event.message.usage;
  return {
    id: event.message.id ?? null,
    tokensIn: finite(usage.input_tokens),
    tokensOut: finite(usage.output_tokens),
    cacheRead: finite(usage.cache_read_input_tokens),
    cacheCreation: finite(usage.cache_creation_input_tokens),
  };
}

// Applies the token rule to one raw NDJSON line; a line that is not an assistant with usage counts zero.
export function tokensFromEventLine(rawLine) {
  return tokensFromEvent(parseEventLine(rawLine));
}

// Splits the stream into one entry per session: the result event of that session and the sum of its OWN assistant turns, deduped by message id.
function sessionsFromLog(log) {
  const sessions = new Map();
  const seenIds = new Set();
  for (const line of String(log ?? "").split("\n")) {
    const event = parseEventLine(line);
    const isResult = event?.type === "result";
    if (!isResult && !(event?.type === "assistant" && event.message?.usage)) continue;
    const id = String(event.session_id ?? "");
    const session = sessions.get(id) ?? { result: null, estimate: emptyUsage(), hasAssistantUsage: false };
    sessions.set(id, session);
    if (isResult) {
      session.result = event;
      continue;
    }
    session.hasAssistantUsage = true;
    const tokens = tokensFromEvent(event);
    if (tokens.id !== null && seenIds.has(tokens.id)) continue;
    if (tokens.id !== null) seenIds.add(tokens.id);
    addUsage(session.estimate, tokens);
  }
  return sessions;
}

// What ONE session contributes: its own result telemetry when the result reported tokens, otherwise the estimate from its own assistants.
function sessionUsage(session) {
  const reported = resultUsage(session.result);
  if (usageTotal(reported) > 0) return { usage: reported, estimated: false };
  if (session.hasAssistantUsage) return { usage: session.estimate, estimated: true };
  return { usage: reported ?? emptyUsage(), estimated: false };
}

// Cost of an attempt: the sum of what its result events reported, null when none of them reported any.
function attemptCost(sessions) {
  let costUsd = null;
  for (const session of sessions) {
    if (Number.isFinite(session.result?.total_cost_usd)) costUsd = (costUsd ?? 0) + session.result.total_cost_usd;
  }
  return costUsd;
}

// Usage of one attempt: every session contributes its own tokens, so a session whose result carried no telemetry falls back to its assistants instead of contributing zero.
export function extractUsage(log) {
  const sessions = sessionsFromLog(log);
  if (!sessions.size) return null;
  const total = emptyUsage();
  let anyReported = false;
  let anyEstimated = false;
  for (const session of sessions.values()) {
    const { usage, estimated } = sessionUsage(session);
    addUsage(total, usage);
    anyReported = anyReported || (!estimated && usageTotal(usage) > 0);
    anyEstimated = anyEstimated || estimated;
  }
  return { ...total, costUsd: attemptCost(sessions.values()), sessions: sessions.size, estimated: anyEstimated && !anyReported };
}

// Consolidates the usage of several attempts into one total; nulls are ignored and an empty list stays null.
export function sumUsage(usages) {
  const list = (Array.isArray(usages) ? usages : []).filter((usage) => usage && typeof usage === "object");
  if (!list.length) return null;
  const total = { ...emptyUsage(), costUsd: null, sessions: 0, estimated: false };
  for (const usage of list) {
    addUsage(total, usage);
    total.sessions += finite(usage.sessions);
    if (Number.isFinite(usage.costUsd)) total.costUsd = (total.costUsd ?? 0) + usage.costUsd;
    if (usage.estimated) total.estimated = true;
  }
  return total;
}
