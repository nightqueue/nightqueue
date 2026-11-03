import assert from "node:assert/strict";
import { test } from "node:test";
import { runDurationS } from "../../src/queue/telemetry.mjs";
import {
  assistantEvent,
  attemptMarker,
  resultEvent,
  secondsIntoAttempt,
  systemInitEvent,
  toNdjson,
  toolResultEvent,
} from "../../test-support/streams.mjs";

// A log of one attempt built from the given events, the shape `openAttemptLog` leaves on disk.
function attemptLog(events, { attempt = 1, iso = undefined } = {}) {
  return `${attemptMarker(attempt, iso)}\n${toNdjson(events)}`;
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
