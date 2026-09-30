import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictStep, mergeStep } from "../../src/queue/close.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, HEAD_SHA, NO_CHECKS, openPr, suiteVerifies } from "../../test-support/close.mjs";

// Regression net for a moved head no check reports on (QA H4): without CI the close runs the suite on it before any merge.

const FOREIGN_SHA = "9999999";

// The context one step reads when it is called on its own.
function ctxFor(data = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => 600000, signal: new AbortController().signal, warning: null, data };
}

test("a foreign head with no checks is tested, then merged pinned to it", async () => {
  const fake = suiteVerifies(fakeCloseDeps({ pr: openPr({ headRefOid: FOREIGN_SHA }), checks: NO_CHECKS }), FOREIGN_SHA);
  assert.equal(typeof fake.deps.gh.prMerge, "function", "the fake gh has no merge");
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.equal(fake.log.tests.length, 1, "the foreign head was merged without the suite");
  assert.deepEqual(fake.log.merges.map((call) => call.matchHeadCommit), [FOREIGN_SHA]);
});

test("a foreign head with no checks and a red suite is never merged", async () => {
  const fake = suiteVerifies(fakeCloseDeps({ pr: openPr({ headRefOid: FOREIGN_SHA }), checks: NO_CHECKS, suite: { ok: false, output: "not ok 1", timedOut: false } }), FOREIGN_SHA);
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fake.deps });
  assert.equal(result.reason, "suite-red");
  assert.equal(fake.log.merges.length, 0);
});

test("conflict never passes the same head as verified on 'no checks reported'", async () => {
  const fake = fakeCloseDeps({ pr: openPr({ headRefOid: FOREIGN_SHA }), checks: NO_CHECKS });
  const result = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fake.deps });
  assert.ok(result.status === "failed" || !/no checks reported/.test(result.note ?? ""), `status=${result.status} note=${result.note}`);
  assert.match(result.note, /the merge step verifies this head/);
});
