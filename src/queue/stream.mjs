import { insideRoots, orchestratorBashAllowed, readTarget } from "./orchestrator-scope.mjs";

const FENCE_LINE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const QUOTED_LINE_RE = /^\s*\d+\t/;
const GATE_HEADING_RE = /^#{1,6}\s+Requires user confirmation\s*$/i;
const NOTICE_HEADING_RE = /^#{1,6}\s+Notice\s*$/i;
// The shape of a run slug, which is one path segment: the same rule `isSafeSegment` enforces, written once for both slug lines.
const SLUG_SOURCE = "[A-Za-z0-9][A-Za-z0-9._+-]{0,79}";
const SLUG_LINE_RE = new RegExp(`^\\s*QUEUE_SLUG:\\s*(${SLUG_SOURCE})\\s*$`);
const SLUG_TYPE_LINE_RE = new RegExp(`^\\s*SLUG:\\s*(${SLUG_SOURCE})(?:\\s+TYPE:\\s*([A-Za-z][A-Za-z0-9/._+-]{0,39}))?\\s*$`);
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;
// The line `openAttemptLog` writes before each attempt; the runtime numbers them 1, 2, 3… in order, so a line out of that sequence is incidental output shaped like a marker.
const ATTEMPT_MARKER_RE = /^=== attempt (\d+) @ (\S+) ===$/;
const TIER_RAISE_LINE_RE = /^\s*Tier raised:\s*(trivial|simple|complex)\s*->\s*(trivial|simple|complex)\s*:\s*(.+?)\s*$/;
// Every standalone line the runtime reads as a control literal of its contract: the parsers below and the prompt escaper share this list, so neither can gain a literal the other ignores.
export const CONTROL_LINE_PATTERNS = Object.freeze([
  SLUG_LINE_RE,
  SLUG_TYPE_LINE_RE,
  ATTEMPT_MARKER_RE,
  TIER_RAISE_LINE_RE,
]);
// The raw line the CLI prints (never a JSON event of the stream) when it gives up waiting for a background task.
const RAW_CEILING_LINE_RE = /^Background tasks still running after/;
// The tool result the Bash tool itself writes when its own timeout, not the CLI's wait ceiling, moved a foreground command to the background.
const AUTO_BACKGROUNDED_RE = /did not complete within its .* timeout and was moved to the background \(ID: ([^)]+)\)/;
const PR_URL_SOURCE = "https?://github\\.com/[\\w.-]+/[\\w.-]+/pull/\\d+";
const PR_URL_RE = new RegExp(PR_URL_SOURCE, "g");
const PR_URL_ONLY_RE = new RegExp(`^${PR_URL_SOURCE}$`);
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

// Stream of the LAST attempt of an accumulated log: an older attempt never speaks for the outcome of a job.
export function lastAttemptStream(log) {
  const scanned = linesWithFenceState(log);
  let start = 0;
  let expected = 1;
  scanned.forEach((entry, index) => {
    const marker = isMarkerCandidate(entry) ? ATTEMPT_MARKER_RE.exec(entry.line) : null;
    if (!marker || Number(marker[1]) !== expected) return;
    expected += 1;
    start = index + 1;
  });
  return scanned
    .slice(start)
    .map((entry) => entry.line)
    .join("\n");
}

// Reads the `=== attempt N @ <iso> ===` line the runner writes before each attempt as its number and its instant; any other line is null.
export function parseAttemptMarker(line) {
  const match = ATTEMPT_MARKER_RE.exec(String(line ?? ""));
  return match ? { attempt: Number(match[1]), at: match[2] } : null;
}

