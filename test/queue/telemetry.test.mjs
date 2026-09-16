import assert from "node:assert/strict";
import { test } from "node:test";
import { phaseTelemetry, runDurationS } from "../../src/queue/telemetry.mjs";
import {
  agentToolUseEvent,
  assistantEvent,
  attemptMarker,
  resultEvent,
  secondsIntoAttempt,
  systemInitEvent,
  taskNotificationEvent,
  taskStartedEvent,
  toNdjson,
  toolResultEvent,
} from "../../test-support/streams.mjs";

// A log of one attempt built from the given events, the shape `openAttemptLog` leaves on disk.
function attemptLog(events, { attempt = 1, iso = undefined } = {}) {
  return `${attemptMarker(attempt, iso)}\n${toNdjson(events)}`;
}

// A lane of a phase: the `tool_use` that launched it, the `task_started` that echoes it and the report that closes it.
function lane({ id, subagentType, model, durationMs, seconds }) {
  return [
    agentToolUseEvent({ id, subagentType, model, description: "do the phase", timestamp: secondsIntoAttempt(seconds) }),
    taskStartedEvent({ toolUseId: id, subagentType }),
    taskNotificationEvent({ toolUseId: id, durationMs }),
  ];
}

test("the duration of the run is measured from the last attempt marker to the last event that carried a clock", () => {
  const log = attemptLog([
    systemInitEvent(),
    assistantEvent("Starting.", { timestamp: secondsIntoAttempt(5) }),
    toolResultEvent({ toolUseId: "toolu_1", timestamp: secondsIntoAttempt(305) }),
    resultEvent({ text: "Done." }),
  ]);

  assert.equal(runDurationS(log), 305);
});

test("an older attempt never speaks for the duration of the run, and a stream nobody timed has none", () => {
  const first = attemptLog([assistantEvent("First try.", { timestamp: secondsIntoAttempt(600) })]);
  const second = `${attemptMarker(2, "2026-09-07T21:00:00.000Z")}\n${toNdjson([
    assistantEvent("Second try.", { timestamp: "2026-09-07T21:00:40.000Z" }),
  ])}`;

  assert.equal(runDurationS(`${first}\n${second}`), 40);
  assert.equal(runDurationS(attemptLog([systemInitEvent(), resultEvent({ text: "Done." })])), null);
  assert.equal(runDurationS(toNdjson([assistantEvent("No marker.", { timestamp: secondsIntoAttempt(10) })])), null);
  assert.equal(runDurationS(null), null);
});

test("only `assistant` and `user` events are read for the duration: a `result` that carries a timestamp is not one", () => {
  const log = attemptLog([
    assistantEvent("Working.", { timestamp: secondsIntoAttempt(12) }),
    { ...resultEvent({ text: "Done." }), timestamp: secondsIntoAttempt(9000) },
  ]);

  assert.equal(runDurationS(log), 12);
});

test("every lane of the stream reports its phase, the model it ran and the duration the host measured", () => {
  const log = attemptLog([
    systemInitEvent(),
    ...lane({ id: "toolu_t", subagentType: "nightshift:triager", model: "haiku", durationMs: 61000, seconds: 1 }),
    ...lane({ id: "toolu_c", subagentType: "nightshift:coder", model: "opus", durationMs: 420000, seconds: 70 }),
    ...lane({ id: "toolu_q", subagentType: "nightshift:qa-guardian", model: "sonnet", durationMs: 227400, seconds: 500 }),
    resultEvent({ text: "Done." }),
  ]);

  assert.deepEqual(phaseTelemetry(log), [
    { phase: "triage", model: "haiku", durationS: 61 },
    { phase: "implementation", model: "opus", durationS: 420 },
    { phase: "qa", model: "sonnet", durationS: 227 },
  ]);
});

