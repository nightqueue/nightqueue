import assert from "node:assert/strict";
import { test } from "node:test";
import { chipVisible, DEFAULT_CHIPS, foldLog, foldTools, formatBytes, looksLikeMarkdown } from "../../studio/src/lib/log-tree.ts";

const FOLD_BUDGET_MS = 200;

// One narration event as the studio wire carries it, with the given fields over the defaults.
function wire(kind, text, fields = {}) {
  return { kind, text, indent: false, lane: null, dim: "", elapsedMs: null, laneId: null, body: null, body_truncated: false, body_offset: null, ...fields };
}

// The `phase` event the narrator emits when a phase opens.
function phase(number, agent = "orchestrator", model = null) {
  return wire("phase", `phase ${number}`, { phase: number, agent, model });
}

// The `laneOpen` event of a lane.
function laneOpen(laneId, agent = "coder") {
  return wire("laneOpen", `${agent} — work`, { laneId, agent });
}

// One tool line inside a lane.
function laneTool(laneId, text = "Read src/a.mjs", fields = {}) {
  return wire("tool", text, { indent: true, laneId, tool: "Read", ...fields });
}

test("phases are grouped by number in first-seen order, and the last one entered is current", () => {
  const tree = foldLog([phase(4, "coder", "opus"), laneOpen("a"), phase(6, "verifier"), laneOpen("b", "verifier"), phase(4, "coder"), laneOpen("c")], { ended: false });
  assert.deepEqual(
    tree.phases.map((node) => [node.key, node.number, node.lanes]),
    [
      ["p4", 4, 2],
      ["p6", 6, 1],
    ],
  );
  assert.deepEqual([tree.currentKey, tree.phases[0].agent, tree.phases[0].model], ["p4", "coder", "opus"]);
});

test("events before any phase land in an implicit phase 0, and a repeated lane open is ignored", () => {
  const tree = foldLog([wire("attempt", "attempt 1"), laneOpen("a"), laneOpen("a")], { ended: false });
  assert.deepEqual(
    tree.phases.map((node) => [node.number, node.items.length, node.lanes]),
    [[0, 2, 1]],
  );
});

test("a lane child lands in its lane by lane id even after a newer phase opened, and counts its tools and edits", () => {
  const tree = foldLog([phase(4, "coder"), laneOpen("a"), phase(6, "verifier"), laneTool("a"), laneTool("a", "Edit worker.mjs", { tool: "Edit", file: "worker.mjs" })], { ended: false });
  const [coder, verifier] = tree.phases;
  const lane = coder.items[0];
  assert.equal(lane.type, "lane");
  assert.deepEqual(
    lane.children.map((child) => child.event.text),
    ["Read src/a.mjs", "Edit worker.mjs"],
  );
  assert.deepEqual([lane.tools, lane.edits, coder.tools, verifier.items.length], [2, 1, 2, 0]);
  assert.equal(tree.lastEventKey, "e4");
});

test("an answer, a tool error, a hand-back and a report become blocks under their line", () => {
  const events = [
    phase(3, "architect"),
    wire("text", "Plan ready.", { body: "Plan ready.\n\n- step one" }),
    wire("text", "Short.", { body: "Short." }),
    wire("toolError", "Bash failed: boom", { tool: "Bash", body: "boom\nat line 2" }),
    wire("report", "report 03-plan.md", { artifact: "03-plan.md", title: "The plan", bytes: 2355 }),
    laneOpen("a"),
    wire("laneClose", "coder completed", { laneId: "a", body: "## Done" }),
  ];
  const [architect] = foldLog(events, { ended: false }).phases;
  const shape = architect.items.map((item) => (item.type === "lane" ? ["lane", item.children.map((child) => child.kind ?? child.type)] : [item.type, item.kind ?? item.event.kind]));
  assert.deepEqual(shape, [
    ["line", "text"],
    ["block", "answer"],
    ["line", "text"],
    ["line", "toolError"],
    ["block", "toolError"],
    ["block", "report"],
    ["lane", ["line", "handBack"]],
  ]);
  assert.equal(architect.report, "03-plan.md");
  assert.equal(architect.items[6].close.text, "coder completed");
});

