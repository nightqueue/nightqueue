import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CHIPS, foldRows, foldStream, formatBytes, groupLanes, looksLikeMarkdown, rowVisible } from "../../studio/src/lib/log-tree.ts";

const FOLD_BUDGET_MS = 200;

// One narration event as the studio wire carries it, with the given fields over the defaults.
function wire(kind, text, fields = {}) {
  return { kind, glyph: "·", clock: "00:01", text, indent: false, lane: null, dim: "", elapsedMs: null, laneId: null, phase: null, agent: null, model: null, body: null, body_truncated: false, body_offset: null, at: null, artifact: null, title: null, bytes: null, ...fields };
}

// The `attempt` event that opens attempt `number`.
function attempt(number) {
  return wire("attempt", `attempt ${number}`, { glyph: "═" });
}

// The `phase` event the narrator emits when a phase opens.
function phase(number, agent = "orchestrator", model = null, at = null) {
  return wire("phase", `phase ${number}`, { phase: number, agent, model, at });
}

// The `laneOpen` event of a lane.
function laneOpen(laneId, agent = "coder") {
  return wire("laneOpen", `${agent} — work`, { laneId, agent });
}

// One tool line inside a lane.
function laneTool(laneId, text = "Read src/a.mjs", fields = {}) {
  return wire("tool", text, { indent: true, laneId, tool: "Read", ...fields });
}

// The notice line the narrator writes for a gate's question.
function notice(text) {
  return wire("notice", `notice\n${text.split("\n").map((line) => `    ${line}`).join("\n")}`);
}

// One attempts_log row, finished unless told otherwise.
function attemptRow(number, fields = {}) {
  return { attempt: number, worker: "host:1", session_id: null, started_at: `2026-09-07T2${number}:00:00.500Z`, finished_at: `2026-09-07T2${number}:30:00.000Z`, duration_s: 100, outcome: "done", exit_reason: null, spawns: 1, tokens_in: 1000, tokens_out: 500, cache_read: 3000, cache_creation: 0, cost_usd: 0.12, fresh: false, backfilled: false, ...fields };
}

// The fold's context with the given fields over a running job's defaults.
function context(fields = {}) {
  return { ended: false, attempts: [], status: "running", notice: null, operatorNote: null, phaseNames: new Map(), ...fields };
}

// The texts of a fold's rows, in order.
function texts(stream) {
  return stream.rows.map((row) => row.event.text);
}

test("every attempt lands in one flat stream: its start line, its phase lines and its lane lines in order", () => {
  const events = [attempt(1), phase(0), wire("text", "Starting."), phase(1), phase(3, "architect", "opus"), laneOpen("a", "architect"), laneTool("a"), laneOpen("a", "architect"), attempt(2), phase(0), wire("text", "Again.")];
  const stream = foldStream(events, context({ attempts: [attemptRow(1, { outcome: "failed" }), attemptRow(2, { finished_at: null, outcome: null })] }));
  assert.deepEqual(texts(stream), [
    "attempt 1 @ 2026-09-07T21:00:00Z",
    "Starting.",
    "phase 3 architect · opus",
    "architect — work",
    "Read src/a.mjs",
    "attempt 1 ended at failed · 1m40s · 4.5k tok · $0.12",
    "attempt 2 @ 2026-09-07T22:00:00Z",
    "Again.",
  ]);
  assert.deepEqual(
    stream.rows.map((row) => row.lane),
    [false, false, false, false, true, false, false, false],
  );
  assert.equal(stream.rows[2].event.glyph, "─");
  assert.deepEqual([stream.attemptCount, stream.lastEventKey], [2, "e10"]);
});

test("a later attempt reads where it resumed, and an attempt with no history row starts at its first phase", () => {
  const events = [attempt(1), phase(0, "orchestrator", null, "2026-09-07T20:00:01.000Z"), phase(1), wire("text", "a"), attempt(2), phase(0), phase(4, "coder"), wire("text", "b")];
  assert.deepEqual(texts(foldStream(events, context())).filter((text) => text.startsWith("attempt")), ["attempt 1 @ 2026-09-07T20:00:01Z", "attempt 1 ended", "attempt 2 · resumed at phase 4"]);
});

