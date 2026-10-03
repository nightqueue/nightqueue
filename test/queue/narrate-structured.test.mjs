import assert from "node:assert/strict";
import { test } from "node:test";
import { formatNarration, narrateLog } from "../../src/queue/narrate.mjs";
import { agentToolUseEvent, attemptMarker, LANE_TOOL_USE_ID, narrationStream, secondsIntoAttempt, systemInitEvent, taskNotificationEvent, toNdjson, toolUseEvent } from "../../test-support/streams.mjs";

const STRUCTURED_KEYS = ["agent", "phase", "model", "durationMs", "tool", "file"];

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

test("the structured fields never change a printed line, with color or without", () => {
  for (const log of [structuredLog(), narrationStream()]) {
    for (const event of narrateLog(log)) {
      for (const color of [false, true]) {
        assert.equal(formatNarration(event, { color }), formatNarration(withoutStructure(event), { color }));
      }
    }
  }
});
