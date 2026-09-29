import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { conflictStep, preflightStep, runClosePipeline } from "../../src/queue/close.mjs";
import { closeChecklistLines } from "../../src/queue/close-view.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";
import { CLOSE_PR_URL, fakeCloseDeps, gitOk, HEAD_SHA, openPr, PUSHED_SHA } from "../../test-support/close.mjs";

// Regression net for J-86 / J-87: a close that pushes a rebased head must verify the PUSHED head (GitHub answers the old one for a while),
// and a BLOCKED pull request must wait for its checks instead of being read as mergeable.

const REMAINING_MS = 600000;
const CONFLICTING = { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" };
const GREEN = { ok: true, checks: [{ name: "a", bucket: "pass" }, { name: "b", bucket: "pass" }], failing: [], pending: [] };
const HALF = { ok: true, checks: [{ name: "a", bucket: "pass" }, { name: "b", bucket: "pending" }], failing: [], pending: ["b"] };
const RED = { ok: true, checks: [{ name: "a", bucket: "pass" }, { name: "b", bucket: "fail" }], failing: ["b"], pending: [] };
const NO_CHECKS = { ok: true, checks: [], failing: [], pending: [] };
const PUSHED = { headSha: PUSHED_SHA, pushedBy: "close" };

function closeHome(t, name, worker = "close:test:1:aaaa") {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, notice_md = ?, branch = ? WHERE id = ?").run(CLOSE_PR_URL, "A", "fix/worker", id);
  acquireClose(id, { worker, leaseS: 660 }, env);
  return { env, checkout, id, worker, store: openStore(env) };
}

function reacquire(home, worker) {
  assert.ok(acquireClose(home.id, { worker, leaseS: 660 }, home.env), "the next attempt could not take the lease");
  return { ...home, worker };
}

async function close(home, fake, { force = false, now = Date.now, onStep = null } = {}) {
  const outcome = await runClosePipeline({ store: home.store, job: getJob(home.id, home.env), worker: home.worker, env: home.env, deps: fake.deps, timeoutS: 600, checkout: home.checkout, force, now, onStep });
  return { outcome, row: getJob(home.id, home.env), checklist: JSON.parse(getJob(home.id, home.env).close) };
}

function ctxFor(data = {}, changes = {}) {
  return { jobId: 3, prUrl: CLOSE_PR_URL, prNumber: 7, project: "alpha", branch: "fix/worker", slug: null, type: null, force: false, checkout: "/work/alpha", remainingMs: () => REMAINING_MS, signal: new AbortController().signal, warning: null, data, ...changes };
}

// A fake close whose push moves the head, on a clock the fake sleep advances; `staleReads` GitHub reads after the push still answer the old conflicting head.
function world({ pr = openPr(CONFLICTING), stale = 0, ...changes } = {}) {
  const clock = { at: Date.now() };
  const fake = fakeCloseDeps({ pr, checks: GREEN, ...changes });
  fake.world.git.push = () => {
    fake.world.pr = openPr({ headRefOid: PUSHED_SHA });
    fake.world.reads = Array.from({ length: stale }, () => openPr(CONFLICTING));
    return gitOk();
  };
  const sleep = fake.deps.sleep;
  fake.deps.sleep = async (ms) => {
    clock.at += ms;
    await sleep(ms);
  };
  return { fake, now: () => clock.at };
}

test("J-86: the old conflicting head is still answered after the close's push, and one run merges the pushed head", async (t) => {
  const home = closeHome(t, "pushed-head-j86");
  const { fake, now } = world({ stale: 2, checkReads: [GREEN] });
  const ran = [];
  const earlier = [];
  const { outcome, checklist } = await close(home, fake, {
    now,
    onStep: (step) => {
      if (step.status === "running") return;
      ran.push(step.name);
      if (step.name === "conflict") earlier.push(step.earlier);
    },
  });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
  assert.deepEqual(fake.log.sleeps, [2000, 2000]);
  assert.deepEqual(ran, ["preflight", "conflict", "preflight", "conflict", "merge", "settle"]);
  assert.equal(earlier[1], false, "the second conflict pass was not a skip of this attempt's own run");
  assert.equal(checklist.data.pushedBy, "close");
  assert.match(checklist.steps.preflight.note, new RegExp(`head ${PUSHED_SHA.slice(0, 7)} pushed by this close`));
  assert.equal(checklist.steps.conflict.status, "done");
  assert.notEqual(checklist.steps.conflict.status, "not reached");
});

test("J-86: a stale UNKNOWN mergeability on the pushed head is re-read and the close still merges", async (t) => {
  const home = closeHome(t, "pushed-head-unknown");
  const { fake, now } = world({ checkReads: [GREEN] });
  fake.world.git.push = () => {
    fake.world.pr = openPr({ headRefOid: PUSHED_SHA });
    fake.world.reads = [openPr(CONFLICTING), openPr({ headRefOid: PUSHED_SHA, mergeable: "UNKNOWN" })];
    return gitOk();
  };
  const { outcome } = await close(home, fake, { now });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: PUSHED_SHA }]);
  assert.deepEqual(fake.log.sleeps, [2000, 2000]);
});

