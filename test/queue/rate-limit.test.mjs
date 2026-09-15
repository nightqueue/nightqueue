import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { queueResumePath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import {
  clearOwnPause,
  clearOwnPauseIfOver,
  inheritablePause,
  ownPauseUntilMs,
  PAUSE_GRACE_S,
  pauseFromEvent,
  pauseUntilMs,
  readOwnPause,
  recordOwnPause,
  resumeRequestedAt,
  WARNING_UTILIZATION,
} from "../../src/queue/rate-limit.mjs";
import { listRunnerRecords, mergeOwnRunnerRecord, runnerView, writeRunnerRecord } from "../../src/queue/registry.mjs";
import { extractRateLimitFromEventLine } from "../../src/queue/stream.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { FIVE_HOUR_RESETS_AT_S, rateLimitEvent, SEVEN_DAY_RESETS_AT_S } from "../../test-support/streams.mjs";

// One event of the stream as the runner reads it: a raw NDJSON line.
function line(event) {
  return JSON.stringify(event);
}

// The pause a raw event line arms, which is the whole detection chain in one call.
function pauseOf(event) {
  return pauseFromEvent(extractRateLimitFromEventLine(line(event)));
}

// A registration of THIS process, the only file a runner ever writes its own pause into.
function registerSelf(env, extra = {}) {
  return writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain", ...extra }, env);
}

// A pause region written by hand, the shape another runner of the home would have left.
function pauseRegion(untilMs, { type = "five_hour", utilization = 0.99 } = {}) {
  return {
    pausedAt: new Date(untilMs - 3600_000).toISOString(),
    pausedUntil: new Date(untilMs).toISOString(),
    resetsAt: new Date(untilMs - PAUSE_GRACE_S * 1000).toISOString(),
    type,
    utilization,
  };
}

test("the event is read by structure: epoch seconds become milliseconds and every window comes through", () => {
  const info = extractRateLimitFromEventLine(line(rateLimitEvent({ status: "allowed_warning", rateLimitType: "seven_day", fiveHour: 0.15, sevenDay: 0.99 })));

  assert.deepEqual(info, {
    status: "allowed_warning",
    type: "seven_day",
    resetsAt: SEVEN_DAY_RESETS_AT_S * 1000,
    fiveHour: { utilization: 0.15, resetsAt: FIVE_HOUR_RESETS_AT_S * 1000 },
    sevenDay: { utilization: 0.99, resetsAt: SEVEN_DAY_RESETS_AT_S * 1000 },
  });
  assert.ok(info.resetsAt > 1_000_000_000_000, "the reset was read as seconds and never converted");
});

test("what is not a rate limit event, and what is one without a usable field, reads as nothing at all", () => {
  assert.equal(extractRateLimitFromEventLine('{"type":"system","subtype":"init"}'), null);
  assert.equal(extractRateLimitFromEventLine("not json at all"), null);
  assert.equal(extractRateLimitFromEventLine('{"type":"rate_limit_event"}'), null);
  assert.equal(extractRateLimitFromEventLine('{"type":"rate_limit_event","rate_limit_info":{"status":""}}'), null);

  const partial = extractRateLimitFromEventLine('{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}');
  assert.deepEqual(partial, { status: "rejected", type: null, resetsAt: null, fiveHour: null, sevenDay: null });
  assert.equal(pauseFromEvent(partial), null, "a rejection without a reset armed a pause out of nothing");
});

test("a magnitude the measured shape never carries is read as unknown, and a rejection then waits for the window's own reset", () => {
  const milliseconds = extractRateLimitFromEventLine(line(rateLimitEvent({ status: "rejected", resetsAt: Date.now() })));
  assert.equal(milliseconds.resetsAt, null, "a reset already in milliseconds was multiplied by a thousand all the same");

  const percentage = extractRateLimitFromEventLine(line(rateLimitEvent({ status: "allowed_warning", fiveHour: 50, sevenDay: 96 })));
  assert.deepEqual(
    { fiveHour: percentage.fiveHour.utilization, sevenDay: percentage.sevenDay.utilization },
    { fiveHour: null, sevenDay: null },
    "a utilization on a percentage scale was read as a share of the budget",
  );
  assert.equal(percentage.fiveHour.resetsAt, FIVE_HOUR_RESETS_AT_S * 1000, "a window lost the reset it did carry");
  assert.equal(pauseOf(rateLimitEvent({ status: "allowed_warning", fiveHour: 50, sevenDay: 96 })), null, "a warning nobody can size armed a pause on traffic that may be healthy");

  const rejected = pauseOf(rateLimitEvent({ status: "rejected", resetsAt: Date.now() }));
  assert.equal(rejected.resetsAt, new Date(FIVE_HOUR_RESETS_AT_S * 1000).toISOString(), "the rejection waited for a reset nobody announced");
  assert.equal(pauseOf(rateLimitEvent({ status: "rejected", rateLimitType: "unknown_window", resetsAt: Date.now() })), null, "a rejection with no reset left to read armed a pause out of nothing");
});

test("of the four real shapes of the event, exactly one arms a pause - and `overageStatus` never does", () => {
  assert.equal(WARNING_UTILIZATION, 0.95);
  const healthy = rateLimitEvent({ status: "allowed" });
  assert.equal(healthy.rate_limit_info.overageStatus, "rejected", "the decoy of 65% of real traffic left the fixture");

  assert.equal(pauseOf(healthy), null, "a healthy event carrying `overageStatus: rejected` paused the queue");
  assert.equal(pauseOf(rateLimitEvent({ status: "allowed_warning", rateLimitType: "seven_day", fiveHour: 0.15, sevenDay: 0.99 })), null, "a seven-day warning paused the queue for days");
  assert.ok(pauseOf(rateLimitEvent({ status: "allowed_warning", fiveHour: 0.96, sevenDay: 0.5 })), "a five-hour budget at the threshold armed nothing");
  assert.ok(pauseOf(rateLimitEvent({ status: "rejected", rateLimitType: "seven_day", sevenDay: 0.99 })), "a rejection armed nothing");
});

test("a warning waits out the five-hour window, and a rejection waits out the limit it names, with no cap", () => {
  const warning = pauseOf(rateLimitEvent({ status: "allowed_warning", rateLimitType: "seven_day", fiveHour: 0.96, sevenDay: 0.99 }));
  assert.deepEqual(
    { type: warning.type, resetsAt: warning.resetsAt, utilization: warning.utilization },
    { type: "five_hour", resetsAt: new Date(FIVE_HOUR_RESETS_AT_S * 1000).toISOString(), utilization: 0.96 },
    "the warning waited for a window other than the five-hour one",
  );
  assert.equal(warning.pausedUntil, new Date((FIVE_HOUR_RESETS_AT_S + PAUSE_GRACE_S) * 1000).toISOString());

  const rejected = pauseOf(rateLimitEvent({ status: "rejected", rateLimitType: "seven_day", fiveHour: 0.15, sevenDay: 0.99 }));
  assert.deepEqual(
    { type: rejected.type, resetsAt: rejected.resetsAt, utilization: rejected.utilization },
    { type: "seven_day", resetsAt: new Date(SEVEN_DAY_RESETS_AT_S * 1000).toISOString(), utilization: 0.99 },
    "the rejection did not wait for the limit the event named",
  );
  assert.equal(rejected.pausedUntil, new Date((SEVEN_DAY_RESETS_AT_S + PAUSE_GRACE_S) * 1000).toISOString());
  assert.ok(pauseUntilMs(rejected, SEVEN_DAY_RESETS_AT_S * 1000) !== null, "the pause was capped short of the reset it announced");
});

test("a pause already over is no pause at all, whatever the record still carries", () => {
  const past = pauseRegion(Date.now() - 1000);
  assert.equal(pauseUntilMs(past), null);
  assert.equal(pauseUntilMs(null), null);
  assert.equal(pauseUntilMs({ pausedUntil: "not an instant" }), null);
  assert.equal(pauseUntilMs(pauseRegion(Date.now() + 60_000)) > Date.now(), true);
});

test("the pause is one region of the OWN record, written whole, removed whole, and never at the cost of another key", async (t) => {
  const env = makeHome(t, "rate-limit-own-record");
  const registered = registerSelf(env, { logPath: "/tmp/runner.log" });
  await mergeOwnRunnerRecord({ dbShm: { ino: "1", dev: "2", at: "2026-09-14T00:00:00.000Z" } }, env);
  const untilMs = Date.now() + 3600_000;

  const merged = await recordOwnPause(pauseRegion(untilMs), env);

  assert.equal(merged.dbShm.ino, "1", "the pause merge dropped the witness another writer had left");
  assert.equal(merged.logPath, "/tmp/runner.log");
  assert.equal(merged.uptimeS, registered.uptimeS, "the pause merge re-stamped the boot witness the liveness reads");
  assert.equal(readOwnPause(env).pausedUntil, new Date(untilMs).toISOString());
  assert.equal(ownPauseUntilMs(env), untilMs);

  const view = runnerView(listRunnerRecords(env)[0]);
  assert.deepEqual({ pausedUntil: view.pausedUntil, rateLimit: view.rateLimit }, { pausedUntil: new Date(untilMs).toISOString(), rateLimit: { type: "five_hour", resetsAt: new Date(untilMs - PAUSE_GRACE_S * 1000).toISOString(), utilization: 0.99 } });

  const cleared = await clearOwnPause(env, readOwnPause(env));
  assert.equal(cleared.rateLimit, null);
  assert.equal(cleared.dbShm.ino, "1", "clearing the pause took another region with it");
  assert.equal(ownPauseUntilMs(env), null);
});

test("a clear only removes the pause it was decided from, and the over-only clear only removes a pause that is over", async (t) => {
  const env = makeHome(t, "rate-limit-clear-compare");
  registerSelf(env);
  const expired = pauseRegion(Date.now() - 1000);
  await recordOwnPause(expired, env);

  assert.equal((await clearOwnPauseIfOver(env)).rateLimit, null, "the over-only clear left a pause that was already over");

  const untilMs = Date.now() + 3600_000;
  await recordOwnPause(pauseRegion(untilMs), env);

  assert.equal((await clearOwnPause(env, expired)).rateLimit.pausedUntil, new Date(untilMs).toISOString(), "a clear decided from an older pause wiped the one a concurrent job had just armed");
  assert.equal((await clearOwnPauseIfOver(env)).rateLimit.pausedUntil, new Date(untilMs).toISOString(), "the over-only clear wiped a pause that still holds");
  assert.equal(ownPauseUntilMs(env), untilMs);

  assert.equal((await clearOwnPause(env, readOwnPause(env))).rateLimit, null, "a clear decided from the pause on record did not remove it");
  assert.equal(ownPauseUntilMs(env), null);
});

test("a clear that names no pause is refused, so a live pause is never left armed behind a call the caller believed cleared it", async (t) => {
  const env = makeHome(t, "rate-limit-clear-unnamed");
  registerSelf(env);
  const untilMs = Date.now() + 3600_000;
  await recordOwnPause(pauseRegion(untilMs), env);

  await assert.rejects(() => clearOwnPause(env), /clearOwnPauseIfOver/, "a clear with no pause named passed silently and left the live pause armed");
  await assert.rejects(() => clearOwnPause(env, null), /clearOwnPauseIfOver/, "a clear named from a pause nobody read passed silently");

  assert.equal(ownPauseUntilMs(env), untilMs, "the refused clear still touched the pause on record");
});

test("the record of another process is never rewritten, whatever is asked of it", async (t) => {
  const env = makeHome(t, "rate-limit-foreign-record");
  const foreign = writeRunnerRecord({ pid: process.pid + 1, startedAt: new Date().toISOString(), mode: "drain" }, env);
  registerSelf(env);

  await recordOwnPause(pauseRegion(Date.now() + 3600_000), env);

  const records = listRunnerRecords(env);
  const other = records.find((record) => record.info?.pid === foreign.pid);
  assert.equal(other.info.rateLimit, undefined, "the pause of one runner was written into the record of another");
  assert.equal(readOwnPause(env) !== null, true);
});

test("a runner starting now inherits the furthest-future pause of the live runners, and nothing from an expired one", (t) => {
  const env = makeHome(t, "rate-limit-inherit");
  const near = Date.now() + 60_000;
  const far = Date.now() + 3600_000;
  const alive = new Set([process.pid]);
  const killImpl = (pid) => {
    if (alive.has(pid)) return true;
    throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
  };

  assert.equal(inheritablePause(env, killImpl), null, "an empty registry handed a pause down");

  writeRunnerRecord({ pid: process.pid, startedAt: "2026-09-14T00:00:00.000Z", mode: "drain", rateLimit: pauseRegion(near) }, env);
  assert.equal(inheritablePause(env, killImpl).pausedUntil, new Date(near).toISOString());

  const second = process.pid + 1;
  alive.add(second);
  writeRunnerRecord({ pid: second, startedAt: "2026-09-14T00:01:00.000Z", mode: "watch", rateLimit: pauseRegion(far) }, env);
  assert.equal(inheritablePause(env, killImpl).pausedUntil, new Date(far).toISOString(), "the nearer pause won over the furthest one");

  const third = process.pid + 2;
  alive.add(third);
  writeRunnerRecord({ pid: third, startedAt: "2026-09-14T00:02:00.000Z", mode: "watch", rateLimit: pauseRegion(Date.now() - 1000) }, env);
  assert.equal(inheritablePause(env, killImpl).pausedUntil, new Date(far).toISOString(), "an expired pause changed what a new runner inherits");

  alive.delete(second);
  assert.equal(inheritablePause(env, killImpl).pausedUntil, new Date(near).toISOString(), "a runner that is gone still handed its pause down");
});

test("the resume stamp is an instant every runner compares its own pause against, and nothing else", (t) => {
  const env = makeHome(t, "rate-limit-resume-stamp");
  ensureHome(env);

  assert.equal(resumeRequestedAt(env), null, "a home where nobody ever resumed answered with an instant");

  writeFileSync(queueResumePath(env), "not an instant\n");
  assert.equal(resumeRequestedAt(env), null, "an unreadable stamp answered with an instant");

  const at = "2026-09-14T03:12:00.000Z";
  writeFileSync(queueResumePath(env), `${at}\n`);
  assert.equal(resumeRequestedAt(env), Date.parse(at));
});
