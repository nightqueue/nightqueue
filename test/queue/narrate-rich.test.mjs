import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createNarrator, formatNarration, handBackText, narrateLog } from "../../src/queue/narrate.mjs";
import {
  agentToolUseEvent,
  assistantEvent,
  attemptMarker,
  doneStream,
  failureStream,
  gateStream,
  intermediateDeliveryStream,
  LANE_TOOL_USE_ID,
  narrationStream,
  secondsIntoAttempt,
  systemInitEvent,
  taskNotificationEvent,
  toNdjson,
  toolResultEvent,
  toolUseEvent,
} from "../../test-support/streams.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const RICH_ONLY_KINDS = new Set(["phase", "report"]);
const BODY_CAP = 32768;

// A reader that knows every artifact, the stand-in of the run directory the studio injects.
function knownArtifact(name) {
  return { bytes: 2355, title: `title of ${name}` };
}

// The narration of a log in the studio's rich shape.
function richLog(text, options = {}) {
  return narrateLog(text, { rich: true, readArtifact: knownArtifact, ...options });
}

// One attempt log built from the given events.
function attemptLog(events) {
  return `${attemptMarker(1)}\n${toNdjson(events)}`;
}

// Every `.jsonl` fixture of the queue tests, the real logs the CLI narration is pinned to.
function fixtureLogs() {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl")) found.push(readFileSync(path, "utf8"));
    }
  };
  walk(FIXTURES);
  return found;
}

// The logs the byte-identity check runs over: every fixture plus the inline streams of the narration tests.
function identityCorpus() {
  return [...fixtureLogs(), narrationStream(), doneStream(), gateStream(), failureStream(), intermediateDeliveryStream(), phasedLog()];
}

// A run through the pipeline: triage, two parallel coders, a verifier, a coder again, then publish and report.
function phasedLog() {
  const at = (seconds) => secondsIntoAttempt(seconds);
  return attemptLog([
    systemInitEvent(),
    assistantEvent("Starting the run.", { timestamp: at(1) }),
    toolUseEvent({ name: "Bash", id: "toolu_start", input: { command: "nightqueue run start --json" }, timestamp: at(2) }),
    agentToolUseEvent({ id: "toolu_tri", subagentType: "nightqueue:triager", timestamp: at(3) }),
    taskNotificationEvent({ toolUseId: "toolu_tri" }),
    agentToolUseEvent({ id: "toolu_c1", subagentType: "nightqueue:coder", model: "opus", timestamp: at(10) }),
    agentToolUseEvent({ id: "toolu_c2", subagentType: "nightqueue:coder", model: "opus", timestamp: at(11) }),
    taskNotificationEvent({ toolUseId: "toolu_c1" }),
    taskNotificationEvent({ toolUseId: "toolu_c2" }),
    agentToolUseEvent({ id: "toolu_ver", subagentType: "nightqueue:verifier", timestamp: at(20) }),
    taskNotificationEvent({ toolUseId: "toolu_ver" }),
    agentToolUseEvent({ id: "toolu_c3", subagentType: "nightqueue:coder", timestamp: at(30) }),
    taskNotificationEvent({ toolUseId: "toolu_c3" }),
    toolUseEvent({ name: "Bash", id: "toolu_pub", input: { command: "nightqueue run publish --message-file m.txt" }, timestamp: at(40) }),
    toolUseEvent({ name: "Bash", id: "toolu_rep", input: { command: "nightqueue run report --json" }, timestamp: at(41) }),
  ]);
}

// The CLI lines of a narration, the bytes `queue log` prints.
function printed(events, color) {
  return events.map((event) => formatNarration(event, { color })).join("\n");
}

test("the rich narration prints byte-identical CLI lines once its own phase and report events are left out", () => {
  for (const text of identityCorpus()) {
    const rich = richLog(text).filter((event) => !RICH_ONLY_KINDS.has(event.kind));
    for (const color of [false, true]) assert.equal(printed(rich, color), printed(narrateLog(text), color));
  }
});

test("the CLI narration carries no rich kind and no body, and no lane child carries a lane id", () => {
  for (const text of identityCorpus()) {
    for (const event of narrateLog(text)) {
      assert.equal(RICH_ONLY_KINDS.has(event.kind), false, `rich kind ${event.kind} leaked into the CLI shape`);
      assert.equal("body" in event, false, `a ${event.kind} event carries a body`);
      if (event.indent) assert.equal("laneId" in event, false, `a lane child ${event.kind} carries a lane id`);
    }
  }
});

