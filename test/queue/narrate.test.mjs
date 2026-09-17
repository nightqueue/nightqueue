import assert from "node:assert/strict";
import { test } from "node:test";
import { createNarrator, formatNarration, lastNarratedLine, narrateLog } from "../../src/queue/narrate.mjs";
import {
  agentToolUseEvent,
  assistantEvent,
  attemptMarker,
  LANE_TOOL_USE_ID,
  narrationStream,
  noticeText,
  PR_URL,
  resultEvent,
  secondsIntoAttempt,
  SLUG,
  slugEvent,
  systemInitEvent,
  taskNotificationEvent,
  taskStartedEvent,
  toNdjson,
  toolResultEvent,
  toolUseEvent,
} from "../../test-support/streams.mjs";

const CANARY = "SECRET-CANARY";
const SECOND_ISO = "2026-09-07T20:10:00.000Z";

// The narrated lines of a log, exactly as `queue log` prints them.
function narrate(log, options = {}) {
  return narrateLog(log, options).map((event) => formatNarration(event));
}

// A log of one attempt built from the given events, the shape `openAttemptLog` leaves on disk.
function attemptLog(events, { attempt = 1, iso = undefined } = {}) {
  return `${attemptMarker(attempt, iso)}\n${toNdjson(events)}`;
}

test("the default narration turns a whole attempt into one line per relevant event", () => {
  assert.deepEqual(narrate(narrationStream()), [
    "00:00  ═ attempt 1",
    "00:02  » Reading the ticket before anything else.",
    "00:03  » Registered the run.",
    `00:03  ⚑ slug: ${SLUG}`,
    "00:05  · check the tree — Bash git status --short",
    "00:07  · run the suite — Bash npm test",
    "00:08  ✗ Bash failed: Exit code 1",
    "00:09  ▶ triager (phase 1, sonnet) — triage the bug",
    "00:13      · Read index.mjs",
    "00:14  ◀ triager (phase 1, sonnet) completed (2m05s · 2 tools · 0 edits)",
    "02:14  » ## Notice",
    "02:14  ℹ notice\n    The pull request is open and the checks are green.",
    `02:14  ✓ pull request: ${PR_URL}`,
    "02:14  ═ result: success",
  ]);
});

// A notice longer than the 400 code points the narration prints, the only case that has to point somewhere else.
const LONG_NOTICE = "The migration drops a column and a human has to decide. ".repeat(10);

// The `notice` line of a narration, the only line the pointer is ever attached to.
function noticeLineOf(log, options = {}) {
  return narrate(log, options).find((line) => line.includes("ℹ notice")) ?? "";
}

test("a notice the narration had to cut says where the whole text is read, with the real job id", () => {
  const line = noticeLineOf(narrationStream({ notice: LONG_NOTICE }), { jobId: 7 });
  assert.ok(line.includes("..."), line);
  assert.ok(line.endsWith("\n    read the whole notice with: nightshift queue status 7"), line);
});

test("a narration with no job id never points at a job nobody named", () => {
  const line = noticeLineOf(narrationStream({ notice: LONG_NOTICE }));
  assert.ok(line.includes("..."), line);
  assert.equal(line.includes("read the whole notice"), false, line);

  const cell = lastNarratedLine(attemptLog([systemInitEvent(), assistantEvent(noticeText(LONG_NOTICE))]));
  assert.ok(cell.startsWith("ℹ notice"), cell);
  assert.equal(cell.includes("read the whole notice"), false, "the one-line table cell grew a pointer");
});

test("a notice that fits is narrated whole, with no pointer to follow", () => {
  assert.equal(noticeLineOf(narrationStream(), { jobId: 7 }), "02:14  ℹ notice\n    The pull request is open and the checks are green.");
});

test("`--all` adds the text of the subagents, and nothing else", () => {
  const lines = narrate(narrationStream());
  const withAll = narrate(narrationStream(), { all: true });
  assert.deepEqual(
    withAll.filter((line) => !lines.includes(line)),
    ["00:12      » Looking at the runner first."],
  );
  assert.equal(lines.some((line) => line.includes("Looking at the runner first")), false);
});

