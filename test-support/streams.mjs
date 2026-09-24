export const SESSION_ID = "sess-abc12345";
export const SLUG = "fix-the-worker";
export const GATE_MARKER = "## Requires user confirmation";
export const NOTICE_HEADING = "## Notice";
export const PR_URL = "https://github.com/acme/api/pull/42";
export const MODEL = "claude-sonnet-4-5";

// The `system` event the CLI emits first, the only place the session id shows up before any text.
export function systemInitEvent({ sessionId = SESSION_ID } = {}) {
  return { type: "system", subtype: "init", session_id: sessionId, model: MODEL, tools: ["Read", "Bash"] };
}

// Usage block of an assistant message, in the shape the CLI writes it.
export function usageBlock({ tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreation = 0 } = {}) {
  return {
    input_tokens: tokensIn,
    output_tokens: tokensOut,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  };
}

// An `assistant` event carrying text; `parentToolUseId` turns it into a subagent event.
export function assistantEvent(text, { sessionId = SESSION_ID, messageId = null, usage = null, parentToolUseId = null, timestamp = null } = {}) {
  const event = {
    type: "assistant",
    session_id: sessionId,
    message: { id: messageId ?? `msg_${Math.random().toString(36).slice(2, 10)}`, role: "assistant", content: [{ type: "text", text }] },
  };
  if (usage) event.message.usage = usageBlock(usage);
  if (parentToolUseId) event.parent_tool_use_id = parentToolUseId;
  if (timestamp) event.timestamp = timestamp;
  return event;
}

// The standalone `QUEUE_SLUG:` line the pipeline prints as soon as the slug exists.
export function slugEvent(slug = SLUG, options = {}) {
  return assistantEvent(`Registered the run.\nQUEUE_SLUG: ${slug}\n`, options);
}

// The standalone `SLUG:` line with which the pipeline renames, once, the run the runtime opened for it.
export function slugTypeEvent(slug = SLUG, type = "feature/refactor", options = {}) {
  return assistantEvent(`Named the run.\nSLUG: ${slug} TYPE: ${type}\n`, options);
}

// Per model usage block of a result event, in the camelCase shape the CLI writes it.
export function modelUsageBlock({ tokensIn = 0, tokensOut = 0, cacheRead = 0, cacheCreation = 0 } = {}) {
  return {
    [MODEL]: {
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      cacheReadInputTokens: cacheRead,
      cacheCreationInputTokens: cacheCreation,
    },
  };
}

// The final `result` event; by default it carries the two usage blocks the real CLI reports, and `usageShape` picks one of them or none.
export function resultEvent({
  text = "",
  sessionId = SESSION_ID,
  costUsd = 0.12,
  tokensIn = 1000,
  tokensOut = 200,
  cacheRead = 50,
  cacheCreation = 25,
  subtype = "success",
  usageShape = "both",
} = {}) {
  const tokens = { tokensIn, tokensOut, cacheRead, cacheCreation };
  const event = { type: "result", subtype, session_id: sessionId, result: text, total_cost_usd: costUsd };
  if (usageShape === "both" || usageShape === "aggregate") event.usage = usageBlock(tokens);
  if (usageShape === "both" || usageShape === "models") event.modelUsage = modelUsageBlock(tokens);
  return event;
}

// The `system` event the HOST emits when it publishes the change, in the measured shape: every field is top level, there is no timestamp, and `branch` only when given.
export function codeChangePublishedEvent({ url = PR_URL, provider = "github", repo = "acme/api", identifier = "42", action = "created", sessionId = SESSION_ID, branch = undefined } = {}) {
  const event = { type: "system", subtype: "code_change_published", provider, url, repo, identifier, action, uuid: `uuid_${identifier}`, session_id: sessionId };
  return branch === undefined ? event : { ...event, branch };
}

// A `## Notice` section, the executive summary the runner stores in notice_md.
export function noticeText(body = "The pull request is open and the checks are green.") {
  return `${NOTICE_HEADING}\n\n${body}`;
}

