import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyJobResult } from "../../src/queue/classify.mjs";
import { extractPrUrl, extractResultText } from "../../src/queue/stream.mjs";
import { intermediateDeliveryStream, PR_URL } from "../../test-support/streams.mjs";

// Job #17's exact shape: the PR delivery and the notice sit ONLY in an intermediate orchestrator
// message (a table row ending in `|` plus a `Record: • PR <url>` line as the last line of that
// message), and the trailing `result` event carries neither. exitCode is 0.
test("a job whose PR delivery lives only in an intermediate message, with a table row ending in `|` earlier in it, still classifies as done with the real URL", () => {
  const log = intermediateDeliveryStream();

  // Documents WHY the whole-stream fallback is load-bearing: the trailing `result` text alone,
  // read in isolation the way the pre-fix code did, carries no URL at all.
  const resultText = extractResultText(log) ?? "";
  assert.equal(extractPrUrl(resultText), null, "the final result text mentions no PR by itself");

  const outcome = classifyJobResult({ log, exitCode: 0 });
  assert.equal(outcome.status, "done", "the run really delivered a PR and must not be gated");
  assert.equal(outcome.prUrl, PR_URL);
});

test("the table row ending in `|` never supplies the URL by itself: only the `Record: • PR <url>` line delivers", () => {
  // Same message, but the closing `Record:` line denies the delivery while the table row (which
  // still ends in `|` and still mentions the URL) is untouched — if the table cell were ever
  // treated as a delivery, this would wrongly classify as done.
  const log = intermediateDeliveryStream({ delivered: false });

  const outcome = classifyJobResult({ log, exitCode: 0 });
  assert.equal(outcome.prUrl, null, "a table cell ending in a pipe must never count as a delivery");
  assert.equal(outcome.status, "gate");
});