test("bodies sit on their lines: an answer, a tool error, a report and a hand-back; a text equal to its body has none", () => {
  const events = [
    attempt(1),
    wire("text", "Plan ready.", { body: "Plan ready.\n\n- step one" }),
    wire("text", "Short.", { body: "Short." }),
    wire("toolError", "Bash failed: boom", { tool: "Bash", body: "boom\nat line 2" }),
    wire("report", "report 03-plan.md", { artifact: "03-plan.md", title: "The plan", bytes: 2355 }),
    laneOpen("a"),
    wire("laneClose", "coder completed", { laneId: "a", body: "## Done" }),
    wire("resultEnd", "J-1 done"),
  ];
  const stream = foldStream(events, context());
  assert.deepEqual(
    stream.rows.slice(1).map((row) => [row.event.text, row.body]),
    [
      ["Plan ready.", "answer"],
      ["Short.", null],
      ["Bash failed: boom", "toolError"],
      ["03-plan.md — The plan", "report"],
      ["coder — work", null],
      ["coder completed", "handBack"],
    ],
  );
  assert.equal(stream.rows[4].event.glyph, "▣");
});

test("an earlier gate shows the narrated question and its close line; a job still at its gate shows the row's whole notice and no answer", () => {
  const events = [attempt(1), wire("gate", "gate: the pipeline is waiting"), notice("Which way?\nleft or right"), attempt(2), wire("text", "Going."), wire("gate", "gate: again"), notice("clipped question")];
  const attempts = [attemptRow(1, { outcome: "gate" }), attemptRow(2, { outcome: "gate" })];
  const stream = foldStream(events, context({ ended: true, status: "gate", attempts, notice: "## Second question\nthe whole of it", operatorNote: "go left" }));
  assert.deepEqual(texts(stream), [
    "attempt 1 @ 2026-09-07T21:00:00Z",
    "gate — Which way?",
    "attempt 1 ended at gate · 1m40s · 4.5k tok · $0.12",
    "operator answered — go left",
    "attempt 2 @ 2026-09-07T22:00:00Z",
    "Going.",
    "gate — Second question",
    "attempt 2 ended at gate · 1m40s · 4.5k tok · $0.12",
  ]);
  assert.deepEqual([stream.rows[1].body, stream.rows[1].event.body], ["gate", "Which way?\nleft or right"]);
  assert.equal(stream.rows[6].event.body, "## Second question\nthe whole of it");
  assert.deepEqual([stream.rows[1].key, stream.rows[2].key, stream.rows[3].key], ["a1-gate", "a1-end", "a1-answer"]);
  assert.equal(stream.rows[3].event.clock, "—");
});

test("with two answered gates only the latest carries the note; the earlier reads answer not kept, dimmed", () => {
  const events = [attempt(1), notice("q1"), attempt(2), notice("q2"), attempt(3), wire("text", "Working.")];
  const attempts = [attemptRow(1, { outcome: "gate" }), attemptRow(2, { outcome: "gate" }), attemptRow(3, { finished_at: null, outcome: null })];
  const stream = foldStream(events, context({ attempts, operatorNote: "the second answer" }));
  const answers = stream.rows.filter((row) => row.event.kind === "operator");
  assert.deepEqual(
    answers.map((row) => [row.key, row.event.text, row.dim === true, row.event.dim]),
    [
      ["a1-answer", "operator answered (answer not kept)", true, " (answer not kept)"],
      ["a2-answer", "operator answered — the second answer", false, ""],
    ],
  );
});

test("a pending job answered after its last gate shows the note under that gate, a multi-line note as its body", () => {
  const events = [attempt(1), notice("q1")];
  const stream = foldStream(events, context({ ended: true, status: "pending", attempts: [attemptRow(1, { outcome: "gate" })], operatorNote: "line one\nline two" }));
  const answer = stream.rows.at(-1);
  assert.deepEqual([answer.event.text, answer.body, answer.event.body], ["operator answered — line one", "answer", "line one\nline two"]);
});

