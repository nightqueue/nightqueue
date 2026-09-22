import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireShip, addJob, getJob } from "../../src/memory/jobs.mjs";
import { runShip } from "../../src/queue/ship.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const PR_URL = "https://github.com/acme/api/pull/7";
const MERGE_SHA = "abc1234def5678";

// A home with a `done` job of `alpha` whose ship lease is held by `worker`, the state every attempt starts from.
function shipHome(t, name, { worker = "ship:test:1:aaaa", notice = "A" } = {}) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, notice_md = ? WHERE id = ?").run(PR_URL, notice, id);
  acquireShip(id, { worker, leaseS: 660 }, env);
  return { env, checkout, id, worker, store: openStore(env) };
}

// Takes the lease again for a new attempt, as the next `queue ship` would.
function reacquire(home, worker) {
  assert.ok(acquireShip(home.id, { worker, leaseS: 660 }, home.env), "the next attempt could not take the lease");
  return { ...home, worker };
}

// The four steps of a ship, each answering what the test gives it and counting its calls.
function fakeSteps(answers) {
  const calls = { preflight: 0, conflict: 0, merge: 0, settle: 0 };
  const steps = Object.keys(calls).map((name) => ({
    name,
    run: async (input) => {
      calls[name] += 1;
      return await answers[name](input);
    },
  }));
  return { steps, calls };
}

const done = (note, data) => async () => ({ status: "done", note, data });
const settleDone = async ({ ctx }) => ({ status: "done", note: "ready to close", data: { noticeLine: `Shipped: PR #${ctx.prNumber} merged as ${ctx.data.mergeSha.slice(0, 7)} on 2026-09-21` } });
const GREEN = { preflight: done("checks green"), conflict: async () => ({ status: "skipped", note: "mergeable" }), merge: done("merged", { merged: true, mergeSha: MERGE_SHA }), settle: settleDone };

// Runs one attempt against the home's lease, collecting what `onStep` reported.
async function attempt(home, { steps, deps = {}, timeoutS = 60, signal = null, store = home.store }) {
  const reported = [];
  const outcome = await runShip({ store, job: getJob(home.id, home.env), worker: home.worker, env: home.env, deps, timeoutS, signal, onStep: (step) => reported.push(step), checkout: home.checkout, steps });
  return { outcome, reported, row: getJob(home.id, home.env) };
}

// The stored checklist of the job.
function checklistOf(home) {
  return JSON.parse(getJob(home.id, home.env).ship);
}

test("a green ship writes the checklist after every step, leaves the job status alone until settle, then closes it shipped", async (t) => {
  const home = shipHome(t, "ship-engine-green");
  const written = [];
  const store = {
    ...home.store,
    jobs: {
      ...home.store.jobs,
      recordShipStep: async (id, spec) => {
        written.push({ steps: Object.keys(spec.ship.steps), status: getJob(id, home.env).status });
        return await home.store.jobs.recordShipStep(id, spec);
      },
    },
  };
  const { outcome, reported, row } = await attempt(home, { steps: fakeSteps(GREEN).steps, store });

  assert.deepEqual(written, [
    { steps: ["preflight"], status: "done" },
    { steps: ["preflight", "conflict"], status: "done" },
    { steps: ["preflight", "conflict", "merge"], status: "done" },
  ]);
  assert.deepEqual(outcome, { status: "shipped", step: "settle", reason: null, mergeSha: MERGE_SHA, worktree: null });
  assert.deepEqual(
    reported.map(({ name, status, earlier }) => [name, status, earlier]),
    [["preflight", "done", false], ["conflict", "skipped", false], ["merge", "done", false], ["settle", "done", false]],
  );
  assert.equal(row.status, "closed");
  assert.equal(row.ship_status, "shipped");
  assert.equal(row.ship_worker, null);
  assert.equal(row.notice_md, "A\n\nShipped: PR #7 merged as abc1234 on 2026-09-21");
  const checklist = checklistOf(home);
  assert.deepEqual(Object.values(checklist.steps).map((step) => step.status), ["done", "skipped", "done", "done"]);
  assert.equal(checklist.data.mergeSha, MERGE_SHA);
  assert.equal(typeof checklist.finishedAt, "string");
});

