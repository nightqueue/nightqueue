import assert from "node:assert/strict";
import { test } from "node:test";
import { durationLabel, formatDurationMs, jobOriginsLabel, spanMs, timeoutLabel } from "../../studio/src/lib/format.ts";

test("a duration is minutes and seconds only, seconds always shown and never hours", () => {
  assert.equal(formatDurationMs(45000), "45s");
  assert.equal(formatDurationMs(9000), "9s");
  assert.equal(formatDurationMs(300000), "5m0s");
  assert.equal(formatDurationMs(249000), "4m9s");
  assert.equal(formatDurationMs(3600000), "60m0s");
  assert.equal(formatDurationMs(7503000), "125m3s");
  assert.equal(formatDurationMs(3599600), "60m0s");
});

test("an unknown duration reads `-`, a job that never started included", () => {
  assert.equal(formatDurationMs(null), "-");
  assert.equal(formatDurationMs(Number.NaN), "-");
  assert.equal(formatDurationMs(-1), "-");
  assert.equal(spanMs(null, null, Date.now()), null);
  assert.equal(formatDurationMs(spanMs(null, null, Date.now())), "-");
});

test("the span of a job runs to its finish, or to now while it runs", () => {
  const start = "2026-10-10T10:00:00.000Z";
  assert.equal(spanMs(start, "2026-10-10T11:05:00.000Z", 0), 3900000);
  assert.equal(spanMs(start, null, Date.parse("2026-10-10T10:00:09.000Z")), 9000);
});

test("every duration helper shares the one format", () => {
  assert.equal(timeoutLabel(3700), "61m40s");
  assert.equal(timeoutLabel(14400), "4h");
  assert.equal(durationLabel("2026-10-10T10:00:00.000Z", "2026-10-10T11:05:00.000Z", 0), "65m0s");
  assert.equal(durationLabel(null, null, 0), "-");
});

test("jobOriginsLabel lists every origin in stored order, and is null with none or a malformed list", () => {
  const origin = [{ kind: "linear", ref: "DLW-99" }, { kind: "sentry", ref: "4507" }, { kind: "discord", ref: "" }, { kind: "discord", ref: "1/2/3" }];
  assert.equal(jobOriginsLabel({ origin }), "origins: linear DLW-99, sentry 4507, discord 1/2/3");
  assert.equal(jobOriginsLabel({ origin: [] }), null);
  assert.equal(jobOriginsLabel({ origin: null }), null);
  assert.equal(jobOriginsLabel({}), null);
  assert.equal(jobOriginsLabel({ origin: { kind: "linear", ref: "DLW-99" } }), null);
});
