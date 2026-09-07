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
export function assistantEvent(text, { sessionId = SESSION_ID, messageId = null, usage = null, parentToolUseId = null } = {}) {
  const event = {
    type: "assistant",
    session_id: sessionId,
    message: { id: messageId ?? `msg_${Math.random().toString(36).slice(2, 10)}`, role: "assistant", content: [{ type: "text", text }] },
  };
  if (usage) event.message.usage = usageBlock(usage);
  if (parentToolUseId) event.parent_tool_use_id = parentToolUseId;
  return event;
}

// The standalone `QUEUE_SLUG:` line the pipeline prints as soon as the slug exists.
export function slugEvent(slug = SLUG, options = {}) {
  return assistantEvent(`Registered the run.\nQUEUE_SLUG: ${slug}\n`, options);
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

// A run that stops at the human gate: the marker is a standalone heading of the orchestrator.
export function gateStream({ slug = SLUG, sessionId = SESSION_ID } = {}) {
  return toNdjson([
    systemInitEvent({ sessionId }),
    slugEvent(slug, { sessionId }),
    assistantEvent(`${GATE_MARKER}\n\nThe migration drops a column and needs a human decision.`, { sessionId, messageId: "msg_gate" }),
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
