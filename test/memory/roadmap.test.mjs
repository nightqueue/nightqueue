import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, cancelJob } from "../../src/memory/jobs.mjs";
import {
  getRoadmapItem,
  listRoadmap,
  markRoadmapItemDone,
  markRoadmapItemQueued,
  queueableRoadmapItem,
  saveRoadmapItem,
  updateRoadmapItem,
} from "../../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Saves a roadmap item of a project with the fields every test would otherwise repeat.
function addItem(env, { project = "alpha", horizon = "now", title, detail, decision_id }) {
  return saveRoadmapItem({ project, horizon, title, detail, decision_id }, env);
}

// Titles of a horizon group, in the order the roadmap returns them.
function titlesOf(roadmap, horizon) {
  return roadmap.horizons.find((group) => group.horizon === horizon).items.map((item) => item.title);
}

// Positions a horizon group holds in the database, plus the SQLite type of each one.
function positionsOf(env, horizon) {
  return openDb(env)
    .prepare("SELECT position, typeof(position) AS kind FROM roadmap_items WHERE project IS ? AND horizon = ? ORDER BY position")
    .all("alpha", horizon);
}

// Asserts a horizon group holds the contiguous integer positions 1..N.
function assertContiguous(env, horizon, total) {
  const rows = positionsOf(env, horizon);
  assert.deepEqual(rows.map((row) => row.position), Array.from({ length: total }, (_, index) => index + 1));
  assert.deepEqual(new Set(rows.map((row) => row.kind)), new Set(total ? ["integer"] : []));
}

test("an item is appended at the end of its horizon and the three horizons come back in order", (t) => {
  const env = makeHome(t, "roadmap-append");
  makeProject(t, env, "alpha");
  assert.equal(addItem(env, { title: "first now" }).position, 1);
  assert.equal(addItem(env, { title: "second now" }).position, 2);
  assert.equal(addItem(env, { horizon: "later", title: "first later" }).position, 1);

  const roadmap = listRoadmap("alpha", env);
  assert.deepEqual(roadmap.horizons.map((group) => group.horizon), ["now", "next", "later"]);
  assert.deepEqual(titlesOf(roadmap, "now"), ["first now", "second now"]);
  assert.deepEqual(titlesOf(roadmap, "next"), []);
  assert.deepEqual(titlesOf(roadmap, "later"), ["first later"]);
  assert.throws(() => addItem(env, { horizon: "someday", title: "x" }), /expected one of now\|next\|later/);
  assert.throws(() => addItem(env, { title: "" }), /roadmap field `title` is required/);
});

test("moving an item inside its horizon renumbers the group to contiguous positions", (t) => {
  const env = makeHome(t, "roadmap-move-within");
  makeProject(t, env, "alpha");
  const first = addItem(env, { title: "a" });
  addItem(env, { title: "b" });
  const third = addItem(env, { title: "c" });

  updateRoadmapItem(first.id, { position: 3 }, env);
  assert.deepEqual(titlesOf(listRoadmap("alpha", env), "now"), ["b", "c", "a"]);
  assertContiguous(env, "now", 3);

  updateRoadmapItem(third.id, { position: 1 }, env);
  assert.deepEqual(titlesOf(listRoadmap("alpha", env), "now"), ["c", "b", "a"]);
  assertContiguous(env, "now", 3);

  updateRoadmapItem(third.id, { position: 99 }, env);
  assert.deepEqual(titlesOf(listRoadmap("alpha", env), "now"), ["b", "a", "c"]);
  assertContiguous(env, "now", 3);
});

test("moving an item across horizons leaves both groups contiguous", (t) => {
  const env = makeHome(t, "roadmap-move-across");
  makeProject(t, env, "alpha");
  addItem(env, { title: "a" });
  const moved = addItem(env, { title: "b" });
  addItem(env, { title: "c" });
  addItem(env, { horizon: "next", title: "x" });

  updateRoadmapItem(moved.id, { horizon: "next" }, env);
  assert.deepEqual(titlesOf(listRoadmap("alpha", env), "now"), ["a", "c"]);
  assert.deepEqual(titlesOf(listRoadmap("alpha", env), "next"), ["x", "b"]);
  assertContiguous(env, "now", 2);
  assertContiguous(env, "next", 2);

  updateRoadmapItem(moved.id, { horizon: "later", position: 1 }, env);
  assert.deepEqual(titlesOf(listRoadmap("alpha", env), "next"), ["x"]);
  assert.deepEqual(titlesOf(listRoadmap("alpha", env), "later"), ["b"]);
  assertContiguous(env, "later", 1);
  assert.equal(getRoadmapItem(moved.id, env).horizon, "later");
});