test("an orchestrator and a lane text carry their whole text as the body, the lane child with its lane id", () => {
  const events = richLog(
    attemptLog([
      assistantEvent("Plan ready.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n"),
      agentToolUseEvent({ subagentType: "nightqueue:coder" }),
      assistantEvent("Editing now.\nSecond line.", { parentToolUseId: LANE_TOOL_USE_ID }),
    ]),
  );
  const [orchestrator, inLane] = events.filter((event) => event.kind === "text");
  assert.deepEqual([orchestrator.text, orchestrator.body, orchestrator.body_truncated, orchestrator.body_offset], ["Plan ready.", "Plan ready.\n\n| a | b |\n|---|---|\n| 1 | 2 |", false, null]);
  assert.deepEqual([inLane.body, inLane.laneId], ["Editing now.\nSecond line.", LANE_TOOL_USE_ID]);
});

test("a tool error carries the last 40 lines of its output as the body", () => {
  const output = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n");
  const events = richLog(attemptLog([toolUseEvent({ id: "toolu_fail", input: { command: "npm test" } }), toolResultEvent({ toolUseId: "toolu_fail", content: `${output}\n\n`, isError: true })]));
  const failure = events.find((event) => event.kind === "toolError");
  const lines = failure.body.split("\n");
  assert.deepEqual([lines.length, lines[0], lines.at(-1)], [40, "line 21", "line 60"]);
  assert.equal(failure.text, "Bash failed: line 1");
});

// The text a Task tool_result carries in the measured shape: the harness frame, an indented report, the agent id and the usage.
function framedHandBack(report) {
  const indented = report
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
  return `[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n${indented}\nagentId: a1b2c3 (use SendMessage with to: 'a1b2c3' to continue this agent)\n<usage>total_tokens: 900\ntool_uses: 2</usage>`;
}

test("handBackText unframes a Task tool_result: frame, indent, agent id line and usage removed", () => {
  assert.equal(handBackText(framedHandBack("## Done\n\n- item one\n  - nested")), "## Done\n\n- item one\n  - nested");
  assert.equal(handBackText("plain report"), "plain report");
  assert.equal(handBackText(null), "");
});

test("a lane close carries the notification summary, else the hand-back its tool_result brought earlier, else a null body", () => {
  const fromSummary = richLog(attemptLog([agentToolUseEvent(), taskNotificationEvent({ summary: "## Triage\nall good" })]));
  assert.equal(fromSummary.find((event) => event.kind === "laneClose").body, "## Triage\nall good");
  const fromResult = richLog(attemptLog([agentToolUseEvent(), toolResultEvent({ toolUseId: LANE_TOOL_USE_ID, content: framedHandBack("## Triage\nfrom the result") }), taskNotificationEvent({ summary: "" })]));
  assert.equal(fromResult.find((event) => event.kind === "laneClose").body, "## Triage\nfrom the result");
  const none = richLog(attemptLog([agentToolUseEvent(), taskNotificationEvent({ summary: null })]));
  const closed = none.find((event) => event.kind === "laneClose");
  assert.deepEqual([closed.body, closed.body_truncated, closed.laneId], [null, false, LANE_TOOL_USE_ID]);
});

test("a body above 32 KiB is cut on a code point boundary and points at the byte offset of its line", () => {
  const narrator = createNarrator({ rich: true });
  narrator.push(attemptMarker(1), { offset: 0 });
  const line = JSON.stringify(assistantEvent(`${"a".repeat(BODY_CAP - 1)}😀 tail`));
  const text = narrator.push(line, { offset: 1234 }).find((event) => event.kind === "text");
  assert.equal(text.body_truncated, true);
  assert.equal(text.body_offset, 1234);
  assert.ok(Buffer.byteLength(text.body) <= BODY_CAP);
  assert.equal(text.body, "a".repeat(BODY_CAP - 1));
  assert.equal(text.body.includes("�"), false);
});

test("phase events come before the event that opens them, once per phase, in pipeline order", () => {
  const events = richLog(phasedLog());
  const phases = events.filter((event) => event.kind === "phase");
  assert.deepEqual(
    phases.map((event) => event.phase),
    [0, 1, 4, 6, 4, 8],
  );
  assert.deepEqual([events[0].kind, events[1].kind, events[1].phase], ["attempt", "phase", 0]);
  const coder = phases.find((event) => event.phase === 4);
  assert.deepEqual([coder.agent, coder.model, coder.text, coder.at], ["coder", "opus", "phase 4", secondsIntoAttempt(10)]);
  assert.equal(phases.find((event) => event.phase === 8).agent, "orchestrator");
  const coderIndex = events.indexOf(coder);
  assert.deepEqual([events[coderIndex + 1].kind, events[coderIndex + 1].laneId], ["laneOpen", "toolu_c1"]);
});