// Serializes events as the NDJSON the CLI writes on stdout, one event per line.
export function toNdjson(events) {
  return `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

// A run that ends with a pull request: init, slug, notice and a result carrying the URL.
export function doneStream({ slug = SLUG, sessionId = SESSION_ID, prUrl = PR_URL, notice = undefined, usage = {} } = {}) {
  return toNdjson([
    systemInitEvent({ sessionId }),
    slugEvent(slug, { sessionId }),
    assistantEvent("Opening the pull request now.", { sessionId, messageId: "msg_work", usage: { tokensIn: 10, tokensOut: 5 } }),
    assistantEvent(noticeText(notice), { sessionId, messageId: "msg_notice" }),
    resultEvent({ text: `Done. Pull request: ${prUrl}`, sessionId, ...usage }),
  ]);
}

// A run that delivered its pull request in an INTERMEDIATE message and whose final `result` is an unrelated
// sentence: a table cell that merely mentions the URL, the notice, and the delivery as the last line - job #17's shape.
export function intermediateDeliveryStream({ slug = SLUG, sessionId = SESSION_ID, prUrl = PR_URL, notice = "The pull request is open and the checks are green.", delivered = true } = {}) {
  const message = [
    "| Step | Agent | Status | Highlight |",
    "|------|-------|--------|-----------|",
    `| 7 Commit/PR | Commit/PR | ok | branch \`ns/fix-the-worker\` + ${prUrl} |`,
    "",
    NOTICE_HEADING,
    "",
    notice,
    "",
    delivered ? `Record: • PR ${prUrl}` : "Record: • PR opened for this run",
  ].join("\n");
  return toNdjson([
    systemInitEvent({ sessionId }),
    slugEvent(slug, { sessionId }),
    assistantEvent(message, { sessionId, messageId: "msg_record" }),
    resultEvent({ text: "Telemetry recorded (run 21). Worktree removed — the branch is on the remote.", sessionId }),
  ]);
}

// The reason a `gateStream()` gives by default for stopping at the human gate.
export const GATE_REASON = "The migration drops a column and needs a human decision.";

// The `## Notice` body a `gateStream()` carries by default: the confirmation heading itself plus
// the reason, the shape the runtime now requires of a valid gate notice.
export const GATE_NOTICE = `${GATE_MARKER}\n\n${GATE_REASON}`;

// A run that stops at the human gate: the marker is a standalone heading of the orchestrator, and
// its `## Notice` carries that same heading in its body, so the notice itself asks the question.
export function gateStream({ slug = SLUG, sessionId = SESSION_ID, reason = GATE_REASON } = {}) {
  return toNdjson([
    systemInitEvent({ sessionId }),
    slugEvent(slug, { sessionId }),
    assistantEvent(noticeText(`${GATE_MARKER}\n\n${reason}`), { sessionId, messageId: "msg_gate" }),
    resultEvent({ text: "Stopped at the gate.", sessionId }),
  ]);
}

// A run that fails for a reason no retry would fix.
export function failureStream({ sessionId = SESSION_ID, message = "TypeError: cannot read properties of undefined" } = {}) {
  return toNdjson([
    systemInitEvent({ sessionId }),
    assistantEvent(`The run broke: ${message}`, { sessionId, messageId: "msg_broken" }),
    resultEvent({ text: `Failed: ${message}`, sessionId, subtype: "error_during_execution" }),
  ]);
}

// A run that fails on a transient provider error, the only kind the runner retries.
export function transientFailureStream({ sessionId = SESSION_ID } = {}) {
  return toNdjson([
    systemInitEvent({ sessionId }),
    assistantEvent("API Error: 429 Too Many Requests (overloaded_error)", { sessionId, messageId: "msg_429" }),
    resultEvent({ text: "API Error: 429 Too Many Requests", sessionId, subtype: "error_during_execution" }),
  ]);
}

export const ATTEMPT_ISO = "2026-09-07T19:50:00.000Z";
export const LANE_TOOL_USE_ID = "toolu_agent1";
export const SUBAGENT_TYPE = "nightqueue:triager";