test("the final report is the last orchestrator answer, and only once the stream ended", () => {
  const events = [phase(0), wire("text", "First.", { body: "First.\nmore" }), laneOpen("a"), wire("text", "lane says", { indent: true, laneId: "a", body: "lane says\nmore" }), wire("text", "Final.", { body: "## Final\n| a | b |" })];
  assert.equal(foldLog(events, { ended: false }).finalReport, null);
  const final = foldLog(events, { ended: true }).finalReport;
  assert.deepEqual([final.key, final.event.text], ["e4", "Final."]);
});

// A run of plain tool lines of one lane, as the tree folds them.
function toolRun(count) {
  return Array.from({ length: count }, (_, index) => ({ type: "line", key: `e${index}`, event: laneTool("a", `tool ${index}`) }));
}

test("a long run of tools keeps its first 3 and last 2 lines around a count, unless every tool shows", () => {
  const folded = foldTools(toolRun(10), { allTools: false });
  assert.deepEqual(
    folded.map((item) => (item.type === "more" ? `more ${item.count}` : item.event.text)),
    ["tool 0", "tool 1", "tool 2", "more 5", "tool 8", "tool 9"],
  );
  assert.equal(foldTools(toolRun(6), { allTools: false }).length, 6, "a single hidden tool is never folded");
  assert.equal(foldTools(toolRun(10), { allTools: true }).length, 10);
});

test("a text reads as markdown with 3 or more lines led by a heading, a bullet or a pipe", () => {
  assert.equal(looksLikeMarkdown("# Title\n- one\n  | a | b |"), true);
  assert.equal(looksLikeMarkdown("Error: boom\n- one\nat line 3"), false);
});

test("the chips show the narrated lines and lanes by default, and always show reports and tool errors", () => {
  const line = (event) => ({ type: "line", key: "e0", event });
  assert.equal(chipVisible(line(wire("text", "hello")), DEFAULT_CHIPS), true);
  assert.equal(chipVisible(line(wire("tool", "Bash git status", { tool: "Bash" })), DEFAULT_CHIPS), false);
  assert.equal(chipVisible(line(wire("tool", "lesson_recall worker", { tool: "lesson_recall" })), DEFAULT_CHIPS), true);
  assert.equal(chipVisible(line(wire("tool", "Bash nightqueue run check 03", { tool: "Bash" })), DEFAULT_CHIPS), true);
  const hidden = { narrated: false, orchestrator: false, lanes: false, allTools: false };
  assert.equal(chipVisible({ type: "block", key: "e1", kind: "report", event: wire("report", "report x.md") }, hidden), true);
  assert.equal(chipVisible(line(wire("toolError", "Bash failed")), hidden), true);
  assert.equal(chipVisible({ type: "lane", key: "e2" }, hidden), false);
});

test("a byte count reads as a short size", () => {
  assert.deepEqual([formatBytes(812), formatBytes(2355), formatBytes(1153434), formatBytes(null)], ["812 B", "2.3 KB", "1.1 MB", "-"]);
});

// Twenty thousand events across phases and lanes, the size of a long real attempt.
function largeStream() {
  const events = [];
  for (let index = 0; events.length < 20000; index += 1) {
    const laneId = `lane${index}`;
    events.push(phase(index % 7), laneOpen(laneId));
    for (let step = 0; step < 48; step += 1) events.push(laneTool(laneId, `tool ${step}`));
    events.push(wire("laneClose", "coder completed", { laneId, body: "done" }));
  }
  return events;
}

test("folding twenty thousand events stays well inside a render frame budget", () => {
  const events = largeStream();
  const started = performance.now();
  const tree = foldLog(events, { ended: true });
  const spent = performance.now() - started;
  assert.equal(tree.phases.length, 7);
  assert.ok(spent < FOLD_BUDGET_MS, `the fold took ${spent.toFixed(1)} ms`);
});