test("an update writes the fields present in the patch and refuses the queued status by hand", (t) => {
  const env = makeHome(t, "roadmap-update");
  makeProject(t, env, "alpha");
  const item = addItem(env, { title: "deliver the roadmap", detail: "with the three horizons" });

  const updated = updateRoadmapItem(item.id, { title: "deliver the roadmap CLI", detail: null }, env);
  assert.equal(updated.title, "deliver the roadmap CLI");
  assert.equal(updated.detail, "with the three horizons");
  assert.equal(updateRoadmapItem(item.id, { status: "dropped" }, env).status, "dropped");
  assert.equal(updateRoadmapItem(item.id, { status: "open" }, env).status, "open");
  assert.throws(() => updateRoadmapItem(item.id, { status: "queued" }, env), /only becomes `queued` through `queue_add`/);
  assert.throws(() => updateRoadmapItem(item.id, { status: "paused" }, env), /expected one of open\|done\|dropped/);
  assert.throws(() => updateRoadmapItem(9999, { title: "x" }, env), /unknown roadmap item `9999`/);
});

test("the linked decision must exist and belong to the project of the item", (t) => {
  const env = makeHome(t, "roadmap-decision");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const decision = saveDecision({ project: "alpha", title: "one worktree per job", context: "races", decision: "split" }, env);
  const foreign = saveDecision({ project: "beta", title: "beta decision", context: "c", decision: "d" }, env);

  const item = addItem(env, { title: "deliver it", decision_id: decision.id });
  assert.equal(getRoadmapItem(item.id, env).decision_id, decision.id);
  assert.equal(listRoadmap("alpha", env).horizons[0].items[0].decision_number, decision.number);
  assert.throws(() => addItem(env, { title: "bad", decision_id: foreign.id }), /belongs to project `beta`/);
  assert.throws(() => updateRoadmapItem(item.id, { decision_id: 9999 }, env), /unknown decision `9999`/);
});

test("updateRoadmapItem answers the linked decision number and live job status the way roadmap_get does", (t) => {
  const env = makeHome(t, "roadmap-update-view");
  makeProject(t, env, "alpha");
  const decision = saveDecision({ project: "alpha", title: "one worktree per job", context: "races", decision: "split" }, env);
  const other = saveDecision({ project: "alpha", title: "second decision", context: "c", decision: "d" }, env);
  const item = addItem(env, { title: "deliver it", decision_id: decision.id });
  const job = addJob({ project: "alpha", prompt: "deliver it" }, env);
  markRoadmapItemQueued(item.id, job.id, env);

  const statusOnly = updateRoadmapItem(item.id, { status: "open" }, env);
  assert.equal(statusOnly.decision_number, decision.number);
  assert.equal(statusOnly.job_status, "pending");
  assert.equal(getRoadmapItem(item.id, env).decision_id, decision.id);

  const relinked = updateRoadmapItem(item.id, { decision_id: other.id }, env);
  assert.equal(relinked.decision_number, other.number);
  assert.equal(getRoadmapItem(item.id, env).decision_id, other.id);
  assert.equal(listRoadmap("alpha", env).horizons[0].items[0].decision_number, other.number);
  assert.equal(listRoadmap("alpha", env).horizons[0].items[0].job_status, "pending");
});

test("an item is queued once, refused while its job is live, and closed when that job finishes", (t) => {
  const env = makeHome(t, "roadmap-queue-link");
  makeProject(t, env, "alpha");
  const item = addItem(env, { title: "deliver the roadmap" });
  const job = addJob({ project: "alpha", prompt: "deliver the roadmap" }, env);

  assert.equal(queueableRoadmapItem(item.id, env).id, item.id);
  assert.equal(markRoadmapItemQueued(item.id, job.id, env), true);
  const queued = getRoadmapItem(item.id, env);
  assert.equal(queued.status, "queued");
  assert.equal(queued.job_id, job.id);
  assert.throws(() => queueableRoadmapItem(item.id, env), new RegExp(`already queued as job \`${job.id}\``));
  assert.equal(listRoadmap("alpha", env).horizons[0].items[0].job_status, "pending");

  cancelJob(job.id, { reason: "not now" }, env);
  assert.equal(queueableRoadmapItem(item.id, env).id, item.id);

  assert.equal(markRoadmapItemDone(job.id, env), 1);
  assert.equal(getRoadmapItem(item.id, env).status, "done");
  assert.equal(markRoadmapItemDone(job.id, env), 0);
  assert.throws(() => queueableRoadmapItem(item.id, env), /is `done`/);

  updateRoadmapItem(item.id, { status: "dropped" }, env);
  assert.throws(() => queueableRoadmapItem(item.id, env), /is `dropped`/);
  assert.throws(() => queueableRoadmapItem(9999, env), /unknown roadmap item `9999`/);
});
