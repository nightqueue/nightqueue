import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireShip, addJob, getJob, retryJob } from "../../src/memory/jobs.mjs";
import { runShip } from "../../src/queue/ship.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const PR_URL = "https://github.com/acme/api/pull/7";
const MERGE_SHA = "abc1234def5678";
const WORKER = "ship:test:1:aaaa";

// H1b — src/queue/ship.mjs:493-516 (settleShipped/refuseSettle), same root as H1a.
//
// Drives the same race through the real engine instead of the DB layer directly: a force-shipped `failed`
// job (the only state where acquireShip's own WHERE lets a ship start from a status a concurrent `queue
// retry` can also reopen) reaches its merge step, and — before the engine's settle step runs — an operator's
// `queue retry` races in and reopens the job. The correct behavior is that `runShip` visibly stops and is
// resumable (`failed` / `close-refused`), never a silent `shipped` outcome and never a job stuck straddling
// both a fresh `pending` retry and a `shipped` ship status.
test("a concurrent retry racing in right before settle stops the ship as failed/close-refused instead of shipping a reopened job", async (t) => {
  const env = makeHome(t, "ship-engine-retry-race");
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'failed', pr_url = ? WHERE id = ?").run(PR_URL, id);

  const acquired = acquireShip(id, { worker: WORKER, leaseS: 660, force: true }, env);
  assert.ok(acquired, "the ship must be able to force-acquire a failed job's lease");

  const steps = [
    { name: "merge", run: async () => ({ status: "done", note: "merged", data: { merged: true, mergeSha: MERGE_SHA } }) },
    {
      name: "settle",
      run: async ({ ctx }) => {
        // The concurrent `queue retry <id>` an operator runs while the ship is still mid-flight, landing
        // between the merge step recording its data and the settle step's own close write.
        const retried = retryJob(id, {}, env);
        assert.equal(retried.status, "pending", "the concurrent retry must actually reopen the job for the race to be real");
        return { status: "done", note: "ready to close", data: { noticeLine: `Shipped: PR #7 merged as ${ctx.data.mergeSha.slice(0, 7)} on 2026-09-21` } };
      },
    },
  ];

  const store = openStore(env);
  const reported = [];
  const outcome = await runShip({
    store,
    job: getJob(id, env),
    worker: WORKER,
    env,
    deps: {},
    timeoutS: 60,
    onStep: (step) => reported.push(step),
    checkout,
    steps,
  });

  assert.deepEqual(outcome, { status: "failed", step: "settle", reason: "close-refused", mergeSha: MERGE_SHA, worktree: null }, "the outcome must visibly stop, never `shipped`, once the row raced out from under the settle write");

  const row = getJob(id, env);
  assert.equal(row.status, "pending", "the job must stay reopened by the retry, never end up `closed` by a settle that raced past it");
  assert.notEqual(row.status, "closed");
  assert.equal(row.ship_status, "failed", "the ship must land `failed`, not `shipped`, so the operator can resume it");
  assert.equal(row.ship_worker, null, "a stopped ship must release its own lease");
  assert.equal(row.ship_lease_until, null);

  const checklist = JSON.parse(row.ship);
  assert.deepEqual(checklist.failed, { step: "settle", reason: "close-refused" }, "the checklist must record exactly where and why the ship stopped");
  assert.match(checklist.steps.settle.note, /^close-refused - the job is `pending`/, "the refusal note must name the job's real, current status");
});
