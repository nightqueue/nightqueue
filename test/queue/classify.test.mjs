import assert from "node:assert/strict";
import { test } from "node:test";
import { SILENT_STOP_NOTICE, backoffMs, classifyJobResult, isTransientFailure } from "../../src/queue/classify.mjs";
import {
  assistantEvent,
  codeChangePublishedEvent,
  doneStream,
  failureStream,
  gateStream,
  intermediateDeliveryStream,
  PR_URL,
  resultEvent,
  systemInitEvent,
  toNdjson,
  transientFailureStream,
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

test("a run that opened a pull request is done, with the URL and the notice extracted", () => {
  const outcome = classifyJobResult({ log: doneStream({ notice: "the pull request is open" }), exitCode: 0 });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.prUrl, PR_URL);
  assert.equal(outcome.noticeMd, "the pull request is open");
});

test("the gate marker beats the pull request URL: a run waiting on a human is never done", () => {
  assert.equal(classifyJobResult({ log: gateStream(), exitCode: 0 }).status, "gate");
  const both = doneStream().replace("Opening the pull request now.", "## Requires user confirmation");
  const outcome = classifyJobResult({ log: both, exitCode: 0 });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.prUrl, PR_URL, "the URL is still recorded on a gate");
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

test("a clean exit with nothing to deliver asks for a human, and says why it is asking", () => {
  const outcome = classifyJobResult({ log: doneStream().replace(PR_URL, "no link here"), exitCode: 0 });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.prUrl, null);
  assert.ok(outcome.noticeMd, "a gate without a reason is exactly the bug this classification exists to prevent");
});

test("a clean exit that said nothing at all is a failure with the fixed warning, never a silent gate", () => {
  const outcome = classifyJobResult({ log: "", exitCode: 0 });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
});

test("a run without a `## Notice` falls back to the whole final text of the orchestrator, capped at eight thousand code points", () => {
  const outcome = classifyResultText("  I need you to decide between renaming the column or keeping both.  ");
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.noticeMd, "I need you to decide between renaming the column or keeping both.");

  const long = classifyResultText("a".repeat(9000));
  assert.equal(long.status, "gate");
  assert.equal(Array.from(long.noticeMd).length, 8003, "the fallback notice was not capped");
  assert.equal(long.noticeMd.endsWith("..."), true);
});

test("a real failure never gets the warning of a silent stop, because that text claims a clean exit", () => {
  for (const ending of [{ exitCode: 1 }, { exitCode: 0, timedOut: true }, { exitCode: 0, idleTimedOut: true }]) {
    const outcome = classifyJobResult({ log: "", ...ending });
    assert.equal(outcome.status, "failed", JSON.stringify(ending));
    assert.equal(outcome.noticeMd, null, JSON.stringify(ending));
  }
});

test("a pull request URL cited only as a reference, with no PR actually opened, is never done", () => {
  const outcome = classifyResultText(
    "I could not finish the migration in the time I had. For reference, a similar fix was done in " +
      "https://github.com/acme/api/pull/1 on another repo, but I did not open a pull request here.",
  );
  assert.equal(outcome.status, "gate", "no PR was opened, so a human must look at this run instead of it reporting done");
});

test("a pull request URL quoted inside a fenced code example is never treated as an opened PR", () => {
  const outcome = classifyResultText(
    ["Here is the shape of the link you will get once the checks pass:", "```", "https://github.com/acme/api/pull/1", "```", "I have not opened it yet."].join("\n"),
  );
  assert.equal(outcome.status, "gate", "the URL is a fenced example, not a real pull request that was opened");
});

test("a pull request URL appearing inside a failure message is never treated as an opened PR", () => {
  const outcome = classifyResultText("Failed to open pull request: https://github.com/acme/api/pull/12 returned 404 Not Found.");
  assert.equal(outcome.status, "gate", "the URL comes from an error message, not from a pull request that exists");
});

test("a foreign pull request URL cited by number, belonging to someone else's repo, is never treated as ours", () => {
  const outcome = classifyResultText(
    "This looks related to an already merged community fix, see https://github.com/other-org/other-repo/pull/999 " +
      "for context. I have not made any change in this repository.",
  );
  assert.equal(outcome.status, "gate", "citing someone else's pull request is not the same as opening one in this run");
});

