import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsage } from "../../src/queue/stream.mjs";
import { assistantEvent, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

// H1: a single attempt whose stream carries TWO sessions (e.g. a mid-attempt compaction or
// resume that starts a fresh session_id). Session A reports real tokens on its result event;
// session B has no usage block at all on its result event, but DID emit assistant turns with
// real message.usage. The correct total must reflect both sessions, exactly like it would if
// session B were the only session in the log.
test("a second session with no result usage still contributes its assistant-estimated tokens to the total", () => {
  const sessionA = "sess-aaaaaaaa";
  const sessionB = "sess-bbbbbbbb";
  const stream = toNdjson([
    systemInitEvent({ sessionId: sessionA }),
    assistantEvent("session A working", {
      sessionId: sessionA,
      messageId: "msg_a",
      usage: { tokensIn: 900, tokensOut: 120, cacheRead: 40, cacheCreation: 15 },
    }),
    resultEvent({
      text: "session A done",
      sessionId: sessionA,
      tokensIn: 900,
      tokensOut: 120,
      cacheRead: 40,
      cacheCreation: 15,
      costUsd: 0.3,
      usageShape: "both",
    }),
    systemInitEvent({ sessionId: sessionB }),
    assistantEvent("session B working", {
      sessionId: sessionB,
      messageId: "msg_b",
      usage: { tokensIn: 7, tokensOut: 3, cacheRead: 1, cacheCreation: 2 },
    }),
    resultEvent({ text: "session B done", sessionId: sessionB, costUsd: 0.05, usageShape: "none" }),
  ]);

  // Same numbers session B would produce alone (see the "falls back to the assistants"
  // case already covered in test/queue/stream.test.mjs), added on top of session A's total.
  const combined = extractUsage(stream);
  assert.deepEqual(
    combined,
    {
      tokensIn: 900 + 7,
      tokensOut: 120 + 3,
      cacheRead: 40 + 1,
      cacheCreation: 15 + 2,
      costUsd: 0.35,
      sessions: 2,
      estimated: false,
    },
    "session B's estimated tokens were silently dropped because session A's report flipped the whole attempt to reported=true",
  );
});
