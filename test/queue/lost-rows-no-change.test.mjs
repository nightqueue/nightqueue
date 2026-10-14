import assert from "node:assert/strict";
import { test } from "node:test";
import { NO_CHANGE_NEXT_STEP_LINE } from "../../src/queue/classify.mjs";
import { NO_OUTCOME_NOTICE, deriveRecovered } from "../../src/queue/lost-rows.mjs";

const CONCLUSION = "✅ Resolved — no code change needed\n\nThe cause is a setting of the payment provider.";
const NOTICE = `${CONCLUSION}\n\n${NO_CHANGE_NEXT_STEP_LINE}`;

// A disk entry of a lost job with no log, carrying the outcome its pipeline recorded.
function entryWith(outcome, terminal = null) {
  return { jobId: 7, projectId: "p-1", slug: "fix-the-loop", state: { outcome }, outcome, terminal, hasLog: false };
}

test("a lost job whose pipeline recorded no_change with its conclusion recovers as done with no pull request, marked, with the next-step line", () => {
  assert.deepEqual(deriveRecovered(entryWith({ status: "no_change", notice: CONCLUSION })), {
    status: "done",
    noticeMd: NOTICE,
    prUrl: null,
    resolution: "no-change",
  });
});

test("a lost job whose witness carries the no-change marker recovers marked, with the next-step line once", () => {
  const recovered = deriveRecovered(entryWith({ status: "no_change", notice: NOTICE }, { status: "done", prUrl: null, resolution: "no-change" }));
  assert.deepEqual(recovered, { status: "done", noticeMd: NOTICE, prUrl: null, resolution: "no-change" });
});

test("a lost job whose witness is done with no pull request and no no-change record recovers unmarked", () => {
  const recovered = deriveRecovered(entryWith({ status: "done", notice: CONCLUSION }, { status: "done", prUrl: null }));
  assert.deepEqual(recovered, { status: "done", noticeMd: CONCLUSION, prUrl: null });
});

test("a lost job whose no_change carries no conclusion recovers as a failure that says the run left no outcome", () => {
  assert.deepEqual(deriveRecovered(entryWith({ status: "no_change" })), { status: "failed", noticeMd: NO_OUTCOME_NOTICE, prUrl: null });
});

test("the runner's witness still outranks a no_change record", () => {
  const recovered = deriveRecovered(entryWith({ status: "no_change", notice: CONCLUSION }, { status: "cancelled" }));
  assert.equal(recovered.status, "cancelled");
  assert.equal(recovered.resolution, undefined);
});
