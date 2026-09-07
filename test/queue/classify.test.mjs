import assert from "node:assert/strict";
import { test } from "node:test";
import { backoffMs, classifyJobResult, isTransientFailure } from "../../src/queue/classify.mjs";
import {
  doneStream,
  failureStream,
  gateStream,
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

test("a clean exit with nothing to deliver asks for a human instead of failing silently", () => {
  const outcome = classifyJobResult({ log: doneStream().replace(PR_URL, "no link here"), exitCode: 0 });
  assert.equal(outcome.status, "gate");
  assert.equal(outcome.prUrl, null);
  assert.equal(classifyJobResult({ log: "", exitCode: 0 }).status, "gate");
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
