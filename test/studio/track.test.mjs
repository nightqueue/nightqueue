import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { phaseAttemptsTitle, phaseCaption, spentMs } from "../../studio/src/lib/track.ts";

const STUDIO = new URL("../../studio/src/", import.meta.url);

// One phase of the timeline wire, with the given fields over the defaults of a done phase.
function phase(fields = {}) {
  return { number: 3, name: "architect", model: "opus", state: "done", durationMs: 60000, liveSinceMs: null, startMs: 90000, attempts: 1, byAttempt: [{ attempt: 1, durationMs: 60000, last: false }], tokens: 0, tokens_label: "-", ...fields };
}

// One attempts_log row, finished at the given outcome.
function attemptRow(attempt, outcome) {
  return { attempt, worker: null, session_id: null, started_at: "2026-09-07T19:50:00Z", finished_at: "2026-09-07T20:00:00Z", duration_s: 600, outcome, exit_reason: null, spawns: 0, tokens_in: null, tokens_out: null, cache_read: null, cache_creation: null, cost_usd: null, fresh: true, backfilled: false };
}

test("a gated phase reads its start and the job clock at the gate, never a duration", () => {
  const gated = phase({ state: "gate", startMs: 150000, durationMs: 411000 });
  assert.equal(phaseCaption(gated, { runElapsedMs: null, clockMs: 561000 }), "02:30 · gate at 09:21");
});

test("a phase that ran in two attempts reads start, summed duration and the attempt count", () => {
  const twice = phase({ durationMs: 663000, attempts: 2 });
  assert.equal(phaseCaption(twice, { runElapsedMs: null, clockMs: null }), "01:30 · 11m03s · 2 att.");
  assert.equal(phaseCaption(phase(), { runElapsedMs: null, clockMs: null }), "01:30 · 1m00s");
});

test("pending and skipped phases read a dash, and a running phase counts its open part", () => {
  assert.equal(phaseCaption(phase({ state: "pending", startMs: null, attempts: 0, byAttempt: [] }), { runElapsedMs: null, clockMs: null }), "—");
  assert.equal(phaseCaption(phase({ state: "skip" }), { runElapsedMs: null, clockMs: null }), "—");
  const running = phase({ state: "now", durationMs: 0, liveSinceMs: 10000 });
  assert.equal(spentMs(running, 40000), 30000);
  assert.equal(phaseCaption(running, { runElapsedMs: 40000, clockMs: null }), "01:30 · 30s");
});

test("the per-attempt hover names each attempt's time and the outcome of the attempt that stopped in the phase", () => {
  const twice = phase({
    attempts: 2,
    byAttempt: [
      { attempt: 1, durationMs: 411000, last: true },
      { attempt: 2, durationMs: 252000, last: true },
    ],
  });
  assert.equal(phaseAttemptsTitle(twice, [attemptRow(1, "gate"), attemptRow(2, "done")]), "attempt 1: 6m51s → gate · attempt 2: 4m12s");
  assert.equal(phaseAttemptsTitle(twice, null), "attempt 1: 6m51s · attempt 2: 4m12s");
  assert.equal(phaseAttemptsTitle(phase({ byAttempt: undefined }), []), "");
});

test("the gate is no longer a segment: format.ts drops its approximations and the track has no gate segment", () => {
  const format = readFileSync(new URL("lib/format.ts", STUDIO), "utf8");
  assert.doesNotMatch(format, /export function (gateWaits|gatePosition)/);
  assert.doesNotMatch(format, /TODO\(NQ-88\)/);
  const track = readFileSync(new URL("components/job/PhaseTimeline.tsx", STUDIO), "utf8");
  assert.doesNotMatch(track, /GateSegment/);
  assert.match(track, /gate at phase/);
});
