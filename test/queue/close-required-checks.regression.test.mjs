import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictStep, mergeStep, preflightStep, settleStep } from "../../src/queue/close.mjs";
import { fakeCloseDeps, HEAD_SHA, openPr, PUSHED_SHA } from "../../test-support/close.mjs";

const PR_URL = "https://github.com/maykonVinicius/clareza-gestao-app/pull/94";
const REPO = "maykonVinicius/clareza-gestao-app";
const RUN_ID = "38789810171";
const jobUrl = (job) => `https://github.com/${REPO}/actions/runs/${RUN_ID}/job/${job}`;
const TEST_URL = jobUrl(1);
const TYPECHECK_URL = jobUrl(2);
const LINT_URL = jobUrl(3);
const TEST_AGAIN_URL = jobUrl(4);

// One check of the rollup as the close reads it.
function check(name, bucket, detailsUrl, workflowName = "CI") {
  return { name, bucket, detailsUrl, workflowName };
}

// A checks read of the head, its name lists derived from the checks.
function rollup(checks) {
  const named = (bucket) => checks.filter((entry) => entry.bucket === bucket).map((entry) => entry.name);
  return { ok: true, checks, failing: named("fail"), pending: named("pending"), aborted: named("aborted"), headSha: HEAD_SHA };
}

// The answer of `gh pr checks --required` naming the given checks.
function required(checks) {
  return { ok: true, declared: true, checks: checks.map((entry) => ({ name: entry.name, link: entry.detailsUrl ?? null })) };
}

const TEST_OK = check("test", "pass", TEST_URL);
const TYPECHECK_OK = check("typecheck", "pass", TYPECHECK_URL);
const LINT_RED = check("lint", "fail", LINT_URL);
const J203 = rollup([TEST_OK, TYPECHECK_OK, LINT_RED]);
const J203_REQUIRED = required([TEST_OK, TYPECHECK_OK]);

const clock = { remainingMs: 600000 };

// The fake gh, git and npm of a close, whose sleeps spend the close's remaining time.
function fakeDeps(changes) {
  const fake = fakeCloseDeps(changes);
  clock.remainingMs = 600000;
  fake.deps.sleep = async (ms) => {
    clock.remainingMs -= ms;
    fake.log.sleeps.push(ms);
  };
  return fake;
}

