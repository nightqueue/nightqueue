import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_CHANGE_NEXT_STEP_LINE, NOTHING_TO_CLOSE_LINE, SILENT_STOP_NOTICE, classifyJobResult, noChangeNotice } from "../../src/queue/classify.mjs";
import { doneStream, failureStream, gateStream, noticeText, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const CONCLUSION = "✅ Resolved — no code change needed\n\nThe redirect loop comes from the CDN cache rule, not from this repository.";
const NOTICE = `${CONCLUSION}\n\n${NO_CHANGE_NEXT_STEP_LINE}`;
const QUIET = toNdjson([systemInitEvent(), resultEvent({ text: "" })]);
const CONCLUDED = toNdjson([systemInitEvent(), resultEvent({ text: noticeText(CONCLUSION) })]);

// The state.json of a run that recorded the given outcome.
function stateWith(outcome) {
  return { schemaVersion: 1, slug: "fix-the-loop", phases: [], termination: { phase: "triage", reason: "NO-CHANGE-NEEDED", at: "2026-01-01T00:00:00.000Z" }, outcome };
}

const NO_CHANGE = stateWith({ status: "no_change", notice: CONCLUSION });

// How many times the next-step line appears in a notice.
function nextStepCount(notice) {
  return String(notice).split(NO_CHANGE_NEXT_STEP_LINE).length - 1;
}

test("a clean exit that recorded no_change with its conclusion ends done, with no pull request, the no-change marker and the runtime's next-step line", () => {
  for (const runOutcome of ["no_commit", "investigated", null]) {
    const outcome = classifyJobResult({ log: CONCLUDED, exitCode: 0, state: NO_CHANGE, runOutcome });
    assert.equal(outcome.status, "done", String(runOutcome));
    assert.equal(outcome.prUrl, null);
    assert.equal(outcome.resolution, "no-change");
    assert.equal(outcome.noticeMd, NOTICE);
    assert.equal(outcome.noticeMd.includes(NOTHING_TO_CLOSE_LINE), false, "a no-change done got the nothing-to-close line");
  }
  const recordedOnly = classifyJobResult({ log: QUIET, exitCode: 0, state: NO_CHANGE, runOutcome: "no_commit" });
  assert.deepEqual([recordedOnly.status, recordedOnly.noticeMd], ["done", NOTICE], "the recorded notice stands in for a stream without one");
});

test("the next-step line is written exactly once, whether or not the run's notice already carried it", () => {
  const written = toNdjson([systemInitEvent(), resultEvent({ text: noticeText(`${NOTICE}\n\n${NO_CHANGE_NEXT_STEP_LINE}`) })]);
  const outcome = classifyJobResult({ log: written, exitCode: 0, state: NO_CHANGE, runOutcome: "no_commit" });
  assert.equal(outcome.noticeMd, NOTICE);
  assert.equal(nextStepCount(outcome.noticeMd), 1);
  assert.equal(noChangeNotice(CONCLUSION), NOTICE);
  assert.equal(noChangeNotice(NOTICE), NOTICE);
  assert.equal(noChangeNotice(null), NO_CHANGE_NEXT_STEP_LINE);
});

test("the no-change marker is set on no other ending: a pull request done, a gate, a failure or a cancel", () => {
  const endings = [
    classifyJobResult({ log: doneStream(), exitCode: 0 }),
    classifyJobResult({ log: gateStream(), exitCode: 0, runOutcome: "no_commit" }),
    classifyJobResult({ log: failureStream(), exitCode: 1 }),
    classifyJobResult({ log: CONCLUDED, exitCode: 0, runOutcome: "no_commit" }),
    classifyJobResult({ log: CONCLUDED, exitCode: 0, state: NO_CHANGE, runOutcome: "no_commit", stopped: true }),
  ];
  for (const outcome of endings) {
    assert.equal(outcome.resolution, undefined, `${outcome.status} carries a resolution`);
    assert.equal(nextStepCount(outcome.noticeMd ?? ""), 0, `${outcome.status} got the next-step line`);
  }
});

test("no_change never outranks a stop, a timeout, an idle timeout or a failed exit", () => {
  const cases = [
    [{ stopped: true }, "cancelled"],
    [{ timedOut: true }, "failed"],
    [{ idleTimedOut: true }, "failed"],
    [{ exitCode: 1 }, "failed"],
  ];
  for (const [ending, status] of cases) {
    const outcome = classifyJobResult({ log: CONCLUDED, exitCode: 0, state: NO_CHANGE, runOutcome: "no_commit", ...ending });
    assert.equal(outcome.status, status, JSON.stringify(ending));
  }
});

test("no_change without a notice is a silent stop, and no_change on an attempt that committed is a failure", () => {
  const silent = classifyJobResult({ log: QUIET, exitCode: 0, state: stateWith({ status: "no_change" }), runOutcome: "no_commit" });
  assert.deepEqual([silent.status, silent.noticeMd], ["failed", SILENT_STOP_NOTICE]);
  for (const runOutcome of ["local_commit", "pr_opened"]) {
    assert.equal(classifyJobResult({ log: CONCLUDED, exitCode: 0, state: NO_CHANGE, runOutcome }).status, "failed", runOutcome);
  }
});

test("no_change recorded outside the triage phase, or with no termination, ends as it would without it", () => {
  const elsewhere = { ...NO_CHANGE, termination: { phase: "implement", reason: "x", at: "2026-01-01T00:00:00.000Z" } };
  const unrecorded = { ...NO_CHANGE, termination: undefined };
  for (const state of [elsewhere, unrecorded]) {
    const outcome = classifyJobResult({ log: CONCLUDED, exitCode: 0, state, runOutcome: "no_commit" });
    assert.equal(outcome.status, "cancelled");
    assert.equal(outcome.resolution, undefined);
  }
});

test("without the no_change record a no_commit exit is still cancelled with nothing to close, and a gate still waits", () => {
  const cancelled = classifyJobResult({ log: CONCLUDED, exitCode: 0, runOutcome: "no_commit" });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.noticeMd, `${CONCLUSION}\n\n${NOTHING_TO_CLOSE_LINE}`);
  assert.equal(classifyJobResult({ log: gateStream(), exitCode: 0, runOutcome: "no_commit" }).status, "gate");
});
