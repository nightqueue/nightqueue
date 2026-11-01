import assert from "node:assert/strict";
import { test } from "node:test";
import { SILENT_STOP_NOTICE, classifyJobResult } from "../../src/queue/classify.mjs";
import { intermediateDeliveryStream, PR_URL } from "../../test-support/streams.mjs";

// Job #17's exact shape: the PR delivery and the notice sit ONLY in an intermediate orchestrator
// message, and the trailing `result` event carries neither. exitCode is 0. The record is what
// makes it a delivery: the text alone never does.
test("a job whose PR delivery lives only in an intermediate message is done through its record, with the recorded URL", () => {
  const log = intermediateDeliveryStream();

  const outcome = classifyJobResult({ log, exitCode: 0, state: { outcome: { status: "done", prUrl: PR_URL, notice: "open" } } });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.prUrl, PR_URL);
});

test("the same stream with no record delivers nothing: neither its table row nor its `Record: • PR <url>` line is a source", () => {
  for (const delivered of [true, false]) {
    const outcome = classifyJobResult({ log: intermediateDeliveryStream({ delivered }), exitCode: 0 });
    assert.equal(outcome.prUrl, null, "text was read as a delivery");
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
  }
});
