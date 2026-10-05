import assert from "node:assert/strict";
import { test } from "node:test";
import { jobRecalls } from "../../src/queue/recalls.mjs";
import { agentToolUseEvent, attemptMarker, taskStartedEvent, toolResultEvent, toolUseEvent } from "../../test-support/streams.mjs";

const LESSON = "mcp__nightqueue__lesson_recall";
const DECISION = "mcp__nightqueue__decision_recall";
const INDEX = "mcp__nightqueue__index_recall";
const MEMORY = "mcp__nightqueue__memory_recall";

// A tool_result whose content is the JSON answer inside one text block, the shape MCP tools write.
function jsonResult(toolUseId, value, options = {}) {
  return toolResultEvent({ ...options, toolUseId, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
}

// Joins stream events and raw marker lines into the text of a job log.
function logOf(lines) {
  return lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n");
}

test("recalls are grouped by phase and agent across attempts, with their query and the refs that came back", async () => {
  const log = logOf([
    attemptMarker(1),
    toolUseEvent({ name: LESSON, id: "r1", input: { project: "alpha" } }),
    jsonResult("r1", [{ id: 7, title: "Guard the path", via: "fallback" }]),
    agentToolUseEvent({ id: "lane1", subagentType: "nightqueue:architect" }),
    toolUseEvent({ name: DECISION, id: "r2", input: { project: "alpha", query: "studio api" }, parentToolUseId: "lane1" }),
    jsonResult("r2", [{ id: 3, ref: "D-12", title: "API is host-local" }], { parentToolUseId: "lane1" }),
    attemptMarker(2),
    taskStartedEvent({ toolUseId: "lane2", subagentType: "nightqueue:coder" }),
    toolUseEvent({ name: INDEX, id: "r3", input: { project: "alpha", query: "timeline" }, parentToolUseId: "lane2" }),
    jsonResult("r3", { files: [{ path: "src/queue/timeline.mjs", responsibility: "phase timeline" }], libs: [] }, { parentToolUseId: "lane2" }),
    toolUseEvent({ name: MEMORY, id: "r4", input: { query: "tier", target: "coder" }, parentToolUseId: "lane2" }),
    jsonResult("r4", [], { parentToolUseId: "lane2" }),
  ]);
  const groups = await jobRecalls(log);
  assert.deepEqual(
    groups.map((group) => [group.phase, group.agent, group.recalls.length]),
    [
      [null, "orchestrator", 1],
      [3, "architect", 1],
      [4, "coder", 2],
    ],
  );
  const [orchestrator, architect, coder] = groups;
  assert.deepEqual(orchestrator.recalls[0].results, [{ ref: "L7", title: "Guard the path" }]);
  assert.deepEqual(orchestrator.recalls[0].input, { project: "alpha" });
  assert.equal(orchestrator.recalls[0].attempt, 1);
  assert.equal(architect.recalls[0].query, "studio api");
  assert.deepEqual(architect.recalls[0].results, [{ ref: "D-12", title: "API is host-local" }]);
  assert.equal(coder.recalls[0].attempt, 2);
  assert.deepEqual(coder.recalls[0].results, [{ ref: "src/queue/timeline.mjs", title: "phase timeline" }]);
  assert.deepEqual([coder.recalls[1].tool, coder.recalls[1].pending, coder.recalls[1].results], ["memory_recall", false, []]);
  assert.deepEqual(coder.recalls[1].input, { target: "coder" });
});

test("a recall with no result yet is pending, and a result that is not JSON is unreadable", async () => {
  const log = logOf([
    attemptMarker(1),
    toolUseEvent({ name: LESSON, id: "r1", input: { query: "a" } }),
    toolResultEvent({ toolUseId: "r1", content: "not json at all" }),
    toolUseEvent({ name: LESSON, id: "r2", input: { query: "b" } }),
  ]);
  const [group] = await jobRecalls(log);
  assert.deepEqual(
    group.recalls.map((recall) => [recall.query, recall.pending, recall.error]),
    [
      ["a", false, "unreadable result"],
      ["b", true, null],
    ],
  );
});

test("a failed recall keeps the tool's error, and other tools or an empty log give no recall", async () => {
  const log = logOf([
    attemptMarker(1),
    toolUseEvent({ name: "Read", id: "t1", input: { file_path: "/x" } }),
    toolUseEvent({ name: LESSON, id: "r1", input: {} }),
    toolResultEvent({ toolUseId: "r1", content: "the store is locked", isError: true }),
  ]);
  const [group] = await jobRecalls(log);
  assert.equal(group.recalls.length, 1);
  assert.equal(group.recalls[0].error, "the store is locked");
  assert.deepEqual(await jobRecalls(""), []);
  assert.deepEqual(await jobRecalls(null), []);
});

test("a log of tens of megabytes is scanned without stalling the event loop, every recall kept", async () => {
  const pair = `${logOf([toolUseEvent({ name: LESSON, id: "r1", input: { query: "x".repeat(200) } }), toolResultEvent({ toolUseId: "r1", content: "y".repeat(600) })])}\n`;
  const copies = Math.ceil((48 * 1024 * 1024) / pair.length);
  const log = `${attemptMarker(1)}\n${pair.repeat(copies)}`;
  let last = performance.now();
  let worstGap = 0;
  const timer = setInterval(() => {
    worstGap = Math.max(worstGap, performance.now() - last);
    last = performance.now();
  }, 10);
  const [group] = await jobRecalls(log);
  clearInterval(timer);
  assert.equal(group.recalls.length, copies);
  assert.ok(worstGap < 150, `the event loop stalled ${Math.round(worstGap)} ms while the log was scanned`);
});