test("a failed step stops the ship with the job status untouched, and the next attempt resumes past the steps already done", async (t) => {
  const home = shipHome(t, "ship-engine-resume");
  const first = fakeSteps({ ...GREEN, conflict: async () => ({ status: "failed", reason: "real-conflict", note: "src/a.mjs" }) });
  const stopped = await attempt(home, { steps: first.steps });
  assert.deepEqual(stopped.outcome, { status: "failed", step: "conflict", reason: "real-conflict", mergeSha: null, worktree: null });
  assert.equal(stopped.row.status, "done", "a failed ship moved the job status");
  assert.equal(stopped.row.ship_status, "failed");
  assert.equal(stopped.row.ship_lease_until, null);
  assert.deepEqual(checklistOf(home).failed, { step: "conflict", reason: "real-conflict" });
  assert.equal(checklistOf(home).steps.conflict.note, "real-conflict - src/a.mjs");

  const next = reacquire(home, "ship:test:2:bbbb");
  const second = fakeSteps(GREEN);
  const resumed = await attempt(next, { steps: second.steps });
  assert.equal(resumed.outcome.status, "shipped");
  assert.equal(second.calls.preflight, 0, "a step already done ran again");
  assert.equal(second.calls.conflict, 1);
  assert.deepEqual(resumed.reported[0], { name: "preflight", status: "done", note: "checks green", earlier: true });
  assert.equal(checklistOf(home).attempts, 2);
});

test("a skipped step is re-evaluated on the next attempt, and a step can reopen the ones before it", async (t) => {
  const home = shipHome(t, "ship-engine-reopen");
  const first = fakeSteps({ ...GREEN, merge: async () => ({ status: "failed", reason: "head-moved", note: "the head moved", reopen: ["preflight", "conflict"] }) });
  await attempt(home, { steps: first.steps });
  assert.deepEqual(Object.keys(checklistOf(home).steps), ["merge"]);

  const next = reacquire(home, "ship:test:2:bbbb");
  const second = fakeSteps(GREEN);
  await attempt(next, { steps: second.steps });
  assert.deepEqual(second.calls, { preflight: 1, conflict: 1, merge: 1, settle: 1 });
});

test("a merge that happened is never called again: the effect is decided by data.merged, never by the step status", async (t) => {
  const home = shipHome(t, "ship-engine-merge-once");
  let mergeCalls = 0;
  const merge = async ({ ctx }) => {
    if (ctx.data.merged) return { status: "done", note: "already merged", data: { mergeSha: MERGE_SHA } };
    mergeCalls += 1;
    return { status: "failed", reason: "merge-without-sha", note: "gh exited 1", data: { merged: true } };
  };
  const first = await attempt(home, { steps: fakeSteps({ ...GREEN, merge }).steps });
  assert.equal(first.outcome.reason, "merge-without-sha");
  assert.equal(checklistOf(home).data.merged, true, "the data of a failed step was dropped");

  const next = reacquire(home, "ship:test:2:bbbb");
  const second = await attempt(next, { steps: fakeSteps({ ...GREEN, merge }).steps });
  assert.equal(second.outcome.status, "shipped");
  assert.equal(second.outcome.mergeSha, MERGE_SHA);
  assert.equal(mergeCalls, 1, "the merge ran twice");
});

test("a step that outlives the hard timeout fails the ship with `timeout`, aborts the step's signal and clears the lease", async (t) => {
  const home = shipHome(t, "ship-engine-timeout");
  let seen = null;
  const preflight = ({ ctx }) => {
    seen = ctx.signal;
    return new Promise(() => {});
  };
  const { outcome, row } = await attempt(home, { steps: fakeSteps({ ...GREEN, preflight }).steps, timeoutS: 0.05 });
  assert.deepEqual(outcome, { status: "failed", step: "preflight", reason: "timeout", mergeSha: null, worktree: null });
  assert.equal(seen.aborted, true, "the step's signal was never aborted");
  assert.equal(row.ship_status, "failed");
  assert.equal(row.ship_lease_until, null);
  assert.equal(row.status, "done");
});

