import assert from "node:assert/strict";
import { test } from "node:test";
import { durationLabel, formatActiveMs, formatDurationMs, spanMs, timeoutLabel } from "../../studio/src/lib/format.ts";

test("the track's active time keeps its seconds past an hour, and rounds into the next hour without reading 60m", () => {
  assert.equal(formatActiveMs(5312000), "1h28m32s");
  assert.equal(formatActiveMs(3600000), "1h00m00s");
  assert.equal(formatActiveMs(3599600), "1h00m00s");
  assert.equal(formatActiveMs(249000), "4m09s");
  assert.equal(formatActiveMs(9000), "9s");
});

test("an unknown active time reads `-`, a job that never started included", () => {
  assert.equal(formatActiveMs(null), "-");
  assert.equal(formatActiveMs(Number.NaN), "-");
  assert.equal(formatActiveMs(-1), "-");
  assert.equal(spanMs(null, null, Date.now()), null);
  assert.equal(formatActiveMs(spanMs(null, null, Date.now())), "-");
});

test("the span of a job runs to its finish, or to now while it runs", () => {
  const start = "2026-10-10T10:00:00.000Z";
  assert.equal(spanMs(start, "2026-10-10T11:05:00.000Z", 0), 3900000);
  assert.equal(spanMs(start, null, Date.parse("2026-10-10T10:00:09.000Z")), 9000);
});

test("every other duration keeps its minute format past an hour", () => {
  assert.equal(formatDurationMs(5312000), "1h28m");
  assert.equal(formatDurationMs(3900000), "1h05m");
  assert.equal(formatDurationMs(249000), "4m09s");
  assert.equal(timeoutLabel(3700), "1h01m");
  assert.equal(timeoutLabel(14400), "4h");
  assert.equal(durationLabel("2026-10-10T10:00:00.000Z", "2026-10-10T11:05:00.000Z", 0), "1h05m");
  assert.equal(durationLabel(null, null, 0), "-");
});
