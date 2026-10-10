import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { phaseVar } from "../../studio/src/lib/phase-colors.ts";
import { legendEntries, phaseAttemptsTitle, phaseCaption, shareEntries, sharePercent, spentMs, trackCounts } from "../../studio/src/lib/track.ts";

const STUDIO = new URL("../../studio/src/", import.meta.url);

// One phase of the timeline wire, with the given fields over the defaults of a done phase.
function phase(fields = {}) {
  return { number: 3, name: "architect", agent: "architect", model: "opus", state: "done", skipped: null, durationMs: 60000, liveSinceMs: null, startMs: 90000, attempts: 1, byAttempt: [{ attempt: 1, durationMs: 60000, last: false }], tokens: 0, tokens_label: "-", ...fields };
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

test("a pending phase reads a dash, and a running phase counts its open part", () => {
  assert.equal(phaseCaption(phase({ state: "pending", startMs: null, attempts: 0, byAttempt: [] }), { runElapsedMs: null, clockMs: null }), "—");
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

test("the four captions of a skipped slot say who skipped it and why", () => {
  const clocks = { runElapsedMs: null, clockMs: null, tier: "simple" };
  assert.equal(phaseCaption(phase({ state: "skipped", skipped: { by: "tier", reason: null, at: null } }), clocks), "skipped · simple tier");
  assert.equal(phaseCaption(phase({ state: "skipped", skipped: { by: "architect", reason: "docs only", at: null } }), clocks), "skipped · architect: docs only");
  assert.equal(phaseCaption(phase({ state: "skipped", skipped: { by: "architect", reason: null, at: null } }), clocks), "skipped · architect");
  assert.equal(phaseCaption(phase({ state: "skipped", skipped: null }), clocks), "skipped");
});

test("the share entries are coloured by agent, so a share segment matches its track slot", () => {
  const phases = [phase({ number: 1, name: "triager", agent: "triager", tokens: 600 }), phase({ number: 2, name: "explore", agent: "explore", tokens: 0 }), phase({ number: 4, name: "coder", agent: "coder", tokens: 399, state: "now" }), phase({ number: 5, name: "qa-guardian", agent: "qaGuardian", tokens: 1 })];
  const entries = shareEntries(phases);
  assert.deepEqual(entries.map((entry) => [entry.number, entry.name, entry.percent, entry.running]), [[1, "triager", "60%", false], [4, "coder", "40%", true], [5, "qa-guardian", "<1%", false]]);
  assert.deepEqual(entries.map((entry) => entry.color), ["var(--ph-triager)", "var(--ph-coder)", "var(--ph-qa-guardian)"]);
  assert.deepEqual(entries.map((entry) => entry.hex), ["#3987e5", "#c98500", "#d55181"]);
  const architect = phase({ tokens: 10 });
  assert.equal(shareEntries([architect])[0].color, phaseVar(architect.agent), "the architect share colour is the architect slot colour");
  assert.equal(shareEntries([phase({ number: 0, name: "brief", agent: null, tokens: 5 })])[0].color, "var(--ph-system)");
});

test("the share legend keeps the top three shares, ties broken by phase order, listed in phase order", () => {
  const entry = (number, share) => ({ number, name: `p${number}`, color: "", hex: "", percent: "", share, running: false });
  assert.deepEqual(legendEntries([entry(0, 0.1), entry(3, 0.4), entry(4, 0.3), entry(6, 0.2)], 3).map((kept) => kept.number), [3, 4, 6]);
  assert.deepEqual(legendEntries([entry(0, 0.25), entry(3, 0.25), entry(4, 0.25), entry(6, 0.25)], 3).map((kept) => kept.number), [0, 3, 4]);
  assert.deepEqual(legendEntries([entry(6, 0.9), entry(1, 0.1)], 3).map((kept) => kept.number), [1, 6]);
  assert.deepEqual(legendEntries([], 3), []);
});

test("the track counts leave the skipped slots out: a simple feature runs five slots and skips four", () => {
  const states = ["done", "skipped", "skipped", "skipped", "now", "skipped", "pending", "pending", "pending"];
  const counts = trackCounts(states.map((state, number) => phase({ number, state })));
  assert.equal(counts.skipped, 4);
  assert.deepEqual(counts.running.map((kept) => kept.number), [0, 4, 6, 7, 8]);
  assert.deepEqual(trackCounts([]), { running: [], skipped: 0 });
});

test("a share percent is whole, <1% above zero and below one percent, and 0% for nothing", () => {
  assert.deepEqual([sharePercent(0.004), sharePercent(0.01), sharePercent(0.496), sharePercent(1), sharePercent(0), sharePercent(Number.NaN)], ["<1%", "1%", "50%", "100%", "0%", "0%"]);
  assert.deepEqual(shareEntries([]), []);
});