test("the final report is the last orchestrator answer once the stream ended, and keys stay put as events append", () => {
  const events = [attempt(1), wire("text", "First.", { body: "First.\nmore" }), laneOpen("a"), wire("text", "lane says", { indent: true, laneId: "a", body: "lane says\nmore" }), wire("text", "Final.", { body: "## Final\n| a | b |" })];
  assert.equal(foldStream(events, context()).finalKey, null);
  const ended = foldStream(events, context({ ended: true, status: "done", attempts: [attemptRow(1)] }));
  assert.equal(ended.finalKey, "e4");
  const final = ended.rows.find((row) => row.final);
  assert.deepEqual([final.event.text, final.body], ["Final.", "answer"]);
  const before = foldStream(events.slice(0, 3), context()).rows.map((row) => row.key);
  assert.deepEqual(foldStream(events, context()).rows.slice(0, before.length).map((row) => row.key), before);
});

test("a capped stream with no attempt line before its first marker closes the attempt that marker follows", () => {
  const events = [wire("truncated", "log over 8 MB"), wire("text", "tail of attempt 1"), attempt(2), wire("text", "b")];
  const stream = foldStream(events, context({ attempts: [attemptRow(1, { outcome: "failed" }), attemptRow(2, { finished_at: null, outcome: null })] }));
  assert.deepEqual(texts(stream).slice(0, 3), ["log over 8 MB", "tail of attempt 1", "attempt 1 ended at failed · 1m40s · 4.5k tok · $0.12"]);
});

// A run of plain tool lines of one lane, as the fold makes them.
function toolRows(count, laneId = "a") {
  return Array.from({ length: count }, (_, index) => ({ type: "line", key: `${laneId}${index}`, event: laneTool(laneId, `tool ${index}`), lane: true, body: null, final: false }));
}

test("a long run of one lane's tools keeps its first 3 and last 2 lines around a count, unless every tool shows", () => {
  const folded = foldRows(toolRows(10), { allTools: false });
  assert.deepEqual(
    folded.map((item) => (item.type === "more" ? `more ${item.count}` : item.event.text)),
    ["tool 0", "tool 1", "tool 2", "more 5", "tool 8", "tool 9"],
  );
  assert.equal(foldRows(toolRows(6), { allTools: false }).length, 6, "a single hidden tool is never folded");
  assert.equal(foldRows(toolRows(10), { allTools: true }).length, 10);
  assert.equal(foldRows([...toolRows(4, "a"), ...toolRows(4, "b")], { allTools: false }).length, 8, "runs of two lanes never fold together");
});

// The shape of a grouped list: a lane block as `lane <id>: <row texts>`, a flat line as its text.
function shapes(items) {
  return items.map((item) => (item.type === "lane" ? `lane ${item.laneId}: ${item.rows.map((row) => row.event.text).join(", ")}` : item.event.text));
}

test("each seen lane gathers its rows at its laneOpen; interleaved lanes split and main-lane rows keep their order around them", () => {
  const events = [attempt(1), wire("text", "Starting."), laneOpen("a", "coder"), laneOpen("b", "verifier"), laneTool("a", "a1"), laneTool("b", "b1"), wire("text", "orchestrator waits"), laneTool("a", "a2"), wire("laneClose", "coder completed", { laneId: "a", body: "## Done" }), wire("text", "Final.", { body: "## Final\n- a\n- b" })];
  const stream = foldStream(events, context({ ended: true, status: "done", attempts: [attemptRow(1)] }));
  const grouped = groupLanes(stream.rows, { ended: false });
  assert.deepEqual(shapes(grouped), ["attempt 1 @ 2026-09-07T21:00:00Z", "Starting.", "lane a: a1, a2, coder completed", "lane b: b1", "orchestrator waits", "Final.", "attempt 1 done · 1m40s · 4.5k tok · $0.12"]);
  const [laneA, laneB] = grouped.filter((item) => item.type === "lane");
  assert.deepEqual([laneA.key, laneA.head.event.text, laneA.ended, laneA.latest.event.text, laneA.tools], ["lane-a", "coder — work", true, "a2", 2]);
  assert.deepEqual([laneB.ended, laneB.latest.event.text, laneB.tools], [false, "b1", 1]);
  assert.equal(grouped.find((item) => item.type === "line" && item.final)?.key, stream.finalKey);
});

