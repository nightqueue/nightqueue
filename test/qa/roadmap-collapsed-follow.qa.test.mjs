// H1 · a missed/collapsed roadmap follow permanently drops the `pr` comment when a job goes
// done→closed without a follow in between.
//
// Root cause: `followJobQuietly` (src/store/local.mjs:42-48) swallows any throw from
// `roadmap.followJob` silently. If the follow for a job's `done` transition throws (a crashed
// trigger, a lock, any exception inside `followLinkedItem`), the linked item's
// `job_status_seen` is never advanced past whatever it was before `done` — the job write itself
// still succeeds (finishJob is a plain JOB_STATUS_WRITER, not wrapped by `followingPassedStatus`).
// When the job later reaches `closed` (settleClose, also a plain JOB_STATUS_WRITER — see
// `src/store/local.mjs` JOB_STATUS_WRITERS), `followJobQuietly` runs again, but `jobEvent`
// (src/memory/roadmap-workflow.mjs:54-58) only ever compares the item's stale `job_status_seen`
// against the job's CURRENT row: every status in DIRECT_EVENTS (`running, gate, done, failed,
// cancelled, closed`) is unconditionally direct. So the follow jumps straight from the stale seen
// value to `closed`, permanently skipping the `pr` comment/`in_review` step. The item's status
// still ends up `done` (matching `roadmapDrift`'s accounting), but the operator-facing comment
// thread never documents that the job passed through review.
//
// BASELINE (proof by reading, not by running — do not check out the ref):
// `git show 8738547:src/store/local.mjs` (the pre-rebase branch) wraps its equivalent close
// writer with `followingPassedStatus`, and `git show 8738547:src/memory/jobs.mjs` shows that
// writer's own UPDATE recording, in the job's result, the status it left in the same statement.
// `followingPassedStatus`/`followJobWrite` (src/memory/roadmap.mjs `followPassedStatus`) then
// replays that recorded source status FIRST (producing the missed `pr` comment) before
// following the job's current (`closed`) row — so on the pre-rebase branch, even a job that
// missed its `done` follow would recover the `pr` comment the moment it closed. On the rebased
// HEAD, `settleClose` records no source status: it is a bare entry in `JOB_STATUS_WRITERS`,
// followed only by `followJobQuietly` (current row only, no passed-status replay). Without a
// follow-level recovery this is a regression of the pre-rebase branch's own recovery mechanism
// on the same path.
//
// This test models "the `done` follow crashed" the same way
// test/store/roadmap-follow-failure.test.mjs does (a BEFORE UPDATE trigger that raises), then
// proves the `pr` comment is unrecoverable even after a normal settleClose through the store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { openStore, withReadOnlyStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, mergedChecklist } from "../../test-support/memory.mjs";

const PR_URL = "https://github.com/acme/alpha/pull/9";

const BREAK_ROADMAP_WRITES = `CREATE TRIGGER roadmap_follow_boom BEFORE UPDATE ON roadmap_items
  BEGIN SELECT RAISE(ABORT, 'roadmap follow forced to fail'); END;`;

// The kinds of the comments an item holds, oldest first.
async function kindsOf(env, itemId) {
  return withReadOnlyStore(env, async (readOnly) => (await readOnly.roadmap.getRoadmapItemDetail(itemId, {})).comments.map((c) => c.kind));
}

test("a done follow that crashed once is never recovered by a later settleClose — the `pr` comment is permanently lost", async (t) => {
  const env = makeHome(t, "roadmap-collapsed-follow");
  makeProject(t, env, "alpha");
  const store = openStore(env);

  const item = await store.roadmap.saveRoadmapItem({ type: "improvement", project: "alpha", title: "collapsed follow repro" });
  const { job } = await store.roadmap.queueRoadmapItem({ id: item.id });
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).job_status_seen ?? null, "running", "setup: claim did not follow to running");

  // Model a crashed `done` follow: the write below still succeeds (finishJob is not wrapped by
  // followingPassedStatus), but followJobQuietly's roadmap.followJob throws and is swallowed —
  // job_status_seen never advances past "running", and the item never gets its `pr` comment.
  openDb(env).exec(BREAK_ROADMAP_WRITES);
  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL }), true, "setup: finishJob write itself must still succeed");
  assert.equal(await store.jobs.status(job.id), "done");
  assert.equal((await store.roadmap.getRoadmapItem(item.id)).status, "in_progress", "setup: the follow for `done` must have been swallowed, leaving the item behind");
  openDb(env).exec("DROP TRIGGER roadmap_follow_boom");

  // Now close the job normally through the store, with roadmap writes healthy again — exactly
  // what an operator/queue-close pipeline run does next.
  assert.ok(await store.jobs.acquireClose(job.id, { worker: "close-w", leaseS: 600 }), "setup: the close lease was refused");
  const checklist = mergedChecklist();
  const settled = await store.jobs.settleClose(job.id, { worker: "close-w", close: checklist, noticeLine: checklist.data.noticeLine });
  assert.equal(settled?.id, job.id, "setup: settleClose must succeed");
  assert.equal(await store.jobs.status(job.id), "closed");

  const kinds = await kindsOf(env, item.id);
  // User-facing correctness: the thread must document that the job passed through review
  // (a `pr` comment) before it was closed — not jump straight from `queued` to `closed`.
  assert.ok(kinds.includes("pr"), `the comment thread must contain a \`pr\`-kind comment documenting review, got: ${JSON.stringify(kinds)}`);
  const prIndex = kinds.indexOf("pr");
  const closedIndex = kinds.indexOf("closed");
  assert.ok(prIndex !== -1 && closedIndex !== -1 && prIndex < closedIndex, `expected a \`pr\` comment before \`closed\`, got: ${JSON.stringify(kinds)}`);
});