test("a pull request delivered in an intermediate message is the outcome, even when the final text mentions neither", () => {
  const outcome = classifyJobResult({ log: intermediateDeliveryStream(), exitCode: 0 });
  assert.equal(outcome.status, "done", "the run really opened a pull request and was recorded as a gate");
  assert.equal(outcome.prUrl, PR_URL);
  assert.ok(outcome.noticeMd.startsWith("The pull request is open"), outcome.noticeMd);
});

test("a URL mentioned only inside a markdown table cell is never a delivery, wherever the cell is", () => {
  const outcome = classifyJobResult({ log: intermediateDeliveryStream({ delivered: false }), exitCode: 0 });
  assert.equal(outcome.prUrl, null, "a table cell ends with a pipe: it mentions the URL, it does not deliver it");
  assert.equal(outcome.status, "gate");
});

test("the whole-stream fallback keeps every rule of a delivery: a citation, a denial and a fence are still refused", () => {
  const cited = classifyJobResult({ log: streamOf(`The ticket references ${PR_URL} for context.`, "I could not finish."), exitCode: 1 });
  assert.equal(cited.status, "failed");
  assert.equal(cited.prUrl, null);

  const denied = classifyJobResult({ log: streamOf(`I could not open ${PR_URL}`, "Stopped."), exitCode: 0 });
  assert.equal(denied.prUrl, null);

  const fenced = classifyJobResult({ log: streamOf(["The link will look like:", "```", PR_URL, "```"].join("\n"), "Stopped."), exitCode: 0 });
  assert.equal(fenced.prUrl, null);
});

test("the pull request the HOST published wins over every text: a contradicting final line never moves it", () => {
  const cited = "https://github.com/acme/api/pull/1";
  const log = toNdjson([
    systemInitEvent(),
    codeChangePublishedEvent(),
    resultEvent({ text: `I could not open the pull request. For reference, the old one is ${cited}` }),
  ]);

  const outcome = classifyJobResult({ log, exitCode: 0, state: stateWith({ status: "done", prUrl: cited }) });
  assert.equal(outcome.prUrl, PR_URL, "the URL the host published lost to what the agent wrote afterwards");
  assert.equal(outcome.status, "done");
});

test("a text that denies the delivery, with no published event, delivers no pull request at all", () => {
  const outcome = classifyResultText(`Failed to open pull request: ${PR_URL} returned 404 Not Found.`);
  assert.equal(outcome.prUrl, null, "a denial was read as a delivery");
  assert.equal(outcome.status, "gate");
});

test("a published event whose url is not a pull request falls through to the next source of the chain", () => {
  const published = codeChangePublishedEvent({ url: "https://github.com/acme/api/issues/9" });
  const recorded = classifyJobResult({
    log: toNdjson([systemInitEvent(), published, resultEvent({ text: "Done, nothing else to say." })]),
    exitCode: 0,
    state: stateWith({ status: "done", prUrl: PR_URL }),
  });
  assert.equal(recorded.prUrl, PR_URL, "the runtime's own record was skipped for a url it cannot read");
  assert.equal(recorded.status, "done");

  const fromText = classifyJobResult({ log: toNdjson([systemInitEvent(), published, resultEvent({ text: `Done. Pull request: ${PR_URL}` })]), exitCode: 0 });
  assert.equal(fromText.prUrl, PR_URL, "the text heuristic, the last source, was skipped");
});

test("the outcome the pipeline recorded in state.json wins over the stream, field by field", () => {
  const silent = classifyJobResult({
    log: streamOf("Everything is committed.", "Done, nothing else to say."),
    exitCode: 0,
    state: stateWith({ status: "done", prUrl: PR_URL, updatedAt: "2026-09-14T00:00:00Z" }),
  });
  assert.equal(silent.status, "done", "the record carries the URL the stream never printed");
  assert.equal(silent.prUrl, PR_URL);

  const gated = classifyJobResult({
    log: doneStream(),
    exitCode: 0,
    state: stateWith({ status: "gate", notice: "Choose between renaming the column or keeping both." }),
  });
  assert.equal(gated.status, "gate", "a recorded gate is not undone by a URL in the stream");
  assert.equal(gated.noticeMd, "The pull request is open and the checks are green.", "the `## Notice` of the run now outranks the summary the record carries");
  assert.equal(gated.prUrl, PR_URL, "the URL is still recorded on a gate");
});

