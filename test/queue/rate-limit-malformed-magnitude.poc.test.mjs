import assert from "node:assert/strict";
import { test } from "node:test";
import { pauseFromEvent } from "../../src/queue/rate-limit.mjs";
import { extractRateLimitFromEventLine } from "../../src/queue/stream.mjs";
import { rateLimitEvent } from "../../test-support/streams.mjs";

// One event of the stream as the runner reads it: a raw NDJSON line.
function line(event) {
  return JSON.stringify(event);
}

// The pause a raw event line arms, which is the whole detection chain in one call.
function pauseOf(event) {
  return pauseFromEvent(extractRateLimitFromEventLine(line(event)));
}

test("a percentage-scale utilization (95 instead of 0.95) arms no pause on comfortably healthy traffic", () => {
  const percentageScaled = rateLimitEvent({ status: "allowed_warning", rateLimitType: "five_hour", fiveHour: 50, sevenDay: 0.06 });

  assert.equal(pauseOf(percentageScaled), null, "a utilization of 50 (a provider reporting percent-scale, i.e. 50% of the budget) armed a pause on comfortably healthy traffic");
});

test("a resetsAt already expressed in milliseconds does not arm a pause centuries in the future", () => {
  const now = Date.now();
  const alreadyMs = now + 3600_000; // one hour from now, but shaped like the milliseconds the field never carries in the measured shape
  const malformed = rateLimitEvent({ status: "rejected", rateLimitType: "five_hour", resetsAt: alreadyMs });

  const pause = pauseOf(malformed);
  assert.ok(pause, "the malformed event armed no pause at all");

  const pausedUntilMs = Date.parse(pause.pausedUntil);
  const thirtyDaysOut = now + 30 * 24 * 3600 * 1000;
  assert.ok(pausedUntilMs <= thirtyDaysOut, `pausedUntil ${pause.pausedUntil} is implausibly far in the future for what should be a one-hour reset`);
});
