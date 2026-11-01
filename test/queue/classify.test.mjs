import assert from "node:assert/strict";
import { test } from "node:test";
import { GATE_WITHOUT_NOTICE, SILENT_STOP_NOTICE, backoffMs, classifyJobResult } from "../../src/queue/classify.mjs";
import {
  assistantEvent,
  codeChangePublishedEvent,
  doneStream,
  failureStream,
  GATE_MARKER,
  gateStream,
  intermediateDeliveryStream,
  PR_URL,
  resultEvent,
  systemInitEvent,
  toNdjson,
} from "../../test-support/streams.mjs";

// The outcome of a clean run whose final result event carries the given text.
function classifyResultText(text) {
  return classifyJobResult({ log: toNdjson([systemInitEvent(), resultEvent({ text })]), exitCode: 0 });
}

// A parsed state.json carrying the outcome record the pipeline writes.
function stateWith(outcome) {
  return { schemaVersion: 1, slug: "fix-the-worker", phases: [], outcome };
}

// A stream whose final text and whose intermediate messages carry the given texts, in that order.
function streamOf(intermediate, resultText) {
  return toNdjson([systemInitEvent(), assistantEvent(intermediate), resultEvent({ text: resultText })]);
}

// A log whose last attempt was killed by the CLI's own 600s wait ceiling: the raw ceiling line plus the `task_updated` killed event.
function killedStream({ resultText = "" } = {}) {
  return [
    JSON.stringify(systemInitEvent()),
    "Background tasks still running after 600s; terminating. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0 to wait indefinitely.",
    JSON.stringify({ type: "system", subtype: "task_updated", task_id: "task_kill", patch: { status: "killed" } }),
    JSON.stringify(resultEvent({ text: resultText })),
  ].join("\n");
}

test("a run that recorded its delivery is done, with the URL and the notice of the record", () => {
  const outcome = classifyJobResult({ log: doneStream({ notice: "what the stream said" }), exitCode: 0, state: stateWith({ status: "done", prUrl: PR_URL, notice: "the pull request is open" }) });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.prUrl, PR_URL);
  assert.equal(outcome.noticeMd, "the pull request is open");
});

test("a recorded gate beats the pull request URL: a run waiting on a human is never done", () => {
  const outcome = classifyJobResult({ log: doneStream(), exitCode: 0, state: stateWith({ status: "gate", prUrl: PR_URL, notice: "Decide between A and B." }) });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.prUrl, PR_URL, "the URL is still recorded on a gate");
});

test("a gate only exists when it was recorded: the heading in the stream or in the final text asks nothing", () => {
  for (const log of [gateStream(), doneStream({ notice: `${GATE_MARKER}\n\nThe pull request is open.` }), toNdjson([systemInitEvent(), resultEvent({ text: `${GATE_MARKER}\n\nDecide.` })])]) {
    const outcome = classifyJobResult({ log, exitCode: 0 });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
  }
});

test("an exit code other than zero is a failure, whatever the stream said", () => {
  assert.equal(classifyJobResult({ log: failureStream(), exitCode: 1 }).status, "failed");
  assert.equal(classifyJobResult({ log: doneStream(), exitCode: 2 }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: -1 }).status, "failed");
});

test("a timeout is a failure that no retry may pick up, and a stop is a cancellation", () => {
  assert.equal(classifyJobResult({ log: "", exitCode: 0, timedOut: true }).status, "failed");
  assert.equal(classifyJobResult({ log: doneStream(), exitCode: 0, idleTimedOut: true }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: -1, stopped: true }).status, "cancelled");
  assert.equal(
    classifyJobResult({ log: "", exitCode: -1, stopped: true, timedOut: true }).status,
    "cancelled",
    "a stop must win over a timeout",
  );
});

test("a clean exit that said nothing at all is a failure with the fixed warning, never a silent gate", () => {
  const outcome = classifyJobResult({ log: "", exitCode: 0 });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
});