test("a lane whose report carried no usage keeps its model and reports no duration, and a lane outside the pipeline is not a phase", () => {
  const log = attemptLog([
    agentToolUseEvent({ id: "toolu_v", subagentType: "nightshift:verifier", model: "haiku", timestamp: secondsIntoAttempt(1) }),
    { type: "system", subtype: "task_notification", tool_use_id: "toolu_v", status: "completed", summary: "the report" },
    agentToolUseEvent({ id: "toolu_x", subagentType: "general-purpose", model: "sonnet", timestamp: secondsIntoAttempt(2) }),
    taskNotificationEvent({ toolUseId: "toolu_x", durationMs: 9000 }),
  ]);

  assert.deepEqual(phaseTelemetry(log), [{ phase: "verification", model: "haiku", durationS: null }]);
});

test("a phase that ran twice reports one lane per run, in order, and a lane never reported back has no duration", () => {
  const log = attemptLog([
    ...lane({ id: "toolu_c1", subagentType: "nightshift:coder", model: "opus", durationMs: 120000, seconds: 1 }),
    agentToolUseEvent({ id: "toolu_c2", subagentType: "nightshift:coder", model: "sonnet", timestamp: secondsIntoAttempt(200) }),
  ]);

  assert.deepEqual(phaseTelemetry(log), [
    { phase: "implementation", model: "opus", durationS: 120 },
    { phase: "implementation", model: "sonnet", durationS: null },
  ]);
});

test("a report closes the MOST RECENT lane of its tool id, which two sequential subagents may reuse", () => {
  const log = attemptLog([
    agentToolUseEvent({ id: "toolu_same", subagentType: "nightshift:explore", model: "sonnet", timestamp: secondsIntoAttempt(1) }),
    taskNotificationEvent({ toolUseId: "toolu_same", durationMs: 30000 }),
    agentToolUseEvent({ id: "toolu_same", subagentType: "nightshift:architect", model: "opus", timestamp: secondsIntoAttempt(60) }),
    taskNotificationEvent({ toolUseId: "toolu_same", durationMs: 900000 }),
  ]);

  assert.deepEqual(phaseTelemetry(log), [
    { phase: "explore", model: "sonnet", durationS: 30 },
    { phase: "architecture", model: "opus", durationS: 900 },
  ]);
});

test("the lanes of an attempt that was retried never speak for the run: the last attempt marker restarts the reading", () => {
  const first = attemptLog(lane({ id: "toolu_a", subagentType: "nightshift:triager", model: "haiku", durationMs: 30000, seconds: 1 }));
  const second = `${attemptMarker(2, "2026-09-07T21:00:00.000Z")}\n${toNdjson(
    lane({ id: "toolu_b", subagentType: "nightshift:coder", model: "opus", durationMs: 90000, seconds: 1 }),
  )}`;

  assert.deepEqual(phaseTelemetry(`${first}\n${second}`), [{ phase: "implementation", model: "opus", durationS: 90 }]);
});

test("a lane with no model in its `tool_use` reports none instead of inventing one, and a log with no lane is empty", () => {
  const log = attemptLog([
    agentToolUseEvent({ id: "toolu_n", subagentType: "nightshift:triager", model: null, timestamp: secondsIntoAttempt(1) }),
    taskNotificationEvent({ toolUseId: "toolu_n", durationMs: 1000 }),
  ]);

  assert.deepEqual(phaseTelemetry(log), [{ phase: "triage", model: null, durationS: 1 }]);
  assert.deepEqual(phaseTelemetry(attemptLog([systemInitEvent(), resultEvent({ text: "Done." })])), []);
  assert.deepEqual(phaseTelemetry(null), []);
});

test("the `task_started` event never opens a phase of its own: it carries no model, so the lane is the `tool_use` block", () => {
  const log = attemptLog([
    taskStartedEvent({ toolUseId: "toolu_lost", subagentType: "nightshift:triager" }),
    taskNotificationEvent({ toolUseId: "toolu_lost", durationMs: 5000 }),
  ]);

  assert.deepEqual(phaseTelemetry(log), []);
});
