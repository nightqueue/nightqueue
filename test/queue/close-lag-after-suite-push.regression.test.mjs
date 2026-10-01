import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeStep } from "../../src/queue/close.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, gitOk, HEAD_SHA, NO_CHECKS, openPr, PUSHED_SHA } from "../../test-support/close.mjs";

// The context of a merge step on a repository without CI.
function ctxFor(data = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => 600000, signal: new AbortController().signal, warning: null, data };
}

// A fake whose first suite push leaves GitHub showing the pre-push head for the given number of reads.
function laggingPushWorld(lagReads) {
  const fake = fakeCloseDeps({ checks: NO_CHECKS });
  let pushes = 0;
  fake.world.git["rev-parse origin/"] = gitOk(`${HEAD_SHA}\n`);
  fake.world.git["rev-parse HEAD"] = gitOk(`${PUSHED_SHA}\n`);
  fake.world.git.push = () => {
    pushes += 1;
    fake.world.pr = openPr({ headRefOid: PUSHED_SHA });
    if (pushes === 1) fake.world.reads = Array.from({ length: lagReads }, () => openPr({ headRefOid: HEAD_SHA }));
    return gitOk();
  };
  return fake;
}

for (const lagReads of [3, 4]) {
  test(`${lagReads} stale reads of the pre-push head after the close's own push are lag, not a head change: one suite run, merge pinned to the pushed head`, async () => {
    const fake = laggingPushWorld(lagReads);
    assert.equal(typeof fake.deps.gh.prMerge, "function");
    const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: fake.deps });
    assert.equal(fake.log.tests.length, 1, `suite ran ${fake.log.tests.length} times for a lag; ${result.reason}: ${result.note}`);
    assert.equal(result.status, "done", `${result.reason}: ${result.note}`);
    assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
  });
}