// Base name of a subagent type, which the plugin qualifies as `nightshift:<name>`.
export function laneName(subagentType) {
  return String(subagentType ?? "").split(":").pop().trim() || "subagent";
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

// Reads a STANDALONE `SLUG: <slug> TYPE: <type>` line, the ONE declaration that renames the run the runtime opened; the type is optional and an inline mention never matches.
export function parseSlugTypeLine(line) {
  const match = SLUG_TYPE_LINE_RE.exec(String(line ?? ""));
  return match ? { slug: match[1], type: match[2] ?? null } : null;
}

// Extracts the slug declaration from a raw NDJSON line: only orchestrator text, FIRST valid match, because a run is renamed once.
export function extractSlugTypeFromEventLine(rawLine) {
  const text = orchestratorTextFromLine(rawLine);
  if (!text) return null;
  for (const line of text.split("\n")) {
    const declared = parseSlugTypeLine(line);
    if (declared) return declared;
  }
  return null;
}

// Reads a STANDALONE `Tier raised: <from> -> <to>: <evidence>` line, the shape the Brief records a raise in; an inline mention never matches.
export function parseTierRaiseLine(line) {
  const match = TIER_RAISE_LINE_RE.exec(String(line ?? ""));
  return match ? { from: match[1], to: match[2], reason: match[3] } : null;
}

// Extracts the tier raise from a raw NDJSON line: only orchestrator text, last valid match of the event.
export function extractTierRaiseFromEventLine(rawLine) {
  const text = orchestratorTextFromLine(rawLine);
  if (!text) return null;
  let found = null;
  for (const line of text.split("\n")) found = parseTierRaiseLine(line) ?? found;
  return found;
}

// Tells whether a line would be read as a control literal of the runtime contract, which is what the prompt escaper has to neutralize.
export function isControlLine(line) {
  const text = String(line ?? "");
  return CONTROL_LINE_PATTERNS.some((pattern) => pattern.test(text));
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

// The band an instant the CLI writes in epoch SECONDS falls in: the ten digits every measured event carries, from 2001 to 2286.
// A value outside it is a magnitude this parser cannot read - milliseconds, a counter, a placeholder - and never an instant.
const MIN_EPOCH_S = 1_000_000_000;
const MAX_EPOCH_S = 10_000_000_000;

// Instant of a field the CLI writes in epoch SECONDS (never milliseconds, never ISO), in milliseconds; anything outside that shape is null.
function epochSecondsToMs(value) {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds) || seconds < MIN_EPOCH_S || seconds >= MAX_EPOCH_S) return null;
  return Math.round(seconds * 1000);
}

// Share of a budget the CLI reports as a 0..1 fraction; a value outside that band (a percentage, a count) is an unknown share and never a reading.
function budgetFraction(value) {
  const fraction = typeof value === "number" ? value : Number(value);
  return Number.isFinite(fraction) && fraction >= 0 && fraction <= 1 ? fraction : null;
}

// One window of a rate limit, with its utilization as the 0..1 fraction the CLI reports; a window the event does not carry is null.
function rateLimitWindow(windows, name) {
  const window = windows?.[name];
  if (!window || typeof window !== "object") return null;
  return { utilization: budgetFraction(window.utilization), resetsAt: epochSecondsToMs(window.resetsAt) };
}