test("the `## Notice` the run wrote beats the summary the pipeline recorded in state.json", () => {
  const outcome = classifyJobResult({
    log: doneStream({ notice: "The stream explains the whole thing." }),
    exitCode: 0,
    state: stateWith({ status: "gate", notice: "Short summary the pipeline wrote." }),
  });
  assert.equal(outcome.noticeMd, "The stream explains the whole thing.");
});

test("a run that printed no `## Notice` keeps the summary recorded in state.json, never the whole final text", () => {
  const outcome = classifyJobResult({
    log: streamOf("Working on it.", "Stopped without a heading."),
    exitCode: 0,
    state: stateWith({ status: "gate", notice: "Decide between A and B." }),
  });
  assert.equal(outcome.noticeMd, "Decide between A and B.");
  assert.notEqual(outcome.noticeMd, "Stopped without a heading.", "the whole final text is the last resort, never above the record");
});

test("a run whose `## Notice` is the only explanation anywhere is the notice itself", () => {
  const outcome = classifyJobResult({
    log: doneStream({ notice: "Only the stream said why." }),
    exitCode: 0,
    state: stateWith({ status: "gate" }),
  });
  assert.equal(outcome.noticeMd, "Only the stream said why.");
});

test("a clean stop with no explanation in the stream nor in state.json is still the fixed warning", () => {
  const outcome = classifyJobResult({
    log: toNdjson([systemInitEvent(), resultEvent({ text: "" })]),
    exitCode: 0,
    state: stateWith({ status: "gate" }),
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
});

test("the notice changing source moves neither the status nor the pull request URL, which state.json still rules", () => {
  const RECORDED_PR_URL = "https://github.com/acme/api/pull/7";
  const outcome = classifyJobResult({
    log: doneStream({ notice: "The stream explains it whole." }),
    exitCode: 0,
    state: stateWith({ status: "gate", prUrl: RECORDED_PR_URL, notice: "Short summary." }),
  });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.prUrl, RECORDED_PR_URL, "the recorded URL still outranks the one the stream printed");
  assert.equal(outcome.noticeMd, "The stream explains it whole.");
});

test("a record the runtime cannot believe changes nothing: the stream decides exactly as it does today", () => {
  const broken = [
    null,
    "done",
    [],
    { status: "failed", prUrl: PR_URL },
    { status: "merged" },
    { status: "done", prUrl: "https://example.com/not-a-pull-request" },
    { status: "done", prUrl: 42 },
    { notice: "   " },
  ];
  for (const outcome of broken) {
    const classified = classifyJobResult({ log: intermediateDeliveryStream(), exitCode: 0, state: stateWith(outcome) });
    assert.equal(classified.status, "done", JSON.stringify(outcome));
    assert.equal(classified.prUrl, PR_URL, JSON.stringify(outcome));
  }
});

test("the recorded outcome never beats how the process ended: a file turns no killed or crashed run into done", () => {
  const record = stateWith({ status: "done", prUrl: PR_URL });
  assert.equal(classifyJobResult({ log: "", exitCode: 1, state: record }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: 0, timedOut: true, state: record }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: 0, idleTimedOut: true, state: record }).status, "failed");
  assert.equal(classifyJobResult({ log: "", exitCode: -1, stopped: true, state: record }).status, "cancelled");
});

test("a recorded gate with no reason anywhere is still a failure with the fixed warning, never a silent gate", () => {
  const outcome = classifyJobResult({ log: "", exitCode: 0, state: stateWith({ status: "gate" }) });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.noticeMd, SILENT_STOP_NOTICE);
});

test("only a transient provider failure is worth another attempt", () => {
  assert.equal(isTransientFailure(transientFailureStream()), true);
  assert.equal(isTransientFailure("API Error: 529 Overloaded"), true);
  assert.equal(isTransientFailure("rate_limit_error"), true);
  assert.equal(isTransientFailure("Error: connection error"), true);
  assert.equal(isTransientFailure("read ECONNRESET"), true);
  assert.equal(isTransientFailure("TypeError: fetch failed"), true);
  assert.equal(isTransientFailure(failureStream()), false);
  assert.equal(isTransientFailure("HTTP 404 Not Found"), false);
  assert.equal(isTransientFailure(""), false);
  assert.equal(isTransientFailure(null), false);
});

test("the backoff grows by three and stops at one minute", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [5000, 15000, 45000, 60000, 60000]);
  assert.equal(backoffMs(0), 5000);
  assert.equal(backoffMs("not a number"), 5000);
});