test("a block that arrives after the lane closed is still a subagent block, not the orchestrator", () => {
  const log = attemptLog([
    agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }),
    taskNotificationEvent({ toolUses: 1, durationMs: 1000 }),
    assistantEvent("Subagent reasoning about the follow loop.", { parentToolUseId: LANE_TOOL_USE_ID, timestamp: secondsIntoAttempt(25) }),
    toolUseEvent({ id: "toolu_late", name: "Read", input: { file_path: "/repo/late.mjs" }, parentToolUseId: LANE_TOOL_USE_ID, timestamp: secondsIntoAttempt(26) }),
    toolResultEvent({ toolUseId: "toolu_late", content: "Exit code 1", isError: true, parentToolUseId: LANE_TOOL_USE_ID, timestamp: secondsIntoAttempt(27) }),
    resultEvent({ text: "Done." }),
  ]);

  const lines = narrate(log);
  assert.equal(lines.some((line) => line.includes("Subagent reasoning about the follow loop")), false, lines.join("\n"));
  assert.ok(lines.includes("00:26      · Read late.mjs"), lines.join("\n"));
  assert.ok(lines.includes("00:27      ✗ Read failed: Exit code 1"), lines.join("\n"));

  const withAll = narrate(log, { all: true });
  assert.deepEqual(
    withAll.filter((line) => !lines.includes(line)),
    ["00:25      » Subagent reasoning about the follow loop."],
  );
});

test("nothing sensitive of an event ever reaches a narrated line, with or without --all", () => {
  const log = attemptLog([
    agentToolUseEvent({ prompt: CANARY, description: "triage the bug", timestamp: secondsIntoAttempt(1) }),
    taskStartedEvent({ prompt: CANARY }),
    toolUseEvent({ id: "toolu_w", name: "Write", input: { file_path: "/repo/notes.md", content: CANARY }, parentToolUseId: "toolu_agent1", timestamp: secondsIntoAttempt(2) }),
    toolResultEvent({ toolUseId: "toolu_w", content: CANARY, parentToolUseId: "toolu_agent1", timestamp: secondsIntoAttempt(3) }),
    toolUseEvent({ id: "toolu_q", name: "mcp__nightshift__queue_add", input: { prompt: CANARY, project: "nightshift" }, parentToolUseId: "toolu_agent1", timestamp: secondsIntoAttempt(4) }),
    toolUseEvent({ id: "toolu_l", name: "mcp__nightshift__lesson_save", input: { title: CANARY, root_cause: CANARY }, parentToolUseId: "toolu_agent1", timestamp: secondsIntoAttempt(5) }),
    taskNotificationEvent({ summary: CANARY, toolUses: 1 }),
    resultEvent({ text: "Done." }),
  ]);
  for (const options of [{}, { all: true }]) {
    const printed = narrate(log, options).join("\n");
    assert.equal(printed.includes(CANARY), false, `the narration leaked the canary with ${JSON.stringify(options)}`);
    assert.ok(printed.includes("· Write notes.md"), printed);
    assert.ok(printed.includes("· queue_add nightshift"), printed);
    assert.ok(printed.includes("· lesson_save"), printed);
  }
});