// The context one step reads when it is called on its own, for the J-203 pull request.
function ctxFor(data = {}, changes = {}) {
  return { jobId: 203, prUrl: PR_URL, prNumber: 94, project: "clareza", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/clareza", remainingMs: () => clock.remainingMs, signal: new AbortController().signal, warning: null, data, ...changes };
}

// Runs one step and keeps its data in the context, as the close pipeline does.
async function step(fn, ctx, deps) {
  const result = await fn({ ctx, deps });
  if (result.data) Object.assign(ctx.data, result.data);
  return result;
}

test("J-203: a red non-required check beside green required ones closes, is never re-run and is named in the notice", async () => {
  const fake = fakeDeps({ pr: openPr({ mergeStateStatus: "UNSTABLE" }), checks: J203, requiredChecks: J203_REQUIRED });
  const ctx = ctxFor();
  const preflight = await step(preflightStep, ctx, fake.deps);
  assert.equal(preflight.status, "done", preflight.note);
  assert.match(preflight.note, /2 checks green; non-required checks failing: lint/);
  assert.deepEqual(fake.log.reruns, []);
  assert.ok(fake.log.requiredReads >= 1);
  const conflict = await step(conflictStep, ctx, fake.deps);
  assert.equal(conflict.status, "skipped");
  assert.match(conflict.note, /mergeable \(UNSTABLE\)/);
  const merge = await step(mergeStep, ctx, fake.deps);
  assert.equal(merge.status, "done", merge.note);
  assert.equal(fake.log.merges.length, 1);
  const settle = await step(settleStep, ctx, fake.deps);
  assert.match(settle.data.noticeLine, /^Closed: PR #94 merged as abc1234 on .+; non-required checks failing: lint$/);
  assert.deepEqual(fake.log.reruns, []);
});

test("a red required check is re-run once against the pull request's repository and stops as failed twice when it fails again", async () => {
  const first = rollup([check("test", "fail", TEST_URL), TYPECHECK_OK, LINT_RED]);
  const again = rollup([check("test", "fail", TEST_AGAIN_URL), TYPECHECK_OK, LINT_RED]);
  const fake = fakeDeps({
    checkReads: [first],
    checks: again,
    requiredReads: [required([first.checks[0], TYPECHECK_OK])],
    requiredChecks: required([again.checks[0], TYPECHECK_OK]),
  });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.deepEqual(fake.log.reruns, [{ runId: RUN_ID, repo: REPO, failed: true }]);
  assert.equal(result.reason, "checks-red");
  assert.match(result.note, /check test failed twice on 1111111; re-run it by hand: gh run rerun 38789810171 --repo maykonVinicius\/clareza-gestao-app --failed/);
  assert.doesNotMatch(result.note, /lint/);
  assert.equal(fake.log.merges.length, 0);
});

test("a repository that declares no required checks gates on every check as before, and its re-run names the pull request's repository", async () => {
  const fake = fakeDeps({ checks: J203, rerun: () => ({ ok: false, error: `HTTP 404: Not Found (https://api.github.com/repos/nightqueue/nightqueue/actions/runs/${RUN_ID})` }) });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.deepEqual(fake.log.reruns, [{ runId: RUN_ID, repo: REPO, failed: true }]);
  assert.equal(result.reason, "checks-red");
  assert.match(result.note, /^gh run rerun 38789810171 --repo maykonVinicius\/clareza-gestao-app --failed failed for lint \(HTTP 404/);
  assert.doesNotMatch(result.note, /non-required/);
});

test("an unreadable required set, or a required check the rollup does not show, gates on every check", async () => {
  for (const requiredChecks of [{ ok: false, error: "HTTP 502" }, required([TEST_OK, check("e2e", "pass", jobUrl(9))])]) {
    const fake = fakeDeps({ checks: J203, requiredChecks, rerun: () => ({ ok: false, error: "refused" }) });
    const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
    assert.equal(result.reason, "checks-red", JSON.stringify(requiredChecks));
    assert.equal(result.note, `gh run rerun ${RUN_ID} --repo ${REPO} --failed failed for lint (refused)`);
    assert.equal(fake.log.reruns.length, 1);
  }
});

test("a non-required check still running is not waited on once the required ones are green", async () => {
  const fake = fakeDeps({ checks: rollup([TEST_OK, TYPECHECK_OK, check("lint", "pending", LINT_URL)]), requiredChecks: J203_REQUIRED });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.match(result.note, /2 checks green/);
  assert.deepEqual(fake.log.sleeps, []);
  assert.deepEqual(fake.log.reruns, []);
});

test("an all-green read never asks gh for the required checks", async () => {
  const fake = fakeDeps({ checks: rollup([TEST_OK, TYPECHECK_OK]), requiredChecks: J203_REQUIRED });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.equal(fake.log.requiredReads, 0);
});

test("a re-run whose details URL names no repository takes the pull request's repository", async () => {
  const fake = fakeDeps({ checks: rollup([check("test", "fail", `/actions/runs/${RUN_ID}/job/1`)]) });
  await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.deepEqual(fake.log.reruns, [{ runId: RUN_ID, repo: REPO, failed: true }]);
});

test("of two checks sharing a name, only the one the required set links gates", async () => {
  const otherTest = check("test", "fail", "https://github.com/maykonVinicius/clareza-gestao-app/actions/runs/777/job/1", "Nightly");
  const fake = fakeDeps({ checks: rollup([TEST_OK, otherTest]), requiredChecks: required([TEST_OK]) });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.match(result.note, /1 checks green; non-required checks failing: test/);
  assert.deepEqual(fake.log.reruns, []);
});

test("a required status context with no details URL is matched by name and gates as red", async () => {
  const legacy = { name: "ci/legacy", bucket: "fail", detailsUrl: null, workflowName: null };
  const fake = fakeDeps({ checks: rollup([TEST_OK, legacy]), requiredChecks: { ok: true, declared: true, checks: [{ name: "ci/legacy", link: "https://ci.example/1" }] } });
  const result = await preflightStep({ ctx: ctxFor(), deps: fake.deps });
  assert.equal(result.reason, "checks-red");
  assert.equal(result.note, "failing checks: ci/legacy");
});

test("a close in flight holding a re-run record of a non-required check neither crashes nor stops as failed twice", async () => {
  const ctx = ctxFor({ rerunFailed: { head: HEAD_SHA, runIds: [RUN_ID], urls: [LINT_URL] } });
  const fake = fakeDeps({ checks: J203, requiredChecks: J203_REQUIRED });
  const result = await preflightStep({ ctx, deps: fake.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(fake.log.reruns, []);
});

test("with --force, the note names the required check ignored and warns about the non-required one", async () => {
  const fake = fakeDeps({ checks: rollup([check("test", "fail", TEST_URL), TYPECHECK_OK, LINT_RED]), requiredChecks: J203_REQUIRED });
  const result = await preflightStep({ ctx: ctxFor({}, { force: true }), deps: fake.deps });
  assert.equal(result.status, "done");
  assert.match(result.note, /checks ignored with --force: failing: test; non-required checks failing: lint/);
  assert.deepEqual(fake.log.reruns, []);
});

test("a warning read on one head is not printed in the notice of a merge of another head where it was never evaluated", async () => {
  const fake = fakeDeps({ pr: openPr({ mergeStateStatus: "UNSTABLE" }), checks: J203, requiredChecks: J203_REQUIRED });
  const ctx = ctxFor();
  const preflight = await step(preflightStep, ctx, fake.deps);
  assert.equal(preflight.status, "done", preflight.note);
  assert.deepEqual(ctx.data.nonRequiredFailing, ["lint"]);
  fake.world.pr = openPr({ mergeStateStatus: "UNSTABLE", headRefOid: PUSHED_SHA });
  fake.world.checks = { ...rollup([]), headSha: PUSHED_SHA };
  await step(conflictStep, ctx, fake.deps);
  const merge = await step(mergeStep, ctx, fake.deps);
  assert.equal(merge.status, "done", merge.note);
  const settle = await step(settleStep, ctx, fake.deps);
  assert.equal(settle.data.noticeLine, "Closed: PR #94 merged as abc1234 on 2026-09-21");
});

test("every gh call of a full close, its re-run included, names the pull request's repository and none relies on a working directory", async () => {
  const first = rollup([check("test", "fail", TEST_URL), TYPECHECK_OK, LINT_RED]);
  const again = rollup([check("test", "pass", TEST_AGAIN_URL), TYPECHECK_OK, LINT_RED]);
  const fake = fakeDeps({
    pr: openPr({ mergeStateStatus: "UNSTABLE" }),
    checkReads: [first],
    checks: again,
    requiredReads: [required([first.checks[0], TYPECHECK_OK])],
    requiredChecks: required([again.checks[0], TYPECHECK_OK]),
  });
  const ctx = ctxFor();
  for (const fn of [preflightStep, conflictStep, mergeStep, settleStep]) {
    const result = await step(fn, ctx, fake.deps);
    assert.notEqual(result.status, "failed", result.note);
  }
  const calls = new Set(fake.log.ghCalls.map((entry) => entry.call));
  for (const call of ["prDetail", "prChecks", "prRequiredChecks", "runRerun", "prMerge"]) assert.ok(calls.has(call), `no ${call} call recorded`);
  for (const entry of fake.log.ghCalls) assert.deepEqual({ repo: entry.repo, cwd: entry.cwd }, { repo: REPO, cwd: null }, entry.call);
});
