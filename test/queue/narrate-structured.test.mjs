import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNarration, narrateLog } from "../../src/queue/narrate.mjs";
import { agentToolUseEvent, assistantEvent, attemptMarker, LANE_TOOL_USE_ID, narrationStream, secondsIntoAttempt, systemInitEvent, taskNotificationEvent, toNdjson, toolUseEvent } from "../../test-support/streams.mjs";

const STRUCTURED_KEYS = ["agent", "phase", "model", "durationMs", "tool", "file", "laneId", "laneTokens"];

// The same event without any of the structured fields, the shape the narrator emitted before them.
function withoutStructure(event) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => !STRUCTURED_KEYS.includes(key)));
}

// One attempt with a coder lane that edits a file and an orchestrator command that marks a phase.
function structuredLog() {
  return `${attemptMarker(1)}\n${toNdjson([
    systemInitEvent(),
    agentToolUseEvent({ subagentType: "nightqueue:coder", description: "implement", model: "opus", timestamp: secondsIntoAttempt(5) }),
    toolUseEvent({ name: "Write", id: "toolu_w", input: { file_path: "/repo/docs/notes.md" }, parentToolUseId: LANE_TOOL_USE_ID, timestamp: secondsIntoAttempt(6) }),
    taskNotificationEvent({ durationMs: 30000 }),
    toolUseEvent({ name: "Bash", id: "toolu_r", input: { command: "nightqueue run report --json" }, timestamp: secondsIntoAttempt(40) }),
  ])}`;
}

test("lane and tool events carry the structured fields a renderer reads instead of the text", () => {
  const events = narrateLog(structuredLog());
  const opened = events.find((event) => event.kind === "laneOpen");
  assert.deepEqual([opened.agent, opened.phase, opened.model], ["coder", 4, "opus"]);
  const closed = events.find((event) => event.kind === "laneClose");
  assert.deepEqual([closed.agent, closed.phase, closed.durationMs], ["coder", 4, 30000]);
  const write = events.find((event) => event.tool === "Write");
  assert.equal(write.file, "notes.md");
  const report = events.find((event) => event.tool === "Bash");
  assert.equal(report.phase, 8);
});

// One attempt with an orchestrator turn and a lane turn that both carry usage, the second one repeated under the same message id.
function usageLog() {
  return `${attemptMarker(1)}\n${toNdjson([
    assistantEvent("starting", { messageId: "msg_orch", usage: { tokensIn: 10, tokensOut: 5, cacheRead: 100, cacheCreation: 20 }, timestamp: secondsIntoAttempt(1) }),
    agentToolUseEvent({ subagentType: "nightqueue:coder", timestamp: secondsIntoAttempt(2) }),
    assistantEvent("editing", { messageId: "msg_lane", usage: { tokensIn: 7 }, parentToolUseId: LANE_TOOL_USE_ID, timestamp: secondsIntoAttempt(3) }),
    taskNotificationEvent({ totalTokens: 900 }),
  ])}`;
}

test("usage events appear only when asked for, after the blocks of their message, with the lane and the summed counters", () => {
  assert.equal(narrateLog(usageLog()).some((event) => event.kind === "usage"), false);
  const events = narrateLog(usageLog(), { usage: true });
  const kinds = events.map((event) => event.kind);
  assert.equal(kinds.indexOf("usage"), kinds.indexOf("text") + 1, "the usage of a message comes after its blocks");
  const [orchestrator, inLane] = events.filter((event) => event.kind === "usage");
  assert.deepEqual([orchestrator.laneId, orchestrator.phase, orchestrator.messageId, orchestrator.tokens], [null, null, "msg_orch", 135]);
  assert.deepEqual([inLane.laneId, inLane.agent, inLane.phase, inLane.tokens], [LANE_TOOL_USE_ID, "coder", 4, 7]);
  const closed = events.find((event) => event.kind === "laneClose");
  assert.deepEqual([closed.laneId, closed.laneTokens], [LANE_TOOL_USE_ID, 900]);
  assert.equal(events.find((event) => event.kind === "laneOpen").laneId, LANE_TOOL_USE_ID);
});

test("asking for usage leaves every other narration event unchanged", () => {
  const plain = narrateLog(usageLog());
  const withUsage = narrateLog(usageLog(), { usage: true }).filter((event) => event.kind !== "usage");
  assert.deepEqual(withUsage, plain);
});

test("the structured fields never change a printed line, with color or without", () => {
  for (const log of [structuredLog(), narrationStream()]) {
    for (const event of narrateLog(log)) {
      for (const color of [false, true]) {
        assert.equal(formatNarration(event, { color }), formatNarration(withoutStructure(event), { color }));
      }
    }
  }
});