test("a log without an attempt line still opens phase 0 before its first event", () => {
  const events = richLog(toNdjson([assistantEvent("hello")]));
  assert.deepEqual(
    events.map((event) => [event.kind, event.phase ?? null]),
    [
      ["phase", 0],
      ["text", null],
    ],
  );
});

// One orchestrator phase that checks and declares its artifact, then a verifier and the coder again.
function reportLog() {
  return attemptLog([
    toolUseEvent({ name: "Bash", id: "toolu_chk", input: { command: "nightqueue run check 03" } }),
    toolUseEvent({ name: "mcp__nightqueue__run_phase_done", id: "toolu_done", input: { phase: 3, artifact: "03-plan.md" } }),
    agentToolUseEvent({ id: "toolu_c1", subagentType: "nightqueue:coder" }),
    toolUseEvent({ name: "Bash", id: "toolu_c1chk", input: { command: "nightqueue run check 04" }, parentToolUseId: "toolu_c1" }),
    taskNotificationEvent({ toolUseId: "toolu_c1" }),
    agentToolUseEvent({ id: "toolu_v", subagentType: "nightqueue:verifier" }),
    taskNotificationEvent({ toolUseId: "toolu_v" }),
    agentToolUseEvent({ id: "toolu_c2", subagentType: "nightqueue:coder" }),
    toolUseEvent({ name: "Bash", id: "toolu_c2chk", input: { command: "nightqueue run check 04" }, parentToolUseId: "toolu_c2" }),
    toolUseEvent({ name: "mcp__nightqueue__run_phase_done", id: "toolu_c2done", input: { phase: 4, artifact: "04-implementation.md" }, parentToolUseId: "toolu_c2" }),
    taskNotificationEvent({ toolUseId: "toolu_c2" }),
  ]);
}

test("a report is emitted after its tool line, once per artifact per phase segment, with the title and size the reader answers", () => {
  const events = richLog(reportLog());
  const reports = events.filter((event) => event.kind === "report");
  assert.deepEqual(
    reports.map((event) => event.artifact),
    ["03-plan.md", "04-implementation.md", "04-implementation.md"],
  );
  assert.deepEqual([reports[0].title, reports[0].bytes, reports[0].text], ["title of 03-plan.md", 2355, "report 03-plan.md"]);
  assert.equal(events[events.indexOf(reports[0]) - 1].tool, "Bash");
  assert.deepEqual([reports[1].indent, reports[1].laneId], [true, "toolu_c1"]);
});

test("no report is emitted when the reader answers nothing or throws, nor without a reader", () => {
  assert.equal(richLog(reportLog(), { readArtifact: () => null }).some((event) => event.kind === "report"), false);
  const throwing = () => {
    throw new Error("unreadable");
  };
  assert.equal(richLog(reportLog(), { readArtifact: throwing }).some((event) => event.kind === "report"), false);
  assert.equal(narrateLog(reportLog(), { rich: true }).some((event) => event.kind === "report"), false);
});

test("a report the reader could not find yet is emitted once a later check finds the file", () => {
  let written = false;
  const reader = (name) => (written ? knownArtifact(name) : null);
  const narrator = createNarrator({ rich: true, readArtifact: reader });
  narrator.push(attemptMarker(1));
  const check = JSON.stringify(toolUseEvent({ name: "Bash", input: { command: "nightqueue run check 03" } }));
  assert.equal(narrator.push(check).some((event) => event.kind === "report"), false);
  written = true;
  assert.equal(narrator.push(check).filter((event) => event.kind === "report").length, 1);
  assert.equal(narrator.push(check).some((event) => event.kind === "report"), false);
});

test("a sizeless reader answer emits a pending report on every signal, leaving the dedup to the reader's owner", () => {
  const narrator = createNarrator({ rich: true, readArtifact: () => ({ title: null, bytes: null }) });
  narrator.push(attemptMarker(1));
  const check = JSON.stringify(toolUseEvent({ name: "Bash", input: { command: "nightqueue run check 03" } }));
  const pending = [...narrator.push(check), ...narrator.push(check)].filter((event) => event.kind === "report");
  assert.deepEqual(
    pending.map((event) => [event.artifact, event.bytes]),
    [
      ["03-plan.md", null],
      ["03-plan.md", null],
    ],
  );
});
