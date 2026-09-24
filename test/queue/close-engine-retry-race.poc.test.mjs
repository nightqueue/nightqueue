import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { runClosePipeline } from "../../src/queue/close.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const PR_URL = "https://github.com/acme/api/pull/7";
const MERGE_SHA = "abc1234def5678";
const WORKER = "close:test:1:aaaa";

// H1b — src/queue/close.mjs (settleRun/refuseSettle), same root as H1a.
//
// Drives the settle refusal through the real engine: a `done` job reaches its merge step and — before the engine's
// settle step runs — another writer moves the row out of `done` (a `queue retry` can no longer do it, so the test
// writes the move itself). The correct behavior is that `runClosePipeline` visibly stops and is resumable (`failed` /
// `close-refused`), never a silent `closed` outcome and never a job `closed` by a settle that raced past it.
test("a row moved out of done right before settle stops the close as failed/close-refused instead of closing it", async (t) => {
  const env = makeHome(t, "close-engine-retry-race");
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run(PR_URL, id);

  const acquired = acquireClose(id, { worker: WORKER, leaseS: 660 }, env);
  assert.ok(acquired, "the close must take a done job's lease");

  const steps = [
    { name: "merge", run: async () => ({ status: "done", note: "merged", data: { merged: true, mergeSha: MERGE_SHA } }) },
    {
      name: "settle",
      run: async ({ ctx }) => {
        openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(id);
        return { status: "done", note: "ready to close", data: { noticeLine: `Closed: PR #7 merged as ${ctx.data.mergeSha.slice(0, 7)} on 2026-09-21` } };
      },
    },
  ];

  const store = openStore(env);
  const reported = [];
  const outcome = await runClosePipeline({
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

  assert.deepEqual(outcome, { status: "failed", step: "settle", reason: "close-refused", mergeSha: MERGE_SHA, worktree: null }, "the outcome must visibly stop, never `closed`, once the row raced out from under the settle write");

  const row = getJob(id, env);
  assert.equal(row.status, "failed", "the job must stay as the other writer left it, never end up `closed` by a settle that raced past it");
  assert.notEqual(row.status, "closed");
  assert.equal(row.close_status, "failed", "the close must land `failed`, not `closed`, so the operator can resume it");
  assert.equal(row.close_worker, null, "a stopped close must release its own lease");
  assert.equal(row.close_lease_until, null);

  const checklist = JSON.parse(row.close);
  assert.deepEqual(checklist.failed, { step: "settle", reason: "close-refused" }, "the checklist must record exactly where and why the close stopped");
  assert.match(checklist.steps.settle.note, /^close-refused - the job is `failed`/, "the refusal note must name the job's real, current status");
});