test("the final text of the orchestrator is never the notice: a clean exit with no record says no outcome was recorded", () => {
  const outcome = classifyResultText("  I need you to decide between renaming the column or keeping both.  ");
  assert.equal(outcome.status, "failed", "no recorded outcome: the run never asked for a decision");
  assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
  assert.equal(outcome.resultText, "  I need you to decide between renaming the column or keeping both.  ", "the text stays available to the caller");
});

test("a real failure never gets the warning of a silent stop, because that text claims a clean exit", () => {
  for (const ending of [{ exitCode: 1 }, { exitCode: 0, timedOut: true }, { exitCode: 0, idleTimedOut: true }]) {
    const outcome = classifyJobResult({ log: "", ...ending });
    assert.equal(outcome.status, "failed", JSON.stringify(ending));
    assert.notEqual(outcome.noticeMd, SILENT_STOP_NOTICE, JSON.stringify(ending));
  }
});

test("a pull request URL in any text, delivered or cited, never makes a pull request", () => {
  const texts = [
    `Done. Pull request: ${PR_URL}`,
    "I could not finish the migration. For reference, a similar fix was done in https://github.com/acme/api/pull/1 on another repo.",
    ["Here is the shape of the link you will get once the checks pass:", "```", "https://github.com/acme/api/pull/1", "```"].join("\n"),
    "Failed to open pull request: https://github.com/acme/api/pull/12 returned 404 Not Found.",
    "See https://github.com/other-org/other-repo/pull/999 for context.",
  ];
  for (const text of texts) {
    const outcome = classifyResultText(text);
    assert.equal(outcome.status, "failed", text);
    assert.equal(outcome.prUrl, null, text);
  }
  const intermediate = classifyJobResult({ log: intermediateDeliveryStream(), exitCode: 0 });
  assert.deepEqual([intermediate.status, intermediate.prUrl], ["failed", null], "a delivery line in an intermediate message is text too");
  const stream = classifyJobResult({ log: streamOf(`Record: PR ${PR_URL}`, "Stopped."), exitCode: 0 });
  assert.equal(stream.prUrl, null);
});

test("the pull request the HOST published is the run's when nothing recorded one, and the text never moves it", () => {
  const cited = "https://github.com/acme/api/pull/1";
  const log = toNdjson([systemInitEvent(), codeChangePublishedEvent(), resultEvent({ text: `Done. Pull request: ${cited}` })]);

  const outcome = classifyJobResult({ log, exitCode: 0, state: stateWith({ status: "done", notice: "open" }) });
  assert.equal(outcome.prUrl, PR_URL, "the URL the host published lost to what the agent wrote afterwards");
  assert.equal(outcome.status, "done");
});

test("the runtime record outranks a publication, and the publication is no longer named in the notice", () => {
  const recorded = "https://github.com/acme/api/pull/1";
  const log = toNdjson([systemInitEvent(), codeChangePublishedEvent(), resultEvent({ text: "Finished." })]);

  const outcome = classifyJobResult({ log, exitCode: 0, state: stateWith({ status: "done", prUrl: recorded, notice: "open" }) });
  assert.equal(outcome.prUrl, recorded);
  assert.equal(outcome.status, "done");
  assert.equal(outcome.noticeMd, "open");
});

