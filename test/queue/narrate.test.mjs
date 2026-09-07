import assert from "node:assert/strict";
import { test } from "node:test";
import { createNarrator, formatNarration, narrateLog } from "../../src/queue/narrate.mjs";
import {
  agentToolUseEvent,
  assistantEvent,
  attemptMarker,
  LANE_TOOL_USE_ID,
  narrationStream,
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
    "00:05  · Bash git status --short",
    "00:07  · Bash npm test",
    "00:08  ✗ Bash failed: Exit code 1",
    "00:09  ▶ triager (phase 1) — triage the bug",
    "00:13      · Read index.mjs",
    "00:14  ◀ triager (phase 1) completed (2m05s · 2 tools · 0 edits)",
    "02:14  » ## Notice",
    "02:14  ℹ notice\n    The pull request is open and the checks are green.",
    `02:14  ✓ pull request: ${PR_URL}`,
    "02:14  ═ result: success",
  ]);
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
  assert.ok(closed.includes("00:02  ◀ triager (phase 1) completed (3s · 1 tools · 1 edits)"), closed.join("\n"));

  const blind = narrate(attemptLog([agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }), taskNotificationEvent({ toolUses: 4, durationMs: 3000 })]));
  assert.ok(blind.includes("00:01  ◀ triager (phase 1) completed (3s · 4 tools · edits unknown)"), blind.join("\n"));

  const failed = narrate(attemptLog([agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }), taskNotificationEvent({ status: "failed", toolUses: 0, durationMs: 1000 })]));
  assert.ok(failed.includes("00:01  ◀ triager (phase 1) failed (1s · 0 tools · 0 edits)"), failed.join("\n"));
});

test("a lane that never reported back is a line of its own, not a silence", () => {
  const lines = narrate(attemptLog([agentToolUseEvent({ timestamp: secondsIntoAttempt(1) }), resultEvent({ text: "The runner died." })]));
  assert.ok(lines.includes("00:01  ⚠ triager (phase 1) never reported back"), lines.join("\n"));
});

test("the lane opens from `task_started` when the tool call that spawned it was lost", () => {
  const lines = narrate(attemptLog([taskStartedEvent({}), taskNotificationEvent({ toolUses: 0, durationMs: 1000 })]));
  assert.ok(lines.includes("00:00  ▶ triager (phase 1) — triage the bug"), lines.join("\n"));
  assert.equal(lines.filter((line) => line.includes("▶")).length, 1);
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
    "claude: command not found; install it and run `shift doctor`",
    `=== ownership lost @ ${secondsIntoAttempt(20)} ===`,
    "",
  ].join("\n");
  const lines = narrate(log);
  assert.ok(lines.includes("00:01  ℹ claude: command not found; install it and run `shift doctor`"), lines.join("\n"));
  assert.ok(lines.includes("00:20  ⚠ ownership lost"), lines.join("\n"));
  assert.ok(lines.includes("00:20  ℹ 1 unreadable log lines skipped"), lines.join("\n"));
});

test("a rate limit is silent while it allows the traffic, and a line as soon as it stops", () => {
  const events = (status) => attemptLog([{ type: "rate_limit_event", rate_limit_info: { status } }, resultEvent({ text: "done" })]);
  assert.equal(narrate(events("allowed")).some((line) => line.includes("rate limit")), false);
  assert.ok(narrate(events("rejected")).includes("00:00  ℹ rate limit: rejected"), "a rate limit that stopped the run vanished");
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
