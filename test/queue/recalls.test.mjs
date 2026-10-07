import assert from "node:assert/strict";
import { test } from "node:test";
import { STANDING_HEADING } from "../../src/memory/decisions.mjs";
import { DECISIONS_HEADING, jobRecalls, LESSONS_HEADING, MEMORY_HEADING } from "../../src/queue/recalls.mjs";
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

test("recalls come as one flat list in run order across attempts, each with its kind, agent, phase and the hits that came back", async () => {
  const log = logOf([
    attemptMarker(1),
    toolUseEvent({ name: LESSON, id: "r1", input: { project: "alpha" } }),
    jsonResult("r1", [{ id: 7, title: "Guard the path", via: "fallback" }]),
    agentToolUseEvent({ id: "lane1", subagentType: "nightqueue:architect" }),
    toolUseEvent({ name: DECISION, id: "r2", input: { project: "alpha", query: "studio api" }, parentToolUseId: "lane1" }),
    jsonResult("r2", [{ id: 3, ref: "D-12", title: "API is host-local", cosine: 0.8123 }], { parentToolUseId: "lane1" }),
    attemptMarker(2),
    taskStartedEvent({ toolUseId: "lane2", subagentType: "nightqueue:coder" }),
    toolUseEvent({ name: INDEX, id: "r3", input: { project: "alpha", query: "timeline" }, parentToolUseId: "lane2" }),
    jsonResult("r3", { files: [{ path: "src/queue/timeline.mjs", responsibility: "phase timeline", score: 0.9 }], libs: [] }, { parentToolUseId: "lane2" }),
    toolUseEvent({ name: MEMORY, id: "r4", input: { query: "tier", target: "coder" }, parentToolUseId: "lane2" }),
    jsonResult("r4", [], { parentToolUseId: "lane2" }),
  ]);
  const recalls = await jobRecalls(log);
  assert.deepEqual(
    recalls.map((recall) => [recall.tool, recall.kind, recall.phase, recall.agent, recall.attempt]),
    [
      ["lesson_recall", "lesson", null, "orchestrator", 1],
      ["decision_recall", "decision", 3, "architect", 1],
      ["index_recall", "index", 4, "coder", 2],
      ["memory_recall", "memory", 4, "coder", 2],
    ],
  );
  const [orchestrator, architect, coder, memory] = recalls;
  assert.deepEqual(orchestrator.hits, [{ ref: "L7", title: "Guard the path", score: null, via: "fallback" }]);
  assert.equal(architect.query, "studio api");
  assert.deepEqual(architect.hits, [{ ref: "D-12", title: "API is host-local", score: 0.8123 }]);
  assert.deepEqual(coder.hits, [{ ref: "src/queue/timeline.mjs", title: "phase timeline", score: 0.9 }]);
  assert.deepEqual([memory.pending, memory.error, memory.hits], [false, null, []]);
  assert.equal("results" in memory, false);
});

test("at_s counts the seconds from the attempt's marker to the recall's event, else from the attempt's first stamped event", async () => {
  const log = logOf([
    attemptMarker(1, "2026-10-06T10:00:00Z"),
    toolUseEvent({ name: LESSON, id: "r1", input: { query: "a" }, timestamp: "2026-10-06T10:00:11Z" }),
    toolUseEvent({ name: LESSON, id: "r2", input: { query: "b" } }),
    attemptMarker(2, "2026-10-06T11:00:00Z"),
    toolUseEvent({ name: LESSON, id: "r3", input: { query: "c" }, timestamp: "2026-10-06T11:00:42Z" }),
  ]);
  assert.deepEqual(
    (await jobRecalls(log)).map((recall) => [recall.query, recall.attempt, recall.at_s]),
    [
      ["a", 1, 11],
      ["b", 1, null],
      ["c", 2, 42],
    ],
  );
  const unanchored = logOf([
    toolUseEvent({ name: "Read", id: "t1", timestamp: "2026-10-06T10:00:00Z" }),
    toolUseEvent({ name: LESSON, id: "r1", input: { query: "a" }, timestamp: "2026-10-06T10:01:05Z" }),
  ]);
  assert.equal((await jobRecalls(unanchored))[0].at_s, 65);
});

