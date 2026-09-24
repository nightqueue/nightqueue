import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { openStore, withReadOnlyStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, mergedChecklist } from "../../test-support/memory.mjs";

const PR_URL = "https://github.com/acme/alpha/pull/7";

const BREAK_ROADMAP_WRITES = `CREATE TRIGGER roadmap_follow_boom BEFORE UPDATE ON roadmap_items
  BEGIN SELECT RAISE(ABORT, 'roadmap follow forced to fail'); END;`;

// A store whose one roadmap item is linked to a job the worker `w1` already claimed.
async function claimedLinkedJob(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const store = openStore(env);
  const item = await store.roadmap.saveRoadmapItem({ type: "improvement", project: "alpha", title: "survive a broken follow" });
  const { job } = await store.roadmap.queueRoadmapItem({ id: item.id });
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  return { env, store, item, job };
}

test("a follow that throws never costs the job write, the drift is reported, and the sweep heals it", async (t) => {
  const { env, store, item, job } = await claimedLinkedJob(t, "roadmap-follow-failure");
  openDb(env).exec(BREAK_ROADMAP_WRITES);

  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status: "done" }), true);
  assert.equal(await store.jobs.status(job.id), "done");
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).status, "in_progress");

  const drift = await withReadOnlyStore(env, (readOnly) => readOnly.roadmap.roadmapDrift());
  assert.deepEqual(drift, [
    { id: item.id, scope: "project", owner: "alpha", status: "in_progress", expected: "in_review", job_id: job.id, job_status: "done" },
  ]);

  openDb(env).exec("DROP TRIGGER roadmap_follow_boom");
  await store.jobs.sweepOrphans();
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).status, "in_review");
  assert.deepEqual(await withReadOnlyStore(env, (readOnly) => readOnly.roadmap.roadmapDrift()), []);
});

// The kinds of the comments an item holds, oldest first.
async function kindsOf(env, item) {
  return withReadOnlyStore(env, async (readOnly) => (await readOnly.roadmap.getRoadmapItemDetail(item.id, {})).comments.map((comment) => comment.kind));
}

// Finishes the claimed job `done` with a pull request and takes its close lease for `close-w`, all through the store.
async function closingJob(store, job) {
  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL }), true, "setup: the job was not finished");
  assert.ok(await store.jobs.acquireClose(job.id, { worker: "close-w", leaseS: 600 }), "setup: the close lease was refused");
}

test("a follow that throws never costs the settleClose, the drift is reported, and the sweep heals it", async (t) => {
  const { env, store, item, job } = await claimedLinkedJob(t, "roadmap-follow-failure-settle");
  await closingJob(store, job);
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).status, "in_review");
  openDb(env).exec(BREAK_ROADMAP_WRITES);

  const checklist = mergedChecklist();
  const settled = await store.jobs.settleClose(job.id, { worker: "close-w", close: checklist, noticeLine: checklist.data.noticeLine });
  assert.equal(settled?.id, job.id);
  assert.equal(await store.jobs.status(job.id), "closed");
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).status, "in_review");
  assert.deepEqual(await withReadOnlyStore(env, (readOnly) => readOnly.roadmap.roadmapDrift()), [
    { id: item.id, scope: "project", owner: "alpha", status: "in_review", expected: "done", job_id: job.id, job_status: "closed" },
  ]);

  openDb(env).exec("DROP TRIGGER roadmap_follow_boom");
  await store.jobs.sweepOrphans();
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).status, "done");
  assert.deepEqual(await withReadOnlyStore(env, (readOnly) => readOnly.roadmap.roadmapDrift()), []);
  const closed = (await withReadOnlyStore(env, (readOnly) => readOnly.roadmap.getRoadmapItemDetail(item.id, {}))).comments.filter((c) => c.kind === "closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].refs.sha, checklist.data.mergeSha);
});

test("a settleClose refused for another worker writes no comment and leaves the item in review", async (t) => {
  const { env, store, item, job } = await claimedLinkedJob(t, "roadmap-follow-refused-settle");
  await closingJob(store, job);
  const before = await kindsOf(env, item);

  const checklist = mergedChecklist();
  assert.equal(await store.jobs.settleClose(job.id, { worker: "other-w", close: checklist, noticeLine: checklist.data.noticeLine }), null);
  assert.equal(await store.jobs.status(job.id), "done");
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).status, "in_review");
  assert.deepEqual(await kindsOf(env, item), before);
});

test("a drift where the item already holds the expected status is not reported", async (t) => {
  const { env, store, item, job } = await claimedLinkedJob(t, "roadmap-follow-quiet-drift");
  openDb(env).prepare("UPDATE roadmap_items SET job_status_seen = 'pending' WHERE id = ?").run(item.id);
  assert.equal(await store.jobs.status(job.id), "running");
  assert.deepEqual(await withReadOnlyStore(env, (readOnly) => readOnly.roadmap.roadmapDrift()), []);
});
