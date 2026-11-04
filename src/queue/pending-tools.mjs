const TASK_DONE_STATUSES = new Set(["completed", "failed", "killed"]);
const NAME_MAX_CHARS = 80;
const LINE_BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

// A tool or task name fit for one log line: line-breaking and control characters blanked, length capped, the fallback when absent.
function safeName(value, fallback) {
  if (typeof value !== "string" || !value) return fallback;
  return value.replace(LINE_BREAKING, " ").slice(0, NAME_MAX_CHARS);
}

// Parses one stream-json line into an event object, or null when it is not one.
function parseEvent(line) {
  try {
    const event = JSON.parse(String(line));
    return event !== null && typeof event === "object" ? event : null;
  } catch {
    return null;
  }
}

// Content blocks of an assistant or user message, or an empty list for any other shape.
function contentBlocks(event) {
  const content = event.message?.content;
  return Array.isArray(content) ? content.filter((block) => block !== null && typeof block === "object") : [];
}

// Key of a background task, from its task id or else the tool call that started it.
function taskKey(event) {
  const id = typeof event.task_id === "string" ? event.task_id : event.tool_use_id;
  return typeof id === "string" && id ? `task:${id}` : null;
}

// Whether a system event closes the background task it names.
function closesTask(event) {
  if (event.subtype === "task_notification") return true;
  return event.subtype === "task_updated" && TASK_DONE_STATUSES.has(event.patch?.status);
}

// Tracks, from the child's stdout, the tool calls and background tasks still waiting for their end, on the main thread and every subagent.
export function createPendingTools({ now = Date.now } = {}) {
  const pending = new Map();

  function open(id, name) {
    if (pending.has(id)) return false;
    pending.set(id, { name, sinceMs: now() });
    return true;
  }

  function observeAssistant(event) {
    let changed = false;
    for (const block of contentBlocks(event)) {
      if (block.type === "tool_use" && typeof block.id === "string" && block.id) changed = open(block.id, safeName(block.name, "tool")) || changed;
    }
    return changed;
  }

  function observeUser(event) {
    let changed = false;
    for (const block of contentBlocks(event)) {
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") changed = pending.delete(block.tool_use_id) || changed;
    }
    return changed;
  }

  function observeSystem(event) {
    const key = taskKey(event);
    if (key === null) return false;
    if (event.subtype === "task_started") return open(key, safeName(event.task_type, "task"));
    return closesTask(event) ? pending.delete(key) : false;
  }

  // Reads one line of the stream and reports whether the pending set changed.
  function observe(line) {
    const event = parseEvent(line);
    if (event === null) return false;
    if (event.type === "assistant") return observeAssistant(event);
    if (event.type === "user") return observeUser(event);
    if (event.type === "system") return observeSystem(event);
    return false;
  }

  // The longest-pending entry, or null when nothing is pending.
  function oldest() {
    let found = null;
    for (const [id, entry] of pending) {
      if (found === null || entry.sinceMs < found.sinceMs) found = { id, ...entry };
    }
    return found;
  }

  return { observe, size: () => pending.size, oldest };
}
