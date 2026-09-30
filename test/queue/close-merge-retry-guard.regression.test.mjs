import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeStep } from "../../src/queue/close.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, mergedPr, NO_CHECKS, openPr, PUSHED_SHA, suiteVerifies } from "../../test-support/close.mjs";

// Regression net for the merge retry (QA H1): after a failed pinned merge call, a foreign head with no checks is merged only once the suite ran on it.

const FOREIGN_SHA = "9999999";

// The context the merge step reads when it is called on its own.
function ctxFor(data = {}, changes = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => 600000, signal: new AbortController().signal, warning: null, data, ...changes };
}

// A fake close whose first merge call fails because someone pushed a foreign head no CI reports on; the next call merges.
function retriedWorld(changes = {}) {
  const fake = fakeCloseDeps({ pr: openPr({ headRefOid: PUSHED_SHA }), ...changes });
  assert.equal(typeof fake.deps.gh.prMerge, "function", "the fake gh has no merge");
  fake.world.merge = (world) => {
    if (fake.log.merges.length === 1) {
      world.pr = openPr({ headRefOid: FOREIGN_SHA });
      world.checks = NO_CHECKS;
      return { ok: false, stderr: "head ref oid does not match" };
    }
    world.pr = mergedPr();
    return { ok: true, stderr: "" };
  };
  return fake;
}

const VERIFIED = { headSha: PUSHED_SHA, pushedBy: "close", verifiedSha: PUSHED_SHA };

test("a merge retry never merges a foreign head no CI reports on when its suite is red", async () => {
  const fake = retriedWorld({ suite: { ok: false, output: "not ok 1", timedOut: false } });
  suiteVerifies(fake, FOREIGN_SHA);
  const result = await mergeStep({ ctx: ctxFor(VERIFIED), deps: fake.deps });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "suite-red");
  assert.deepEqual(fake.log.merges.map((call) => call.matchHeadCommit), [PUSHED_SHA]);
  assert.equal(result.data.verifiedSha, undefined, "a red suite recorded a verified head");
});

test("a merge retry runs the suite on the foreign head and merges it pinned to the head the suite verified", async () => {
  const fake = suiteVerifies(retriedWorld(), FOREIGN_SHA);
  const result = await mergeStep({ ctx: ctxFor(VERIFIED), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(fake.log.merges.map((call) => call.matchHeadCommit), [PUSHED_SHA, FOREIGN_SHA]);
  assert.equal(fake.log.tests.length, 1);
  assert.equal(result.data.verifiedSha, FOREIGN_SHA);
});
