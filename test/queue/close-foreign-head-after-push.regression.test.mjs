import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictStep, mergeStep, preflightStep } from "../../src/queue/close.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, gitOk, HEAD_SHA, mergedPr, NO_CHECKS, openPr, PUSHED_SHA, suiteVerifies } from "../../test-support/close.mjs";

const FOREIGN = "9999999";
const PUSHED = { headSha: PUSHED_SHA, pushedBy: "close", verifiedSha: PUSHED_SHA };

// The context of a close step.
function ctxFor(data = {}, changes = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => 600000, signal: new AbortController().signal, warning: null, data, ...changes };
}

// A fake whose first pinned merge fails because someone pushed a foreign head without checks; the next merge succeeds.
function retriedWorld(changes = {}) {
  const fake = fakeCloseDeps({ pr: openPr({ headRefOid: PUSHED_SHA }), ...changes });
  fake.world.merge = (world) => {
    if (fake.log.merges.length === 1) {
      world.pr = openPr({ headRefOid: FOREIGN });
      world.checks = NO_CHECKS;
      return { ok: false, stderr: "head ref oid does not match" };
    }
    world.pr = mergedPr();
    return { ok: true, stderr: "" };
  };
  return fake;
}

test("a foreign head after the close's own push is never merged when its suite is red", async () => {
  const fake = suiteVerifies(retriedWorld({ suite: { ok: false, output: "not ok 1", timedOut: false } }), FOREIGN);
  assert.equal(typeof fake.deps.gh.prMerge, "function");
  const result = await mergeStep({ ctx: ctxFor(PUSHED), deps: fake.deps });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "suite-red");
  assert.deepEqual(fake.log.merges.map((call) => call.matchHeadCommit), [PUSHED_SHA]);
  assert.equal(result.data.verifiedSha, undefined);
});

test("a foreign head after the close's own push is merged pinned to itself after one green suite run", async () => {
  const fake = suiteVerifies(retriedWorld(), FOREIGN);
  const result = await mergeStep({ ctx: ctxFor(PUSHED), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(fake.log.merges.map((call) => call.matchHeadCommit), [PUSHED_SHA, FOREIGN]);
  assert.equal(fake.log.tests.length, 1);
  assert.equal(result.data.verifiedSha, FOREIGN);
});

test("a plain re-run after a stop never merges a head without checks whose suite is red", async () => {
  const fake = fakeCloseDeps({ reads: [openPr(), openPr(), openPr()], checks: NO_CHECKS, suite: { ok: false, output: "not ok 1", timedOut: false } });
  fake.world.git["rev-parse HEAD"] = gitOk(`${HEAD_SHA}\n`);
  const result = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA, pushedBy: null }), deps: fake.deps });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "suite-red");
  assert.equal(fake.log.merges.length, 0);
  assert.equal(result.data?.verifiedSha, undefined);
});

for (const force of [false, true]) {
  for (const empty of [null, ""]) {
    test(`an open pull request with head ${JSON.stringify(empty)} is unreadable on every step (force=${force}) and never merged`, async () => {
      const fake = fakeCloseDeps({ pr: openPr({ headRefOid: empty }) });
      const merge = await mergeStep({ ctx: ctxFor({ headSha: HEAD_SHA, pushedBy: "close" }, { force }), deps: fake.deps });
      assert.equal(merge.reason, "pr-unreadable");
      assert.equal(fake.log.merges.length, 0);
      const preflight = await preflightStep({ ctx: ctxFor({}, { force }), deps: fakeCloseDeps({ pr: openPr({ headRefOid: empty }) }).deps });
      assert.equal(preflight.reason, "pr-unreadable");
      const conflict = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }, { force }), deps: fakeCloseDeps({ pr: openPr({ headRefOid: empty }) }).deps });
      assert.equal(conflict.reason, "pr-unreadable");
    });
  }
}