test("J-87: a BLOCKED pull request waits for pending checks and merges only once green", async (t) => {
  const home = closeHome(t, "pushed-head-blocked-green");
  const { fake, now } = world({ pr: openPr({ mergeStateStatus: "BLOCKED" }), checkReads: [GREEN, HALF, GREEN] });
  fake.world.git.push = () => gitOk();
  const { outcome } = await close(home, fake, { now });
  assert.equal(outcome.status, "closed", JSON.stringify(outcome));
  assert.deepEqual(fake.log.sleeps, [10000]);
  assert.deepEqual(fake.log.merges, [{ url: CLOSE_PR_URL, matchHeadCommit: HEAD_SHA }]);

  const step = fakeCloseDeps({ pr: openPr({ mergeStateStatus: "BLOCKED" }), checkReads: [HALF, GREEN] });
  const result = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: step.deps });
  assert.equal(result.status, "done", result.note);
  assert.deepEqual(step.log.sleeps, [10000]);
});

test("J-87: a BLOCKED pull request whose checks go red stops at checks-red and merges nothing; --force skips the wait", async () => {
  const red = fakeCloseDeps({ pr: openPr({ mergeStateStatus: "BLOCKED" }), checkReads: [RED] });
  const stopped = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }), deps: red.deps });
  assert.equal(stopped.status, "failed");
  assert.equal(stopped.reason, "checks-red");
  assert.deepEqual(red.log.merges, []);

  const forced = fakeCloseDeps({ pr: openPr({ mergeStateStatus: "BLOCKED" }) });
  const skipped = await conflictStep({ ctx: ctxFor({ headSha: HEAD_SHA }, { force: true }), deps: forced.deps });
  assert.equal(skipped.status, "skipped");
  assert.equal(forced.log.checkReads, 0);
});

test("a fresh push with no check registered yet is not passed on 'no checks reported': preflight waits for the pushed head's checks", async () => {
  const fake = fakeCloseDeps({ pr: openPr({ headRefOid: PUSHED_SHA }), checkReads: [NO_CHECKS, GREEN] });
  const clock = { at: Date.now() };
  const sleep = fake.deps.sleep;
  fake.deps.sleep = async (ms) => {
    clock.at += ms;
    await sleep(ms);
  };
  const result = await preflightStep({ ctx: ctxFor(PUSHED, { now: () => clock.at }), deps: fake.deps });
  assert.notEqual(result.status, "failed", result.note);
  assert.equal(fake.log.checkReads, 2, "preflight accepted the empty check list at the first read");
  assert.deepEqual(fake.log.sleeps, [10000]);
  assert.match(result.note, /2 checks green on 2222222/);
});

test("a merge that finds the pull request conflicting again marks conflict reopened, keeps its note, shows it and re-runs it next time", async (t) => {
  const home = closeHome(t, "pushed-head-reopened");
  const fake = fakeCloseDeps({ reads: [openPr(), openPr(), openPr(CONFLICTING)] });
  const first = await close(home, fake);
  assert.equal(first.outcome.reason, "not-mergeable");
  const conflict = first.checklist.steps.conflict;
  assert.equal(conflict.status, "reopened");
  assert.equal(conflict.note, "mergeable (CLEAN)");
  assert.equal(typeof conflict.at, "string");
  const lines = closeChecklistLines(first.row);
  assert.ok(lines.some((line) => /^ {2}↺ conflict {3}reopened: mergeable \(CLEAN\)/.test(line)), lines.join("\n"));
  assert.equal(lines.some((line) => line.includes("conflict   not reached")), false);

  const second = await close(reacquire(home, "close:test:2:bbbb"), fake);
  assert.equal(second.outcome.status, "closed", JSON.stringify(second.outcome));
  assert.equal(fake.log.merges.length, 1);
});
