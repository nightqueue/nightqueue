import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictStep, mergeStep, preflightStep } from "../../src/queue/close.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, gitOk, HEAD_SHA, NO_CHECKS, openPr, PUSHED_SHA } from "../../test-support/close.mjs";

// Regression net for a re-run after the head moved (QA H2): no run ever merges a head that neither the suite nor CI verified.

const STEPS = [
  ["preflight", preflightStep],
  ["conflict", conflictStep],
  ["merge", mergeStep],
];

// The context one step reads when it is called on its own.
function ctxFor(data = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => 600000, signal: new AbortController().signal, warning: null, data };
}

// Runs preflight, conflict and merge in order, folding each result's data as the engine does, until one fails.
async function runOnce(fake, data) {
  let folded = { ...data };
  for (const [name, step] of STEPS) {
    const result = await step({ ctx: ctxFor(folded), deps: fake.deps });
    folded = { ...folded, ...(result.data ?? {}) };
    if (result.status === "failed") return { failedAt: name, reason: result.reason, data: folded };
  }
  return { failedAt: null, reason: null, data: folded };
}

test("runs after the head moved from the one this close pushed never merge it while its suite is red, and merge it once the suite is green", async () => {
  const fake = fakeCloseDeps({ reads: [openPr(), openPr(), openPr()], checks: NO_CHECKS, suite: { ok: false, output: "not ok 1", timedOut: false } });
  fake.world.git["rev-parse HEAD"] = gitOk(`${HEAD_SHA}\n`);
  assert.equal(typeof fake.deps.gh.prMerge, "function", "the fake gh has no merge");

  const first = await runOnce(fake, { headSha: PUSHED_SHA, pushedBy: "close" });
  assert.deepEqual([first.failedAt, first.reason], ["merge", "suite-red"]);
  const second = await runOnce(fake, first.data);
  assert.deepEqual([second.failedAt, second.reason], ["merge", "suite-red"]);
  assert.equal(fake.log.tests.length, 2);
  assert.equal(fake.log.merges.length, 0, "an unverified head was merged");
  assert.equal(second.data.verifiedSha, undefined);

  fake.world.suite = { ok: true, output: "", timedOut: false };
  const third = await runOnce(fake, second.data);
  assert.equal(third.failedAt, null, third.reason);
  assert.equal(third.data.verifiedSha, HEAD_SHA);
  assert.deepEqual(fake.log.merges.map((call) => call.matchHeadCommit), [HEAD_SHA]);
});