test("a lane reports what was observed, and says `unknown` for what it never saw", () => {
  const closed = narrate(
    attemptLog([
      agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }),
      toolUseEvent({ id: "toolu_e", name: "Edit", input: { file_path: "/repo/src/cli/queue.mjs" }, parentToolUseId: "toolu_agent1", timestamp: secondsIntoAttempt(2) }),
      taskNotificationEvent({ toolUses: 1, durationMs: 3000 }),
    ]),
  );
  assert.ok(closed.includes("00:02  ◀ triager (phase 1, sonnet) completed (3s · 1 tools · 1 edits)"), closed.join("\n"));

  const blind = narrate(attemptLog([agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }), taskNotificationEvent({ toolUses: 4, durationMs: 3000 })]));
  assert.ok(blind.includes("00:01  ◀ triager (phase 1, sonnet) completed (3s · 4 tools · edits unknown)"), blind.join("\n"));

  const failed = narrate(attemptLog([agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }), taskNotificationEvent({ status: "failed", toolUses: 0, durationMs: 1000 })]));
  assert.ok(failed.includes("00:01  ◀ triager (phase 1, sonnet) failed (1s · 0 tools · 0 edits)"), failed.join("\n"));
});

test("a lane that never reported back is a line of its own, not a silence", () => {
  const lines = narrate(attemptLog([agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }), resultEvent({ text: "The runner died." })]));
  assert.ok(lines.includes("00:01  ⚠ triager (phase 1, sonnet) never reported back"), lines.join("\n"));
});

test("the lane opens from `task_started` when the tool call that spawned it was lost, and says nothing about a model it cannot know", () => {
  const lines = narrate(attemptLog([taskStartedEvent({}), taskNotificationEvent({ toolUses: 0, durationMs: 1000 })]));
  assert.ok(lines.includes("00:00  ▶ triager (phase 1) — triage the bug"), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("▶")).length, 1);
});

test("the lane label carries the model of the `tool_use` that launched it, the only event of the stream that says it", () => {
  const lines = narrate(
    attemptLog([
      agentToolUseEvent({ id: "toolu_o", subagentType: "nightshift:coder", model: "opus", description: "apply the plan", timestamp: secondsIntoAttempt(1) }),
      taskStartedEvent({ toolUseId: "toolu_o", subagentType: "nightshift:coder" }),
      taskNotificationEvent({ toolUseId: "toolu_o", toolUses: 3, durationMs: 4000 }),
    ]),
  );
  assert.ok(lines.includes("00:01  ▶ coder (phase 4, opus) — apply the plan"), lines.join("\n"));
  assert.ok(lines.includes("00:01  ◀ coder (phase 4, opus) completed (4s · 3 tools · edits unknown)"), lines.join("\n"));
});

test("parallel lanes label every indented line, and a single lane does not", () => {
  const lines = narrate(
    attemptLog([
      agentToolUseEvent({ id: "toolu_a", subagentType: "nightshift:qa-guardian", description: "review the diff", timestamp: secondsIntoAttempt(1) }),
      agentToolUseEvent({ id: "toolu_b", subagentType: "nightshift:coder", description: "apply the plan", timestamp: secondsIntoAttempt(2) }),
      toolUseEvent({ id: "toolu_r1", name: "Read", input: { file_path: "/repo/a.mjs" }, parentToolUseId: "toolu_a", timestamp: secondsIntoAttempt(3) }),
      toolUseEvent({ id: "toolu_r2", name: "Read", input: { file_path: "/repo/b.mjs" }, parentToolUseId: "toolu_b", timestamp: secondsIntoAttempt(4) }),
    ]),
  );
  assert.ok(lines.includes("00:03      · [qa-guardian] Read a.mjs"), lines.join("\n"));
  assert.ok(lines.includes("00:04      · [coder] Read b.mjs"), lines.join("\n"));
  assert.equal(narrate(narrationStream()).some((line) => line.includes("[triager]")), false);
});

test("the clock is relative to the attempt, restarts on the next one and never invents a zero", () => {
  const noClock = narrate(toNdjson([systemInitEvent(), assistantEvent("before any timestamp"), assistantEvent("with a clock", { timestamp: secondsIntoAttempt(0) }), assistantEvent("inherits the clock")]));
  assert.deepEqual(noClock, ["--:--  » before any timestamp", "00:00  » with a clock", "00:00  » inherits the clock"]);

  const twoAttempts = `${attemptLog([assistantEvent("first try", { timestamp: secondsIntoAttempt(30) })])}${attemptLog([assistantEvent("second try", { timestamp: secondsIntoAttempt(45, SECOND_ISO) })], { attempt: 2, iso: SECOND_ISO })}`;
  assert.deepEqual(narrate(twoAttempts), [
    "00:00  ═ attempt 1",
    "00:30  » first try",
    "00:00  ═ attempt 2",
    "00:45  » second try",
  ]);
});

