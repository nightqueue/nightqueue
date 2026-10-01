import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictStep, mergeStep, preflightStep } from "../../src/queue/close.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, HEAD_SHA, openPr } from "../../test-support/close.mjs";

// Regression net for an open pull request GitHub answers without a head commit (QA G3): it is unreadable on every path, --force included.

// The context one step reads when it is called on its own.
function ctxFor(data = {}, changes = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => 600000, signal: new AbortController().signal, warning: null, data, ...changes };
}

const CASES = [
  ["plain", { headSha: HEAD_SHA }, {}],
  ["force", { headSha: HEAD_SHA }, { force: true }],
  ["pushedBy close", { headSha: HEAD_SHA, pushedBy: "close" }, {}],
];

for (const [name, data, changes] of CASES) {
  for (const bad of [null, ""]) {
    test(`an empty head never merges unpinned: ${name} / ${JSON.stringify(bad)}`, async () => {
      const fake = fakeCloseDeps({ pr: openPr({ headRefOid: bad }) });
      assert.equal(typeof fake.deps.gh.prMerge, "function", "the fake gh has no merge");
      const result = await mergeStep({ ctx: ctxFor(data, changes), deps: fake.deps });
      assert.equal(fake.log.merges.length, 0);
      assert.notEqual(result.status, "done");
      assert.equal(result.reason, "pr-unreadable");
      assert.notEqual(result.data?.headSha, null, "an empty head was recorded");
    });
  }
}

test("preflight and conflict stop at pr-unreadable on an empty head, --force included", async () => {
  for (const force of [false, true]) {
    for (const bad of [null, ""]) {
      const preflight = await preflightStep({ ctx: ctxFor({}, { force }), deps: fakeCloseDeps({ pr: openPr({ headRefOid: bad }) }).deps });
      assert.equal(preflight.reason, "pr-unreadable", `preflight force=${force} head=${JSON.stringify(bad)}`);
      assert.equal("headSha" in (preflight.data ?? {}), false);
      const conflict = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }, { force }), deps: fakeCloseDeps({ pr: openPr({ headRefOid: bad }) }).deps });
      assert.equal(conflict.reason, "pr-unreadable", `conflict force=${force} head=${JSON.stringify(bad)}`);
    }
  }
});