test("a lesson hit carries its labelled text and a memory hit its value, for the drawer", async () => {
  const log = logOf([
    attemptMarker(1),
    toolUseEvent({ name: LESSON, id: "r1", input: { query: "a" } }),
    jsonResult("r1", [{ id: 5, title: "Guard it", root_cause: "no guard", solution: "add one", prevention: "test it", cosine: 0.61 }]),
    toolUseEvent({ name: MEMORY, id: "r2", input: { query: "b" } }),
    jsonResult("r2", [{ id: 9, key: "tier", value: "use the small tier" }]),
  ]);
  const [lesson, memory] = await jobRecalls(log);
  assert.deepEqual(lesson.hits, [{ ref: "L5", title: "Guard it", score: 0.61, text: "Root cause: no guard\nSolution: add one\nPrevention: test it" }]);
  assert.deepEqual(memory.hits, [{ ref: "M9", title: "tier", score: null, text: "use the small tier" }]);
});

test("a recall with no result yet is pending, and a result that is not JSON is unreadable", async () => {
  const log = logOf([
    attemptMarker(1),
    toolUseEvent({ name: LESSON, id: "r1", input: { query: "a" } }),
    toolResultEvent({ toolUseId: "r1", content: "not json at all" }),
    toolUseEvent({ name: LESSON, id: "r2", input: { query: "b" } }),
  ]);
  const recalls = await jobRecalls(log);
  assert.deepEqual(
    recalls.map((recall) => [recall.query, recall.pending, recall.error]),
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
  const recalls = await jobRecalls(log);
  assert.equal(recalls.length, 1);
  assert.equal(recalls[0].error, "the store is locked");
  assert.deepEqual(await jobRecalls(""), []);
  assert.deepEqual(await jobRecalls(null), []);
});

const PHASE_PROMPT = "mcp__nightqueue__phase_prompt";
const CONTEXT = "mcp__nightqueue__context_for_phase";

// A rendered phase prompt: a brief with decision-like lines, the three memory sections, the in-full repeats and the proposed list.
function promptText({ lessons = ["L5"], memories = ["M9"], decisions = ["D-7"] } = {}) {
  return [
    "## File handoff (contract — read first)",
    "- D-99 a handoff line is never a hit",
    "## Brief",
    "- D-98 a decision the brief names is never a hit",
    `## ${LESSONS_HEADING}`,
    ...lessons.map((ref) => `- [${ref}] lesson ${ref}`),
    `## ${MEMORY_HEADING}`,
    ...memories.map((ref) => `- [${ref}] memory ${ref}`),
    `## ${DECISIONS_HEADING}`,
    ...decisions.map((ref) => `- ${ref} decision ${ref}`),
    "### In full (the 8 closest to this Brief)",
    ...decisions.map((ref) => `- ${ref} decision ${ref} — the whole text`),
    "## Proposed (not binding)",
    "- D-52 a proposal is never a hit",
  ].join("\n");
}

// A phase_prompt call and its answer, made by the orchestrator unless a lane is named.
function phasePrompt(id, { target, check, parentToolUseId, ...sections }) {
  const answer = { prompt: promptText(sections), subagent_type: target, model: "opus", artifact: "x.md", check, open_items: [], contract: 5 };
  return [toolUseEvent({ name: PHASE_PROMPT, id, input: { target }, parentToolUseId }), jsonResult(id, answer, { parentToolUseId })];
}

test("a phase_prompt is a context recall: hits from the three memory sections only, each ref once, phase from its check", async () => {
  const log = logOf([
    attemptMarker(1),
    ...phasePrompt("p1", { target: "architect", check: "03", lessons: ["L5"], memories: ["M9"], decisions: ["D-7", "ACME/D-3"] }),
    ...phasePrompt("p2", { target: "qa-analyst", check: "05a" }),
    ...phasePrompt("p3", { target: "runtime", check: "06.5" }),
  ]);
  const [architect, qa, runtime] = await jobRecalls(log);
  assert.deepEqual(
    [architect.tool, architect.kind, architect.target, architect.agent, architect.phase, architect.calls, architect.query],
    ["phase_prompt", "context", "architect", "architect", 3, 1, null],
  );
  assert.deepEqual(architect.hits, [
    { ref: "L5", title: "lesson L5", score: null, kind: "lesson" },
    { ref: "M9", title: "memory M9", score: null, kind: "memory" },
    { ref: "D-7", title: "decision D-7", score: null, kind: "decision" },
    { ref: "ACME/D-3", title: "decision ACME/D-3", score: null, kind: "decision" },
  ]);
  assert.deepEqual([qa.phase, runtime.phase], [5, 6]);
});

test("a context_for_phase recall reads its block and takes its phase and agent from its target, the caller only without one", async () => {
  const block = `## ${LESSONS_HEADING}\n- [L4] keep it small\n## Structural index\n- [L8] not a memory section`;
  const log = logOf([
    attemptMarker(1),
    agentToolUseEvent({ id: "lane1", subagentType: "nightqueue:coder" }),
    toolUseEvent({ name: CONTEXT, id: "c1", input: { target: "explore" }, parentToolUseId: "lane1" }),
    jsonResult("c1", { block }, { parentToolUseId: "lane1" }),
    toolUseEvent({ name: CONTEXT, id: "c2", input: {}, parentToolUseId: "lane1" }),
    jsonResult("c2", { block }, { parentToolUseId: "lane1" }),
  ]);
  const [context, untargeted] = await jobRecalls(log);
  assert.deepEqual([context.tool, context.phase, context.agent, context.target], ["context_for_phase", 2, "explore", "explore"]);
  assert.deepEqual(context.hits, [{ ref: "L4", title: "keep it small", score: null, kind: "lesson" }]);
  assert.deepEqual([untargeted.phase, untargeted.agent, untargeted.target], [null, "coder", null]);
});

test("a failed context call stays its own block, and a context call that hands over nothing is dropped", async () => {
  const log = logOf([
    attemptMarker(1),
    toolUseEvent({ name: CONTEXT, id: "c1", input: { target: "coder" } }),
    toolResultEvent({ toolUseId: "c1", content: "the store is locked", isError: true }),
    toolUseEvent({ name: CONTEXT, id: "c2", input: { target: "coder" } }),
    jsonResult("c2", { block: "" }),
    toolUseEvent({ name: CONTEXT, id: "c3", input: { target: "coder" } }),
  ]);
  const recalls = await jobRecalls(log);
  assert.deepEqual(
    recalls.map((recall) => [recall.id, recall.pending, recall.error]),
    [
      ["c1", false, "the store is locked"],
      ["c3", true, null],
    ],
  );
});

test("context calls of the same phase and agent merge into the first one, with the union of their hits and the call count", async () => {
  const log = logOf([
    attemptMarker(1, "2026-10-06T10:00:00Z"),
    toolUseEvent({ name: LESSON, id: "r1", input: { query: "first" } }),
    jsonResult("r1", []),
    ...phasePrompt("p1", { target: "architect", check: "03", lessons: ["L1"], decisions: ["D-7", "D-24"] }),
    ...phasePrompt("p2", { target: "coder", check: "04" }),
    attemptMarker(2, "2026-10-06T11:00:00Z"),
    ...phasePrompt("p3", { target: "architect", check: "03", lessons: ["L2"], decisions: ["D-24", "D-58"] }),
    ...phasePrompt("p4", { target: "architect", check: "03", lessons: ["L1"], decisions: ["D-57"] }),
  ]);
  const recalls = await jobRecalls(log);
  assert.deepEqual(
    recalls.map((recall) => [recall.id, recall.agent, recall.phase, recall.calls ?? null, recall.attempt]),
    [
      ["r1", "orchestrator", null, null, 1],
      ["p1", "architect", 3, 3, 1],
      ["p2", "coder", 4, 1, 1],
    ],
  );
  assert.deepEqual(
    recalls[1].hits.map((hit) => hit.ref),
    ["L1", "M9", "D-7", "D-24", "L2", "D-58", "D-57"],
  );
});

test("context calls of another agent or another phase stay apart, and memory recalls never merge", async () => {
  const log = logOf([
    attemptMarker(1),
    ...phasePrompt("p1", { target: "qa-guardian", check: "05" }),
    agentToolUseEvent({ id: "lane1", subagentType: "nightqueue:qa-guardian" }),
    ...phasePrompt("p2", { target: "qa-analyst", check: "05a", parentToolUseId: "lane1" }),
    ...phasePrompt("p3", { target: "qa-guardian", check: "06" }),
    toolUseEvent({ name: DECISION, id: "d1", input: { query: "a" } }),
    jsonResult("d1", [{ ref: "D-7", title: "t" }]),
    toolUseEvent({ name: DECISION, id: "d2", input: { query: "a" } }),
    jsonResult("d2", [{ ref: "D-7", title: "t" }]),
  ]);
  const recalls = await jobRecalls(log);
  assert.deepEqual(
    recalls.map((recall) => [recall.id, recall.agent, recall.phase]),
    [
      ["p1", "qa-guardian", 5],
      ["p2", "qa-analyst", 5],
      ["p3", "qa-guardian", 6],
      ["d1", "orchestrator", null],
      ["d2", "orchestrator", null],
    ],
  );
});

test("the decisions heading a context call is read by is the one the runtime writes", () => {
  assert.equal(DECISIONS_HEADING, STANDING_HEADING);
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
  const recalls = await jobRecalls(log);
  clearInterval(timer);
  assert.equal(recalls.length, copies);
  assert.ok(worstGap < 150, `the event loop stalled ${Math.round(worstGap)} ms while the log was scanned`);
});