test("a marker is printed once per value, however many events echo it", () => {
  const lines = narrate(
    attemptLog([
      slugEvent(SLUG, { timestamp: secondsIntoAttempt(1) }),
      slugEvent(SLUG, { timestamp: secondsIntoAttempt(2) }),
      assistantEvent(`## Requires user confirmation\n\nThe migration drops a column.`, { timestamp: secondsIntoAttempt(3) }),
      resultEvent({ text: `Stopped. ${PR_URL}` }),
    ]),
  );
  assert.equal(lines.filter((line) => line.includes("⚑ slug:")).length, 1);
  assert.equal(lines.filter((line) => line.includes("⚠ gate:")).length, 1);
  assert.equal(lines.filter((line) => line.includes("✓ pull request:")).length, 1);
});

test("what is not JSON is either the text the runner wrote or a line counted as unreadable", () => {
  const log = [
    attemptMarker(1),
    JSON.stringify(assistantEvent("working", { timestamp: secondsIntoAttempt(1) })),
    '{"type":"assistant","message":{"content":[{"type":"text","tex',
    "claude: command not found; install it and run `nightshift doctor`",
    `=== ownership lost @ ${secondsIntoAttempt(20)} ===`,
    "",
  ].join("\n");
  const lines = narrate(log);
  assert.ok(lines.includes("00:01  ℹ claude: command not found; install it and run `nightshift doctor`"), lines.join("\n"));
  assert.ok(lines.includes("00:20  ⚠ ownership lost"), lines.join("\n"));
  assert.ok(lines.includes("00:20  ℹ 1 unreadable log lines skipped"), lines.join("\n"));
});

test("a rate limit is silent while it allows the traffic, and a line as soon as it stops", () => {
  const events = (status) => attemptLog([{ type: "rate_limit_event", rate_limit_info: { status } }, resultEvent({ text: "done" })]);
  assert.equal(narrate(events("allowed")).some((line) => line.includes("rate limit")), false);
  assert.ok(narrate(events("rejected")).includes("00:00  ℹ rate limit: rejected"), "a rate limit that stopped the run vanished");
});

test("the two markers of a rate limit are narrated as the wait and its end, and never as a raw marker line", () => {
  const until = new Date(Date.parse(secondsIntoAttempt(0)) + 3600_000).toISOString();
  const log = [
    attemptMarker(1).trimEnd(),
    JSON.stringify(systemInitEvent({})),
    `=== rate limit until ${until} @ ${secondsIntoAttempt(30)} ===`,
    `=== rate limit over @ ${secondsIntoAttempt(90)} ===`,
    JSON.stringify(resultEvent({ text: "done" })),
    "",
  ].join("\n");

  const lines = narrate(log);
  const paused = lines.find((line) => line.includes("rate limit hit"));

  assert.ok(paused, lines.join("\n"));
  assert.ok(paused.startsWith("00:30  ⏸ rate limit hit - waiting until "), paused);
  assert.match(paused.replace("00:30  ⏸ rate limit hit - waiting until ", ""), /^(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}$/, paused);
  assert.ok(lines.includes("01:30  ▶ resumed"), lines.join("\n"));
  assert.equal(lines.some((line) => line.includes("⚠ rate limit")), false, "the pause was narrated as a bare runner marker");
  assert.equal(lastNarratedLine(log), "▶ resumed", "the bottom of `queue log` says nothing about the wait the job just came out of");
});

