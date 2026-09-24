import assert from "node:assert/strict";
import { test } from "node:test";
import { PIPELINE_OUTCOMES } from "../../src/memory/runs.mjs";
import { NOTHING_TO_CLOSE_LINE, SILENT_STOP_NOTICE, classifyJobResult } from "../../src/queue/classify.mjs";
import { doneStream, gateStream, noticeText, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const QUIET = toNdjson([systemInitEvent(), resultEvent({ text: "" })]);
const EXPLAINED = toNdjson([systemInitEvent(), resultEvent({ text: noticeText("The bug is already fixed on main; there was nothing to change.") })]);

test("a clean exit with no pull request and no gate is cancelled only when this attempt's telemetry recorded no_commit", () => {
  const expected = { pr_opened: "failed", local_commit: "failed", no_commit: "cancelled", investigated: "failed", queued: "failed" };
  assert.deepEqual(Object.keys(expected).sort(), [...PIPELINE_OUTCOMES].sort(), "an outcome of the telemetry enum has no expectation here");
  for (const [runOutcome, status] of Object.entries(expected)) {
    assert.equal(classifyJobResult({ log: QUIET, exitCode: 0, runOutcome }).status, status, runOutcome);
  }
  assert.equal(classifyJobResult({ log: QUIET, exitCode: 0, runOutcome: null }).status, "failed", "a run with no telemetry row");
  assert.equal(classifyJobResult({ log: QUIET, exitCode: 0 }).status, "failed", "a caller that passes no outcome");
});

test("a no_commit finish carries the run's own reason followed by the nothing-to-close line, never the silent-stop notice", () => {
  const silent = classifyJobResult({ log: QUIET, exitCode: 0, runOutcome: "no_commit" });
  assert.equal(silent.noticeMd, NOTHING_TO_CLOSE_LINE);
  assert.notEqual(silent.noticeMd, SILENT_STOP_NOTICE);

  const explained = classifyJobResult({ log: EXPLAINED, exitCode: 0, runOutcome: "no_commit" });
  assert.equal(explained.status, "cancelled");
  assert.equal(explained.noticeMd, `The bug is already fixed on main; there was nothing to change.\n\n${NOTHING_TO_CLOSE_LINE}`);
});

test("no_commit never outranks a stop, a timeout, a failed exit, a pull request or a gate that asked its question", () => {
  const cases = [
    [{ log: QUIET, exitCode: 0, stopped: true }, "cancelled", null],
    [{ log: QUIET, exitCode: 0, timedOut: true }, "failed", null],
    [{ log: QUIET, exitCode: 0, idleTimedOut: true }, "failed", null],
    [{ log: QUIET, exitCode: 1 }, "failed", null],
    [{ log: QUIET, exitCode: 1, stopped: true }, "cancelled", null],
    [{ log: doneStream(), exitCode: 0 }, "done", null],
    [{ log: gateStream(), exitCode: 0 }, "gate", null],
    [{ log: QUIET, exitCode: 0, state: { schemaVersion: 1, slug: "fix-the-worker", phases: [], outcome: { status: "gate" } } }, "failed", null],
  ];
  for (const [ending, status] of cases) {
    const outcome = classifyJobResult({ ...ending, runOutcome: "no_commit" });
    assert.equal(outcome.status, status, JSON.stringify({ ...ending, log: undefined }));
    assert.equal(String(outcome.noticeMd ?? "").includes(NOTHING_TO_CLOSE_LINE), false, `${status}: the nothing-to-close line was added`);
  }
});
