import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTHING_TO_CLOSE_LINE, classifyJobResult } from "../../src/queue/classify.mjs";
import { derivedGateStop, derivedOutcome } from "../../src/queue/pipeline-record.mjs";
import { doneStream, gateStream, noticeText, PR_URL, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const AT = "2026-01-01T00:00:00.000Z";
const CONCLUSION = "✅ Resolved — no code change needed\n\nThe redirect loop comes from the CDN cache rule.";
const NOT_REPRODUCIBLE = "The crash does not reproduce on main with the recipe given.";

// The state.json of a run with the given phases, termination and outcome record.
function stateOf({ phases = [], termination, outcome } = {}) {
  return { schemaVersion: 1, slug: "fix-the-loop", phases, termination, outcome };
}

// A clean stream whose final text carries the given notice body.
function noticeStream(body) {
  return toNdjson([systemInitEvent(), resultEvent({ text: noticeText(body) })]);
}

// Classifies one clean attempt with the outcome `run report` derives from the same state.json.
function classifyDerived({ log, state }) {
  const runOutcome = derivedOutcome(state);
  return { runOutcome, gateStop: derivedGateStop(state, runOutcome), result: classifyJobResult({ log, exitCode: 0, state, runOutcome }) };
}

test("a NOT-REPRODUCIBLE run terminated at triage derives no_commit and still ends cancelled with nothing to close", () => {
  const state = stateOf({
    phases: [{ phase: "triage", at: AT, verdict: "NOT-REPRODUCIBLE" }],
    termination: { phase: "triage", reason: "NOT-REPRODUCIBLE", at: AT },
  });
  const { runOutcome, gateStop, result } = classifyDerived({ log: noticeStream(NOT_REPRODUCIBLE), state });
  assert.deepEqual([runOutcome, gateStop], ["no_commit", "triage"]);
  assert.equal(result.status, "cancelled");
  assert.equal(result.noticeMd, `${NOT_REPRODUCIBLE}\n\n${NOTHING_TO_CLOSE_LINE}`);
});

test("a NO-CHANGE-NEEDED run derives no_commit and still ends done with no pull request", () => {
  const state = stateOf({
    phases: [{ phase: "triage", at: AT, verdict: "NO-CHANGE-NEEDED" }],
    termination: { phase: "triage", reason: "NO-CHANGE-NEEDED", at: AT },
    outcome: { status: "no_change", notice: CONCLUSION, at: AT },
  });
  const { runOutcome, gateStop, result } = classifyDerived({ log: noticeStream(CONCLUSION), state });
  assert.deepEqual([runOutcome, gateStop], ["no_commit", null]);
  assert.deepEqual([result.status, result.prUrl, result.resolution], ["done", null, "no-change"]);
});

test("a NO-CHANGE-NEEDED termination with no outcome recorded yet derives no gate stop", () => {
  const state = stateOf({
    phases: [{ phase: "triage", at: AT, verdict: "NO-CHANGE-NEEDED" }],
    termination: { phase: "triage", reason: "NO-CHANGE-NEEDED", at: AT },
  });
  assert.deepEqual([derivedOutcome(state), derivedGateStop(state, derivedOutcome(state))], ["no_commit", null]);
});

test("a gate run derives no_commit with gate stop user and still waits at the gate", () => {
  const state = stateOf({ phases: [{ phase: "triage", at: AT, verdict: "PROCEED" }], outcome: { status: "gate", notice: "Approve the plan?", at: AT } });
  const { runOutcome, gateStop, result } = classifyDerived({ log: gateStream(), state });
  assert.deepEqual([runOutcome, gateStop], ["no_commit", "user"]);
  assert.equal(result.status, "gate");
});

test("a delivered run derives pr_opened and ends done with its pull request", () => {
  const state = stateOf({
    phases: [{ phase: "commit", at: AT, verdict: "PR opened", by: "runtime" }],
    outcome: { status: "done", prUrl: PR_URL, at: AT },
  });
  const { runOutcome, gateStop, result } = classifyDerived({ log: doneStream(), state });
  assert.deepEqual([runOutcome, gateStop], ["pr_opened", null]);
  assert.equal(result.status, "done");
});