test("a published event whose url is not a pull request is not a source", () => {
  const published = codeChangePublishedEvent({ url: "https://github.com/acme/api/issues/9" });
  const log = toNdjson([systemInitEvent(), published, resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
  const recorded = classifyJobResult({ log, exitCode: 0, state: stateWith({ status: "done", prUrl: PR_URL }) });
  assert.equal(recorded.prUrl, PR_URL, "the runtime's own record was skipped for a url it cannot read");
  assert.equal(recorded.status, "done");

  const unrecorded = classifyJobResult({ log, exitCode: 0 });
  assert.equal(unrecorded.prUrl, null);
});

test("the outcome the pipeline recorded in state.json alone decides, whatever the stream printed", () => {
  const silent = classifyJobResult({
    log: streamOf("Everything is committed.", "Done, nothing else to say."),
    exitCode: 0,
    state: stateWith({ status: "done", prUrl: PR_URL, updatedAt: "2026-09-14T00:00:00Z" }),
  });
  assert.equal(silent.status, "done", "the record carries the URL the stream never printed");
  assert.equal(silent.prUrl, PR_URL);
  assert.equal(silent.noticeMd, null, "the record carries no notice and the stream lends it none");

  const gated = classifyJobResult({
    log: doneStream({ notice: `${GATE_MARKER}\n\nThe stream explains the whole thing.` }),
    exitCode: 0,
    state: stateWith({ status: "gate", notice: "Choose between renaming the column or keeping both." }),
  });
  assert.equal(gated.status, "gate");
  assert.equal(gated.noticeMd, "Choose between renaming the column or keeping both.", "the stream's `## Notice` is not a source of the notice");
});

test("a recorded gate with no notice is a failure that says so, even with a `## Notice` in the stream", () => {
  for (const log of ["", doneStream({ notice: `${GATE_MARKER}\n\nOnly the stream said why.` })]) {
    const outcome = classifyJobResult({ log, exitCode: 0, state: stateWith({ status: "gate" }) });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.noticeMd, GATE_WITHOUT_NOTICE);
  }
});

test("a record the runtime cannot believe speaks for nothing: the run ended without recording an outcome", () => {
  const broken = [
    null,
    "done",
    [],
    { status: "failed", prUrl: "not a url" },
    { status: "merged" },
    { status: "done", prUrl: "https://example.com/not-a-pull-request" },
    { status: "done", prUrl: 42 },
    { notice: "   " },
  ];
  for (const outcome of broken) {
    const classified = classifyJobResult({ log: doneStream(), exitCode: 0, state: stateWith(outcome) });
    assert.equal(classified.status, "failed", JSON.stringify(outcome));
    assert.equal(classified.prUrl, null, JSON.stringify(outcome));
    assert.equal(classified.noticeMd, SILENT_STOP_NOTICE, JSON.stringify(outcome));
  }
});

test("the recorded outcome never beats how the process ended: a file turns no killed or crashed run into done", () => {
  const record = stateWith({ status: "done", prUrl: PR_URL });
  assert.equal(classifyJobResult({ log: "", exitCode: 1, state: record }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: 0, timedOut: true, state: record }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: 0, idleTimedOut: true, state: record }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: -1, stopped: true, state: record }).status, "cancelled");
});

test("a runtime kill is always a failure, whatever the notice, the recorded outcome or a pull request say", () => {
  const plain = classifyJobResult({ log: killedStream({ resultText: "Verifier running. Waiting for its verdict." }), exitCode: 0 });
  assert.equal(plain.status, "failed");
  assert.equal(plain.noticeMd, 'runtime: the CLI killed the background task "task_kill" after its wait ceiling; the run did not finish');

  const gated = classifyJobResult({
    log: killedStream({ resultText: "Verifier running." }),
    exitCode: 0,
    state: stateWith({ status: "gate", notice: "Decide between A and B." }),
  });
  assert.equal(gated.status, "failed", "a recorded gate must not survive a runtime kill");
  assert.equal(gated.noticeMd, 'runtime: the CLI killed the background task "task_kill" after its wait ceiling; the run did not finish after recording a gate: Decide between A and B.');

  const withPr = classifyJobResult({ log: killedStream({ resultText: "Finished." }), exitCode: 0, state: stateWith({ status: "done", prUrl: PR_URL }) });
  assert.equal(withPr.status, "failed", "a delivered pull request must not turn a killed run into done");
  assert.equal(withPr.prUrl, PR_URL, "the pull request is still reported even though the run is marked failed");
});

test("the backoff grows by three and stops at one minute", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [5000, 15000, 45000, 60000, 60000]);
  assert.equal(backoffMs(0), 5000);
  assert.equal(backoffMs("not a number"), 5000);
});