// The line `openAttemptLog` writes before each attempt of a job.
export function attemptMarker(attempt = 1, iso = ATTEMPT_ISO) {
  return `=== attempt ${attempt} @ ${iso} ===`;
}

// An ISO timestamp N seconds after the start of the attempt, the clock every narrated line is relative to.
export function secondsIntoAttempt(seconds, iso = ATTEMPT_ISO) {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

// An `assistant` event carrying a tool call, in the shape the CLI writes it.
export function toolUseEvent({ name = "Bash", id = "toolu_1", input = {}, sessionId = SESSION_ID, parentToolUseId = null, timestamp = null } = {}) {
  const event = {
    type: "assistant",
    session_id: sessionId,
    message: { id: `msg_${id}`, role: "assistant", content: [{ type: "tool_use", id, name, input, caller: { type: "direct" } }] },
  };
  if (parentToolUseId) event.parent_tool_use_id = parentToolUseId;
  if (timestamp) event.timestamp = timestamp;
  return event;
}

// The `tool_use` that opens a subagent lane: the tool is named `Agent`, only `subagent_type` identifies it, and `model` — measured next to it in every real block — is the only place the stream says which model the lane ran.
export function agentToolUseEvent({ id = LANE_TOOL_USE_ID, subagentType = SUBAGENT_TYPE, description = "triage the bug", prompt = "the whole prompt of the subagent", model = "sonnet", ...rest } = {}) {
  const input = { description, subagent_type: subagentType, prompt, run_in_background: false };
  return toolUseEvent({ ...rest, id, name: "Agent", input: model ? { ...input, model } : input });
}

// A `user` event carrying the result of a tool call; only a result flagged as an error is ever narrated.
export function toolResultEvent({ toolUseId = "toolu_1", content = "ok", isError = false, sessionId = SESSION_ID, parentToolUseId = null, timestamp = null } = {}) {
  const event = {
    type: "user",
    session_id: sessionId,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  };
  if (parentToolUseId) event.parent_tool_use_id = parentToolUseId;
  if (timestamp) event.timestamp = timestamp;
  return event;
}

// The `system` event that announces a subagent has started; the real one carries no timestamp.
export function taskStartedEvent({ toolUseId = LANE_TOOL_USE_ID, subagentType = SUBAGENT_TYPE, description = "triage the bug", prompt = "the whole prompt of the subagent", sessionId = SESSION_ID } = {}) {
  return {
    type: "system",
    subtype: "task_started",
    task_id: `task_${toolUseId}`,
    tool_use_id: toolUseId,
    description,
    subagent_type: subagentType,
    is_backgrounded: false,
    spawn_depth: 1,
    task_type: "agent",
    prompt,
    session_id: sessionId,
  };
}

// The `system` event that reports the progress of a running subagent, one of the many the narration ignores.
export function taskProgressEvent({ toolUseId = LANE_TOOL_USE_ID, subagentType = SUBAGENT_TYPE, description = "Running triage the bug", lastToolName = "Read", toolUses = 1 } = {}) {
  return {
    type: "system",
    subtype: "task_progress",
    task_id: `task_${toolUseId}`,
    tool_use_id: toolUseId,
    description,
    subagent_type: subagentType,
    usage: { total_tokens: 900, tool_uses: toolUses, duration_ms: 40000 },
    last_tool_name: lastToolName,
  };
}

// The `system` event that closes a subagent; it carries the usage of the task, no timestamp and no subagent type.
export function taskNotificationEvent({ toolUseId = LANE_TOOL_USE_ID, status = "completed", summary = "the whole summary of the subagent", totalTokens = 1200, toolUses = 2, durationMs = 125000 } = {}) {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: `task_${toolUseId}`,
    tool_use_id: toolUseId,
    status,
    output_file: null,
    summary,
    usage: { total_tokens: totalTokens, tool_uses: toolUses, duration_ms: durationMs },
  };
}

// A hook event, the noise that dominates the count of events of a real session.
export function hookEvent({ subtype = "hook_started", name = "PreToolUse" } = {}) {
  return { type: "system", subtype, hook_name: name };
}