test("a rate limit marker whose instant cannot be read is still narrated, with the text it carried", () => {
  const log = [attemptMarker(1).trimEnd(), `=== rate limit until never @ ${secondsIntoAttempt(10)} ===`, ""].join("\n");

  assert.deepEqual(narrate(log), ["00:00  ═ attempt 1", "00:10  ⏸ rate limit hit - waiting until never"]);
});

test("a tool call is narrated by the intent the model wrote for it, with the call kept as the detail", () => {
  assert.deepEqual(
    narrate(
      attemptLog([
        toolUseEvent({
          id: "toolu_intent",
          name: "Bash",
          input: { command: 'grep -n "setItem" src/pages/ProfileFound.tsx', description: "Check what ProfileFound persists to localStorage" },
          timestamp: secondsIntoAttempt(2),
        }),
        toolUseEvent({ id: "toolu_bare", name: "Bash", input: { command: "npm test" }, timestamp: secondsIntoAttempt(3) }),
      ]),
    ),
    [
      "00:00  ═ attempt 1",
      '00:02  · Check what ProfileFound persists to localStorage — Bash grep -n "setItem" src/pages/ProfileFound...',
      "00:03  · Bash npm test",
    ],
  );
});

test("a huge event never produces a huge line", () => {
  const huge = "x".repeat(1_000_000);
  const lines = narrate(
    attemptLog([
      assistantEvent(huge, { timestamp: secondsIntoAttempt(1) }),
      toolUseEvent({ id: "toolu_big", name: "Bash", input: { command: huge }, timestamp: secondsIntoAttempt(2) }),
      toolResultEvent({ toolUseId: "toolu_big", content: huge, isError: true, timestamp: secondsIntoAttempt(3) }),
    ]),
  );
  for (const line of lines) assert.ok(line.length <= 260, `a narrated line is ${line.length} characters long`);
});

test("the narrator takes the log line by line and keeps its state between the lines", () => {
  const narrator = createNarrator();
  const lines = [];
  for (const line of narrationStream().split("\n")) for (const event of narrator.push(line)) lines.push(formatNarration(event));
  for (const event of narrator.finish()) lines.push(formatNarration(event));
  assert.deepEqual(lines, narrate(narrationStream()));
  assert.equal(formatNarration(narrator.note("quiet", "still running (30s quiet)")), "02:14  · still running (30s quiet)");
});

test("color is opt in, and never leaks into a redirected output", () => {
  const [line] = narrate(narrationStream());
  assert.equal(line.includes("\u001b["), false);
  assert.equal(formatNarration(narrateLog(narrationStream())[0], { color: true }).includes("\u001b["), true);
});

test("the last narrated line is what the bottom of `queue log` shows: a lane opening with its goal, or the tool a lane is on", () => {
  const task = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "coder", description: "implement stage 1 of the plan" } }] } });
  const lane = JSON.stringify({ type: "assistant", subagent_type: "coder", parent_tool_use_id: "t1", message: { content: [{ type: "tool_use", id: "t2", name: "Edit", input: { file_path: "/repo/src/a.mjs" } }] } });
  assert.match(lastNarratedLine(`${task}\n`), /^▶ coder.*— implement stage 1 of the plan/);
  assert.match(lastNarratedLine(`${task}\n${lane}\n`), /^· .*Edit/);
  assert.equal(lastNarratedLine(""), "");
});

test("a lane still open at the end of the log is in progress while the job runs, and an orphan only once the job is over", () => {
  const task = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "qa-guardian", description: "HA: PoC of the races" } }] } });
  const running = narrateLog(`${task}\n`, { running: true }).map((event) => `${event.kind}:${event.text}`);
  assert.ok(running.some((line) => /^laneOpen:qa-guardian.*still running$/.test(line)), running.join("\n"));
  assert.equal(running.some((line) => line.startsWith("laneOrphan:")), false, "a running job was called an orphan");
  const over = narrateLog(`${task}\n`).map((event) => `${event.kind}:${event.text}`);
  assert.ok(over.some((line) => /^laneOrphan:qa-guardian.*never reported back$/.test(line)), over.join("\n"));
});
