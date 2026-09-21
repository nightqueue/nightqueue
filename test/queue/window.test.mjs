import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseWallClock, resolveWindow, windowPhase } from "../../src/queue/window.mjs";

const RESOLVER = fileURLToPath(new URL("../../test-support/window-resolver.mjs", import.meta.url));

// A local instant built from calendar fields, so every test reads against the machine's own timezone instead of a hardcoded offset.
function local(year, month, day, hour = 0, minute = 0) {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

test("parseWallClock accepts only two-digit HH:MM in range, never `9:05` or an out-of-range field", () => {
  assert.deepEqual(parseWallClock("09:05"), { hour: 9, minute: 5 });
  assert.deepEqual(parseWallClock("23:59"), { hour: 23, minute: 59 });
  assert.deepEqual(parseWallClock("00:00"), { hour: 0, minute: 0 });
  assert.equal(parseWallClock("9:05"), null, "a single-digit hour must be refused");
  assert.equal(parseWallClock("24:00"), null, "an hour past 23 must be refused");
  assert.equal(parseWallClock("12:60"), null, "a minute past 59 must be refused");
  assert.equal(parseWallClock("noon"), null);
  assert.equal(parseWallClock(""), null);
  assert.equal(parseWallClock(undefined), null);
});

test("`--from` omitted defaults to now, and `until` is the first occurrence of its clock after now", () => {
  const nowMs = local(2024, 6, 10, 14, 30);
  const window = resolveWindow({ until: "18:00", nowMs });
  assert.deepEqual(window, { fromMs: nowMs, untilMs: local(2024, 6, 10, 18, 0) });
});

test("`--from` omitted and `until` already passed today rolls to tomorrow, a midnight crossing with no special case", () => {
  const nowMs = local(2024, 6, 10, 20, 0);
  const window = resolveWindow({ until: "04:00", nowMs });
  assert.deepEqual(window, { fromMs: nowMs, untilMs: local(2024, 6, 11, 4, 0) });
});

test("`--from` in the future: the window opens later today, unchanged by where `now` sits before it", () => {
  const nowMs = local(2024, 6, 10, 5, 0);
  const window = resolveWindow({ from: "19:00", until: "04:00", nowMs });
  assert.deepEqual(window, { fromMs: local(2024, 6, 10, 19, 0), untilMs: local(2024, 6, 11, 4, 0) });
  assert.equal(windowPhase({ ...window, nowMs }), "before");
});

test("started already inside the window works immediately: `from` resolves to `now`, `until` still the occurrence after the window's own start", () => {
  const nowMs = local(2024, 6, 10, 21, 0);
  const window = resolveWindow({ from: "19:00", until: "04:00", nowMs });
  assert.deepEqual(window, { fromMs: nowMs, untilMs: local(2024, 6, 11, 4, 0) });
  assert.equal(windowPhase({ ...window, nowMs }), "inside");
});

test("a midnight crossing window (`--from 22:00 --until 04:00`) resolves both edges on the correct calendar day", () => {
  const nowMs = local(2024, 6, 10, 10, 0);
  const window = resolveWindow({ from: "22:00", until: "04:00", nowMs });
  assert.deepEqual(window, { fromMs: local(2024, 6, 10, 22, 0), untilMs: local(2024, 6, 11, 4, 0) });
});

test("the boundaries of a window are exact: `now` at `from` is inside, `now` at `until` is after", () => {
  const window = { fromMs: local(2024, 6, 10, 19, 0), untilMs: local(2024, 6, 11, 4, 0) };
  assert.equal(windowPhase({ ...window, nowMs: window.fromMs }), "inside", "the instant `from` opens must already count as inside");
  assert.equal(windowPhase({ ...window, nowMs: window.fromMs - 1 }), "before");
  assert.equal(windowPhase({ ...window, nowMs: window.untilMs }), "after", "`until` is exclusive: the window is already closed at that instant");
  assert.equal(windowPhase({ ...window, nowMs: window.untilMs - 1 }), "inside");
});

// Resolves a window inside a child process pinned to a timezone that observes DST, the only reliable way to change what `Date` reads as local.
function resolveUnderTimezone(spec, tz) {
  const result = spawnSync(process.execPath, [RESOLVER, JSON.stringify(spec)], { env: { ...process.env, TZ: tz }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim());
}

test("a DST change day resolves to the wall-clock times the operator asked for, not a fixed UTC offset", () => {
  const TZ = "America/New_York";
  // 2024-03-10: America/New_York springs forward at 02:00 -> 03:00. A window opening the evening before and
  // closing after the jump must still read 23:00 and 06:00 in that zone, even though 6 real hours (not 7) elapsed.
  const nowMs = Date.UTC(2024, 2, 9, 15, 0); // 2024-03-09T15:00Z = 10:00 EST, well before `from`.
  const answer = resolveUnderTimezone({ from: "23:00", until: "06:00", nowMs }, TZ);
  assert.equal(answer.fromClock, "23:00", "the resolved `from` did not read as the local wall clock the operator asked for");
  assert.equal(answer.untilClock, "06:00", "the resolved `until` did not read as the local wall clock the operator asked for");
  const elapsedMs = answer.untilMs - answer.fromMs;
  assert.equal(elapsedMs, 6 * 60 * 60 * 1000, "the spring-forward hour was not accounted for in the resolved instants");
});