test("the caller's abort stops the ship as `interrupted`, resumable", async (t) => {
  const home = shipHome(t, "ship-engine-abort");
  const controller = new AbortController();
  const preflight = () => {
    setTimeout(() => controller.abort(), 10);
    return new Promise(() => {});
  };
  const { outcome, row } = await attempt(home, { steps: fakeSteps({ ...GREEN, preflight }).steps, signal: controller.signal });
  assert.equal(outcome.reason, "interrupted");
  assert.equal(row.ship_status, "failed");
  assert.deepEqual(checklistOf(home).failed, { step: "preflight", reason: "interrupted" });
  assert.equal(checklistOf(home).steps.preflight.status, "failed");
});

test("a step that throws becomes `step-crashed` with its message, never an exception", async (t) => {
  const home = shipHome(t, "ship-engine-crash");
  const conflict = async () => {
    throw new Error("git exploded");
  };
  const { outcome } = await attempt(home, { steps: fakeSteps({ ...GREEN, conflict }).steps });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.reason, "step-crashed");
  assert.equal(checklistOf(home).steps.conflict.note, "step-crashed - git exploded");
});

test("a lease taken over mid-ship answers `lost` and writes nothing more", async (t) => {
  const home = shipHome(t, "ship-engine-lost");
  const preflight = async () => {
    openDb(home.env).prepare("UPDATE jobs SET ship_worker = 'ship:thief:9:ffff' WHERE id = ?").run(home.id);
    return { status: "done", note: "checks green" };
  };
  const counted = fakeSteps({ ...GREEN, preflight });
  const { outcome, row } = await attempt(home, { steps: counted.steps });
  assert.equal(outcome.status, "lost");
  assert.equal(counted.calls.conflict, 0, "the ship went on after losing its lease");
  assert.equal(row.ship_worker, "ship:thief:9:ffff");
  assert.equal(row.ship_status, "shipping");
  assert.deepEqual(JSON.parse(row.ship).steps, {}, "a lost ship wrote its checklist");
});

test("a close the store refuses fails the ship at settle with `close-refused`, naming the job status", async (t) => {
  const home = shipHome(t, "ship-engine-close-refused");
  const deps = { closeShipped: async () => ({ job: null, worktree: null }) };
  const { outcome, row } = await attempt(home, { steps: fakeSteps(GREEN).steps, deps });
  assert.deepEqual(outcome, { status: "failed", step: "settle", reason: "close-refused", mergeSha: MERGE_SHA, worktree: null });
  assert.equal(row.status, "done");
  assert.equal(row.ship_status, "failed");
  const settle = checklistOf(home).steps.settle;
  assert.equal(settle.status, "failed");
  assert.match(settle.note, /^close-refused - the job is `done`/);
});

test("the injected close answers the worktree, which the outcome carries and the checklist records", async (t) => {
  const home = shipHome(t, "ship-engine-close-worktree");
  const worktree = { status: "removed", path: "/tmp/wt-7" };
  const deps = {
    closeShipped: async ({ store, id, worker, ship, noticeLine }) => ({ job: await store.jobs.settleShip(id, { worker, ship, noticeLine }), worktree }),
  };
  const { outcome } = await attempt(home, { steps: fakeSteps(GREEN).steps, deps });
  assert.deepEqual(outcome.worktree, worktree);
  assert.deepEqual(checklistOf(home).steps.settle.worktree, worktree);
});

test("the fetch warning a step records prefixes every later note", async (t) => {
  const home = shipHome(t, "ship-engine-warning");
  const preflight = done("checks green", { fetchWarning: "WARNING: git fetch origin failed (offline)" });
  await attempt(home, { steps: fakeSteps({ ...GREEN, preflight }).steps });
  const steps = checklistOf(home).steps;
  assert.equal(steps.preflight.note, "WARNING: git fetch origin failed (offline) | checks green");
  assert.equal(steps.merge.note, "WARNING: git fetch origin failed (offline) | merged");
});