// The gap the measured event carried between its two windows, in seconds: 1789938000 - 1789429800, almost six days.
const WINDOW_GAP_S = 508200;
// The two windows of a real event, in epoch SECONDS: the five-hour one resets in an hour, the seven-day one almost six days later.
// Both are derived when the fixture loads, never hardcoded, so the pause they arm is always live; a test that needs a fixed instant passes `resetsAt`.
export const FIVE_HOUR_RESETS_AT_S = Math.floor(Date.now() / 1000) + 3600;
export const SEVEN_DAY_RESETS_AT_S = FIVE_HOUR_RESETS_AT_S + WINDOW_GAP_S;

// The rate limit event the CLI emits between turns, in the measured shape: `resetsAt` in epoch seconds, one entry per window, and the `overageStatus` decoy a healthy event carries.
export function rateLimitEvent({ status = "allowed", rateLimitType = "five_hour", fiveHour = 0.06, sevenDay = 0.06, resetsAt = null } = {}) {
  const windowResetsAt = rateLimitType === "seven_day" ? SEVEN_DAY_RESETS_AT_S : FIVE_HOUR_RESETS_AT_S;
  return {
    type: "rate_limit_event",
    rate_limit_info: {
      status,
      resetsAt: resetsAt ?? windowResetsAt,
      rateLimitType,
      overageStatus: "rejected",
      overageDisabledReason: "org_level_disabled",
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: fiveHour, resetsAt: FIVE_HOUR_RESETS_AT_S },
        seven_day: { utilization: sevenDay, resetsAt: SEVEN_DAY_RESETS_AT_S },
      },
    },
    uuid: "7c8431e9-c8b7-43fe-8a4a-72e66d568f89",
    session_id: SESSION_ID,
  };
}

// A whole job log with the noise of a real session: one attempt, one subagent lane, a failed tool and a result.
export function narrationStream({ slug = SLUG, prUrl = PR_URL, sessionId = SESSION_ID, notice = undefined } = {}) {
  const at = (seconds) => secondsIntoAttempt(seconds);
  const events = [
    systemInitEvent({ sessionId }),
    hookEvent({ subtype: "hook_started" }),
    hookEvent({ subtype: "hook_response" }),
    assistantEvent("Reading the ticket before anything else.", { sessionId, messageId: "msg_read", timestamp: at(2) }),
    slugEvent(slug, { sessionId, messageId: "msg_slug", timestamp: at(3) }),
    rateLimitEvent(),
    toolUseEvent({ id: "toolu_bash", name: "Bash", input: { command: "git status --short", description: "check the tree" }, sessionId, timestamp: at(5) }),
    toolResultEvent({ toolUseId: "toolu_bash", content: "M  src/cli/queue.mjs", sessionId, timestamp: at(6) }),
    toolUseEvent({ id: "toolu_fail", name: "Bash", input: { command: "npm test", description: "run the suite" }, sessionId, timestamp: at(7) }),
    toolResultEvent({ toolUseId: "toolu_fail", content: "Exit code 1\nnothing else matters", isError: true, sessionId, timestamp: at(8) }),
    agentToolUseEvent({ sessionId, timestamp: at(9) }),
    taskStartedEvent({ sessionId }),
    assistantEvent("Looking at the runner first.", { sessionId, messageId: "msg_lane", parentToolUseId: LANE_TOOL_USE_ID, timestamp: at(12) }),
    toolUseEvent({ id: "toolu_read", name: "Read", input: { file_path: "/repo/src/cli/index.mjs" }, sessionId, parentToolUseId: LANE_TOOL_USE_ID, timestamp: at(13) }),
    toolResultEvent({ toolUseId: "toolu_read", content: "the whole file", sessionId, parentToolUseId: LANE_TOOL_USE_ID, timestamp: at(14) }),
    taskProgressEvent(),
    taskNotificationEvent(),
    assistantEvent(noticeText(notice), { sessionId, messageId: "msg_notice", timestamp: at(134) }),
    resultEvent({ text: `Done. Pull request: ${prUrl}`, sessionId }),
  ];
  return `${attemptMarker(1)}\n${toNdjson(events)}`;
}
