import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../../scripts/roadmap-backfill.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { getRoadmapItemDetail } from "../../src/memory/roadmap.mjs";
import { sqliteToIso } from "../../src/memory/schema.mjs";
import { makeHome, makeProject, mergedChecklist, seedClosedJob, seedDoneJob } from "../../test-support/memory.mjs";

const PR_URL = "https://github.com/acme/alpha/pull/3";

// Seeds a job that ended `failed` through the real store writes, and answers its id.
function seedFailedJob(env) {
  const { id } = addJob({ project: "alpha", prompt: "p" }, env);
  if (!claimJobById(id, { worker: "w1", cap: null }, env)) throw new Error(`seedFailedJob: job #${id} could not be claimed`);
  if (!finishJob(id, { worker: "w1", status: "failed" }, env)) throw new Error(`seedFailedJob: job #${id} could not be finished`);
  return id;
}

// Inserts an item already linked to a job, the way items were linked before comments existed.
function insertItem(db, { status, jobId }) {
  return db
    .prepare("INSERT INTO roadmap_items (project, title, status, position, job_id, job_status_seen) VALUES ('alpha', 't', ?, 1, ?, NULL) RETURNING id")
    .get(status, jobId).id;
}

// A home holding the four histories the backfill has to tell apart, and no comment yet.
function seedHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const jobs = {
    closed: seedClosedJob(env, { prUrl: PR_URL }),
    review: seedDoneJob(env, { prUrl: PR_URL }),
    failed: seedFailedJob(env),
    pending: addJob({ project: "alpha", prompt: "p" }, env).id,
  };
  const db = openDb(env);
  const items = {
    closed: insertItem(db, { status: "done", jobId: jobs.closed }),
    review: insertItem(db, { status: "in_review", jobId: jobs.review }),
    closedByHand: insertItem(db, { status: "done", jobId: jobs.failed }),
    queued: insertItem(db, { status: "in_progress", jobId: jobs.pending }),
  };
  return { env, db, jobs, items };
}

// Runs the script and returns its one output line.
async function backfill(env, argv) {
  const lines = [];
  const code = await main(argv, env, { log: (line) => lines.push(line), error: (line) => lines.push(line) });
  assert.equal(code, 0, lines.join("\n"));
  return lines.at(-1);
}

// The kinds and dates of an item's thread.
function threadOf(env, id) {
  return getRoadmapItemDetail(id, {}, env).comments.map((comment) => [comment.kind, comment.created_at]);
}

// The dates a job's history is synthesized from, in the form a comment carries them.
function datesOf(env, jobId) {
  const job = getJob(jobId, env);
  return { queued: sqliteToIso(job.created_at), finished: sqliteToIso(job.finished_at) };
}

test("the backfill dry run counts what it would write and writes nothing", async (t) => {
  const { env, db } = seedHome(t, "roadmap-backfill-dry");
  assert.match(await backfill(env, ["--dry-run"]), /^dry run .*: items=4 written=6 skipped=1$/);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM roadmap_comments").get().total, 0);
});

test("the backfill dates each synthesized comment, gives a hand-closed item nothing, and a second run writes nothing", async (t) => {
  const { env, jobs, items } = seedHome(t, "roadmap-backfill-run");
  assert.match(await backfill(env, []), /: items=4 written=6 skipped=1$/);
  const closed = datesOf(env, jobs.closed);
  assert.deepEqual(threadOf(env, items.closed), [
    ["queued", closed.queued],
    ["pr", closed.finished],
    ["closed", closed.finished],
  ]);
  const review = datesOf(env, jobs.review);
  assert.deepEqual(threadOf(env, items.review), [
    ["queued", review.queued],
    ["pr", review.finished],
  ]);
  assert.deepEqual(threadOf(env, items.closedByHand), []);
  assert.deepEqual(threadOf(env, items.queued), [["queued", datesOf(env, jobs.pending).queued]]);
  const close = getRoadmapItemDetail(items.closed, {}, env).comments.at(-1);
  assert.equal(close.author, `job:${jobs.closed}`);
  assert.equal(close.body, `job #${jobs.closed} closed`);
  assert.deepEqual([close.refs.pr, close.refs.sha], [PR_URL, mergedChecklist().data.mergeSha]);

  assert.match(await backfill(env, []), /: items=4 written=0 skipped=1$/);
});
