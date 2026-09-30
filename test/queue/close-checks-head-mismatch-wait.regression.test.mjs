import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeStep } from "../../src/queue/close.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, HEAD_SHA, NO_CHECKS, WORKFLOWS } from "../../test-support/close.mjs";

const OTHER_HEAD = "9999999aaaaaaaaa";

// The context of a merge step whose remaining time shrinks with every sleep of the fake.
function ctxFor(data, remaining) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => remaining.ms, signal: new AbortController().signal, warning: null, data };
}

test("a checks read gh attributes to another head ends the CI wait at once instead of polling out the budget, merging nothing", async () => {
  const fake = fakeCloseDeps({ git: { ...WORKFLOWS }, checkReads: [NO_CHECKS], checks: { ...NO_CHECKS, headSha: OTHER_HEAD } });
  assert.equal(typeof fake.deps.gh.prMerge, "function");
  const remaining = { ms: 600000 };
  fake.deps.sleep = async (ms) => {
    remaining.ms -= ms;
    fake.log.sleeps.push(ms);
  };
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA }, remaining), deps: fake.deps });
  const slept = fake.log.sleeps.reduce((total, ms) => total + ms, 0);
  assert.equal(fake.log.merges.length, 0);
  assert.equal(result.status, "failed");
  assert.ok(fake.log.sleeps.length <= 3, `polled ${fake.log.sleeps.length} times, slept ${slept} ms, ended ${result.reason}: ${result.note}`);
  assert.equal(result.data.ciGreenSha, undefined, "a head whose checks belong to another head was recorded green");
});