// The rate limit one raw NDJSON line reports, with every instant already in milliseconds; any other event is null.
// `status` is the ONLY field that says whether the traffic was stopped: `overageStatus` carries the literal `rejected` on healthy traffic and never decides anything.
export function extractRateLimitFromEventLine(rawLine) {
  const event = parseEventLine(rawLine);
  if (event?.type !== "rate_limit_event") return null;
  const info = event.rate_limit_info;
  if (!info || typeof info !== "object" || typeof info.status !== "string" || !info.status) return null;
  return {
    status: info.status,
    type: typeof info.rateLimitType === "string" && info.rateLimitType ? info.rateLimitType : null,
    resetsAt: epochSecondsToMs(info.resetsAt),
    fiveHour: rateLimitWindow(info.unifiedWindows, "five_hour"),
    sevenDay: rateLimitWindow(info.unifiedWindows, "seven_day"),
  };
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

// Records a tool_use block's `run_in_background` input against its id, the only place the stream says whether a Bash call chose the background itself.
function trackToolUseRunInBackground(map, event) {
  if (event.type !== "assistant" || !Array.isArray(event.message?.content)) return;
  for (const block of event.message.content) {
    if (block?.type === "tool_use" && typeof block.id === "string") map.set(block.id, block.input?.run_in_background === true);
  }
}

// Records a task id an auto-backgrounding tool result named, the only place the Bash tool's OWN timeout (not the CLI's) shows up.
function trackAutoBackgroundedFromToolResult(set, event) {
  if (event.type !== "user" || !Array.isArray(event.message?.content)) return;
  for (const block of event.message.content) {
    const text = block?.type === "tool_result" && typeof block.content === "string" ? block.content : "";
    const match = AUTO_BACKGROUNDED_RE.exec(text);
    if (match) set.add(match[1]);
  }
}

// The task the CLI itself killed, read from the LAST attempt of the log; null when nothing was killed.
// A kill shows either as the raw ceiling line (never a JSON event) or as a `task_updated` event whose patch marks the task killed;
// the description comes from the last `background_tasks_changed` event that still lists that task, falling back to its bare id.
// The task's `taskType` comes from the same event, or from `task_started` when that is the only one that carried it.
// Everything else on the result carries what a kill notice needs to say only what the stream proves: whether the ceiling line
// was seen, whether a `result` event with a `## Notice` followed the kill, and whether the killed Bash call was ever
// foreground - either forced to the background by the Bash tool's own timeout, or launched with `run_in_background: true`.
export function runtimeKillFromStream(log) {
  const scanned = linesWithFenceState(lastAttemptStream(log));
  let sawCeilingLine = false;
  let killedTaskId = null;
  let lastListedTaskId = null;
  let killSeen = false;
  let noticeAfterKill = false;
  const descriptions = new Map();
  const taskTypes = new Map();
  const taskToolUseIds = new Map();
  const toolUseRunInBackground = new Map();
  const autoBackgroundedTaskIds = new Set();
  for (const entry of scanned) {
    if (!isMarkerCandidate(entry)) continue;
    const event = parseEventLine(entry.line);
    if (event === null) {
      if (RAW_CEILING_LINE_RE.test(entry.line)) sawCeilingLine = true;
      continue;
    }
    trackToolUseRunInBackground(toolUseRunInBackground, event);
    trackAutoBackgroundedFromToolResult(autoBackgroundedTaskIds, event);
    if (killSeen && event.type === "result" && extractNotice(typeof event.result === "string" ? event.result : "")) {
      noticeAfterKill = true;
    }
    if (event.type !== "system") continue;
    if (event.subtype === "task_started" && typeof event.task_id === "string") {
      if (typeof event.task_type === "string") taskTypes.set(event.task_id, event.task_type);
      if (typeof event.tool_use_id === "string") taskToolUseIds.set(event.task_id, event.tool_use_id);
    }
    if (event.subtype === "background_tasks_changed" && Array.isArray(event.tasks)) {
      for (const task of event.tasks) {
        if (typeof task?.task_id !== "string") continue;
        lastListedTaskId = task.task_id;
        if (typeof task.description === "string") descriptions.set(task.task_id, task.description);
        if (typeof task.task_type === "string") taskTypes.set(task.task_id, task.task_type);
      }
    }
    if (event.subtype === "task_updated" && event.patch?.is_backgrounded === true && typeof event.task_id === "string") {
      autoBackgroundedTaskIds.add(event.task_id);
    }
    if (event.subtype === "task_updated" && event.patch?.status === "killed" && typeof event.task_id === "string") {
      killedTaskId = event.task_id;
      killSeen = true;
    }
  }
  if (!sawCeilingLine && killedTaskId === null) return null;
  const taskId = killedTaskId ?? lastListedTaskId;
  const toolUseId = taskId ? (taskToolUseIds.get(taskId) ?? null) : null;
  return {
    taskId,
    description: taskId ? (descriptions.get(taskId) ?? taskId) : "background task",
    taskType: taskId ? (taskTypes.get(taskId) ?? null) : null,
    ceilingSeen: sawCeilingLine,
    noticeAfterKill,
    runInBackground: toolUseId !== null && toolUseRunInBackground.get(toolUseId) === true,
    autoBackgrounded: taskId !== null && autoBackgroundedTaskIds.has(taskId),
  };
}

// Tells whether the LAST attempt of a log shows the host backgrounding a task despite CLAUDE_CODE_DISABLE_BACKGROUND_TASKS.
export function sawDisabledBackgroundTask(log) {
  for (const entry of linesWithFenceState(lastAttemptStream(log))) {
    if (!isMarkerCandidate(entry)) continue;
    const event = parseEventLine(entry.line);
    if (event?.type === "system" && event.subtype === "task_updated" && event.patch?.is_backgrounded === true) return true;
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

// A level-2 heading other than the confirmation one, which ends its section.
const NEXT_SECTION_RE = /^##\s+\S/;

// The `## Requires user confirmation` section of a plan's text, heading included, up to the next level-2 heading outside a fence.
export function confirmationSection(text) {
  const scanned = linesWithFenceState(text);
  let start = -1;
  let end = scanned.length;
  scanned.forEach((entry, index) => {
    if (!isMarkerCandidate(entry)) return;
    if (start < 0 && GATE_HEADING_RE.test(entry.line)) start = index;
    else if (start >= 0 && end === scanned.length && NEXT_SECTION_RE.test(entry.line)) end = index;
  });
  if (start < 0) return null;
  const body = scanned
    .slice(start, end)
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

// Tells whether a value is, on its own, a pull request URL: the shape a structured field has to carry to be believed.
export function isPrUrl(value) {
  return typeof value === "string" && PR_URL_ONLY_RE.test(value);
}

// Repository a pull request URL belongs to, as `owner/name` and folded, which is how a publication is told from another repository's.
export function prUrlRepo(url) {
  if (!isPrUrl(url)) return null;
  const [owner, name] = String(url).split("/").slice(3, 5);
  return `${owner}/${name}`.toLowerCase();
}

// Tells whether an event is the host announcing a pull request it has just OPENED, carrying a `url` that really is one.
function isPublishedPr(event) {
  return event?.type === "system" && event.subtype === "code_change_published" && event.action === "created" && isPrUrl(event.url);
}

// Repository a publication happened in: the `repo` the host named, or the one its own URL carries when it named none.
function publishedRepo(event) {
  const named = typeof event.repo === "string" ? event.repo.trim().toLowerCase() : "";
  return named || prUrlRepo(event.url);
}

// The repository of the run among what the attempt published: the one the caller vouches for when a publication confirms it, the FIRST publication's otherwise.
function ownRepo(published, repo) {
  const wanted = typeof repo === "string" ? repo.trim().toLowerCase() : "";
  if (wanted && published.some((event) => publishedRepo(event) === wanted)) return wanted;
  return publishedRepo(published[0]);
}

// Pull request the HOST itself published (`system`/`code_change_published` with `action: "created"`): a fact of the platform, which no text of the agent contradicts.
// A session may publish into more than one repository, so only the run's own speaks - the LAST publication of that repository is the delivery, and a `url` that is not a pull request URL is ignored.
export function extractPublishedPrUrl(log, { repo = null } = {}) {
  const published = String(log ?? "")
    .split("\n")
    .map(parseEventLine)
    .filter(isPublishedPr);
  if (published.length === 0) return null;
  const own = ownRepo(published, repo);
  return published.filter((event) => publishedRepo(event) === own).at(-1).url;
}

// Last pull request the ORCHESTRATOR delivered in an intermediate event, the only fallback when the final text delivers none.
function prUrlFromAssistants(log) {
  const lines = String(log ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const text = orchestratorTextFromLine(lines[i]);
    if (!text) continue;
    const prUrl = extractPrUrl(text);
    if (prUrl) return prUrl;
  }
  return null;
}

// Pull request of the run: the final `result` event has the authority, and a delivery in an earlier event is the fallback.
export function extractPrUrlFromStream(log) {
  const resultText = extractResultText(log);
  return (resultText ? extractPrUrl(resultText) : null) ?? prUrlFromAssistants(log);
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

// The literal the Bash tool's own timeout writes into an error result; distinct from a mention of it in prose.
const BASH_TIMEOUT_TEXT_RE = /Command timed out/;

// Plain text of a tool_result block's `content`, whether the CLI wrote it as a bare string or as an array of text blocks.
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

// How many tool_result blocks of a `user` event are the Bash tool's own timeout: is_error true and its content names it.
function bashTimeoutsOf(event) {
  if (event?.type !== "user" || !Array.isArray(event.message?.content)) return 0;
  return event.message.content.filter(
    (block) => block?.type === "tool_result" && block.is_error === true && BASH_TIMEOUT_TEXT_RE.test(toolResultText(block.content)),
  ).length;
}

// Records the task id of a `task_updated` event into the given set, when its patch carries the literal this counter looks for.
function trackTaskUpdated(set, event, matches) {
  if (event?.type !== "system" || event.subtype !== "task_updated" || typeof event.task_id !== "string") return;
  if (matches(event.patch)) set.add(event.task_id);
}

// Counts of one attempt's own host commands: bash timeouts (once per tool result), and the distinct tasks the host
// backgrounded or killed - never a `task_updated` a subagent emits with `is_backgrounded: false`. Respects the same
// fence/marker discipline the sibling extractors use, so a line quoted inside a code fence is never read as an event.
export function extractHostCommandCounts(log) {
  let bashTimeouts = 0;
  const backgrounded = new Set();
  const killed = new Set();
  for (const entry of linesWithFenceState(log)) {
    if (!isMarkerCandidate(entry)) continue;
    const event = parseEventLine(entry.line);
    if (event === null) continue;
    bashTimeouts += bashTimeoutsOf(event);
    trackTaskUpdated(backgrounded, event, (patch) => patch?.is_backgrounded === true);
    trackTaskUpdated(killed, event, (patch) => patch?.status === "killed");
  }
  return { bashTimeouts, tasksBackgrounded: backgrounded.size, tasksKilled: killed.size };
}

// Usage of the orchestrator's FIRST assistant turn (parent_tool_use_id null, never a subagent's), or null when there is none.
export function extractBaselineCtx(log) {
  for (const entry of linesWithFenceState(log)) {
    if (!isMarkerCandidate(entry)) continue;
    const event = parseEventLine(entry.line);
    if (event?.type !== "assistant" || event.parent_tool_use_id !== null || !event.message?.usage) continue;
    const usage = event.message.usage;
    return finite(usage.input_tokens) + finite(usage.cache_read_input_tokens) + finite(usage.cache_creation_input_tokens);
  }
  return null;
}

// Consolidates the host command counts of several attempts into one total, the same way `sumUsage` does for tokens.
export function sumHostCommandCounts(counts) {
  const list = (Array.isArray(counts) ? counts : []).filter((entry) => entry && typeof entry === "object");
  return list.reduce(
    (total, entry) => ({
      bashTimeouts: total.bashTimeouts + finite(entry.bashTimeouts),
      tasksBackgrounded: total.tasksBackgrounded + finite(entry.tasksBackgrounded),
      tasksKilled: total.tasksKilled + finite(entry.tasksKilled),
    }),
    { bashTimeouts: 0, tasksBackgrounded: 0, tasksKilled: 0 },
  );
}

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

// Context the model saw on one turn: its fresh input plus what it read from and wrote to the prompt cache; null without usage.
function turnContext(event) {
  const usage = event.message?.usage;
  if (!usage || typeof usage !== "object") return null;
  return finite(usage.input_tokens) + finite(usage.cache_read_input_tokens) + finite(usage.cache_creation_input_tokens);
}

// Records one orchestrator assistant event as a turn: once per message id, once per event when it carries none.
function countOrchestratorTurn(counts, turnIds, event) {
  const id = event.message?.id;
  if (typeof id === "string" && id !== "") {
    if (!turnIds.has(id)) counts.turns += 1;
    turnIds.add(id);
  } else {
    counts.turns += 1;
  }
  const context = turnContext(event);
  if (context !== null) counts.ctxLast = context;
}

// The tool_use blocks of one assistant event not seen before in the stream, deduped by block id.
function newToolUses(event, toolIds) {
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content.filter((block) => {
    if (block?.type !== "tool_use" || typeof block.name !== "string") return false;
    if (typeof block.id !== "string" || block.id === "") return true;
    if (toolIds.has(block.id)) return false;
    toolIds.add(block.id);
    return true;
  });
}

// Adds one orchestrator tool call to the counts: a read outside the allowed roots, a Bash call and a Bash call outside the closed list.
function countOrchestratorToolUse(counts, block, scope) {
  if (READ_TOOLS.has(block.name) && !insideRoots(readTarget(block.name, block.input, scope.cwd), scope.roots)) counts.reads += 1;
  if (block.name !== "Bash") return;
  counts.bash += 1;
  if (!orchestratorBashAllowed(block.input?.command)) counts.bashExplore += 1;
}

// Counts of one attempt's orchestrator (never a subagent): its turns, its reads outside the run and the plugin, its Bash
// calls and those outside the closed list, and the context of its last turn. Respects the fence/marker discipline of the
// sibling extractors, so a line quoted inside a code fence is never read as an event.
export function extractOrchestratorCounts(log, { roots = [], cwd = null } = {}) {
  const counts = { turns: 0, reads: 0, bash: 0, bashExplore: 0, ctxLast: null };
  const turnIds = new Set();
  const toolIds = new Set();
  const scope = { roots: Array.isArray(roots) ? roots : [], cwd };
  for (const entry of linesWithFenceState(log)) {
    if (!isMarkerCandidate(entry)) continue;
    const event = parseEventLine(entry.line);
    if (event?.type !== "assistant" || isSubagentEvent(event)) continue;
    countOrchestratorTurn(counts, turnIds, event);
    for (const block of newToolUses(event, toolIds)) countOrchestratorToolUse(counts, block, scope);
  }
  return counts;
}

// The distinct safe session ids of the orchestrator's own assistant events, in order of appearance, fenced lines ignored.
export function extractOrchestratorSessionIds(log) {
  const ids = new Set();
  for (const entry of linesWithFenceState(log)) {
    if (!isMarkerCandidate(entry)) continue;
    const event = parseEventLine(entry.line);
    if (event?.type !== "assistant" || isSubagentEvent(event)) continue;
    if (isSessionIdSafe(event.session_id)) ids.add(event.session_id);
  }
  return [...ids];
}

// Consolidates the orchestrator counts of several attempts: the four counts summed, the context of the last attempt that reported one.
export function sumOrchestratorCounts(counts) {
  const list = (Array.isArray(counts) ? counts : []).filter((entry) => entry && typeof entry === "object");
  return list.reduce(
    (total, entry) => ({
      turns: total.turns + finite(entry.turns),
      reads: total.reads + finite(entry.reads),
      bash: total.bash + finite(entry.bash),
      bashExplore: total.bashExplore + finite(entry.bashExplore),
      ctxLast: Number.isFinite(entry.ctxLast) ? entry.ctxLast : total.ctxLast,
    }),
    { turns: 0, reads: 0, bash: 0, bashExplore: 0, ctxLast: null },
  );
}