test("lane rows with no laneId or an unseen laneOpen stay flat, an orphan ends its lane and the stream's end ends every lane", () => {
  const rows = (events) => events.map((event, index) => ({ type: "line", key: `e${index}`, event, lane: event.indent, body: null, final: false }));
  const cut = groupLanes(rows([laneTool("x", "tail of x"), laneTool(null, "no lane"), laneOpen("y"), wire("laneOrphan", "coder lost", { laneId: "y" })]), { ended: false });
  assert.deepEqual(shapes(cut), ["tail of x", "no lane", "lane y: coder lost"]);
  assert.deepEqual([cut[2].ended, cut[2].latest], [true, null]);
  const ended = groupLanes(rows([laneOpen("z"), laneTool("z", "z1")]), { ended: true });
  assert.equal(ended[0].ended, true);
});

test("the tool fold passes lane blocks through whole and never folds their rows", () => {
  const block = groupLanes([{ type: "line", key: "open", event: laneOpen("a"), lane: false, body: null, final: false }, ...toolRows(10, "a")], { ended: false });
  const folded = foldRows([...toolRows(10, "b"), ...block], { allTools: false });
  assert.deepEqual(folded.map((item) => item.type), ["line", "line", "line", "more", "line", "line", "lane"]);
  assert.equal(folded.at(-1).rows.length, 10);
});

test("a text reads as markdown with 3 or more lines led by a heading, a bullet or a pipe", () => {
  assert.equal(looksLikeMarkdown("# Title\n- one\n  | a | b |"), true);
  assert.equal(looksLikeMarkdown("Error: boom\n- one\nat line 3"), false);
});

test("the chips show the narrated lines and lanes by default, and always show composed, report and tool-error lines", () => {
  const row = (event) => ({ type: "line", key: "e0", event, lane: event.indent, body: null, final: false });
  assert.equal(rowVisible(row(wire("text", "hello")), DEFAULT_CHIPS), true);
  assert.equal(rowVisible(row(wire("tool", "Bash git status", { tool: "Bash" })), DEFAULT_CHIPS), false);
  assert.equal(rowVisible(row(wire("tool", "lesson_recall worker", { tool: "lesson_recall" })), DEFAULT_CHIPS), true);
  assert.equal(rowVisible(row(wire("tool", "Bash nightqueue run check 03", { tool: "Bash" })), DEFAULT_CHIPS), true);
  const hidden = { narrated: false, orchestrator: false, lanes: false, allTools: false };
  for (const kind of ["report", "toolError", "attempt", "attemptEnd", "gateQuestion", "operator", "phase"]) assert.equal(rowVisible(row(wire(kind, kind)), hidden), true, kind);
  assert.equal(rowVisible(row(laneTool("a")), hidden), false);
});

test("a byte count reads as a short size", () => {
  assert.deepEqual([formatBytes(812), formatBytes(2355), formatBytes(1153434), formatBytes(null)], ["812 B", "2.3 KB", "1.1 MB", "-"]);
});

// Twenty thousand events across phases and lanes, the size of a long real attempt.
function largeStream() {
  const events = [attempt(1)];
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
  const stream = foldStream(events, context({ ended: true, status: "done", attempts: [attemptRow(1)] }));
  const visible = foldRows(stream.rows.filter((row) => rowVisible(row, DEFAULT_CHIPS)), { allTools: false });
  const spent = performance.now() - started;
  assert.ok(visible.length < stream.rows.length);
  assert.ok(spent < FOLD_BUDGET_MS, `the fold took ${spent.toFixed(1)} ms`);
});
