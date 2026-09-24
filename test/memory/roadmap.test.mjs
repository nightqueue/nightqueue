import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, cancelJob } from "../../src/memory/jobs.mjs";
import {
  getRoadmapItem,
  linkRoadmapItemJob,
  listRoadmap,
  queueableRoadmapItem,
  saveRoadmapItem,
  updateRoadmapItem,
} from "../../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Saves a roadmap item of a project with the fields every test would otherwise repeat.
function addItem(env, { project = "alpha", priority, status, title, detail, decision_id }) {
  return saveRoadmapItem({ type: "improvement", project, priority, status, title, detail, decision_id }, env);
}

// Titles of one priority group, in the order the roadmap returns them.
function titlesOf(env, priority) {
  return listRoadmap("alpha", {}, env)
    .items.filter((item) => item.priority === priority)
    .map((item) => item.title);
}

// Positions a priority group holds in the database, plus the SQLite type of each one.
function positionsOf(env, priority) {
  return openDb(env)
    .prepare("SELECT position, typeof(position) AS kind FROM roadmap_items WHERE project IS ? AND priority = ? ORDER BY position")
    .all("alpha", priority);
}

// Asserts a priority group holds the contiguous integer positions 1..N.
function assertContiguous(env, priority, total) {
  const rows = positionsOf(env, priority);
  assert.deepEqual(rows.map((row) => row.position), Array.from({ length: total }, (_, index) => index + 1));
  assert.deepEqual(new Set(rows.map((row) => row.kind)), new Set(total ? ["integer"] : []));
}

test("an item is appended at the end of its priority group, and the listing puts priority 1 first", (t) => {
  const env = makeHome(t, "roadmap-append");
  makeProject(t, env, "alpha");
  const first = addItem(env, { title: "first p5" });
  assert.equal(first.position, 1);
  assert.equal(first.priority, 5);
  assert.equal(first.status, "todo");
  assert.equal(addItem(env, { title: "second p5" }).position, 2);
  assert.equal(addItem(env, { priority: 2, title: "first p2" }).position, 1);

  const roadmap = listRoadmap("alpha", {}, env);
  assert.equal(roadmap.project, "alpha");
  assert.deepEqual(roadmap.items.map((item) => item.title), ["first p2", "first p5", "second p5"]);
  assert.equal("horizon" in roadmap.items[0], false);
  assert.throws(() => addItem(env, { priority: 10, title: "x" }), /expected an integer 1-9/);
  assert.throws(() => addItem(env, { title: "" }), /roadmap field `title` is required/);
});

test("the retired horizon is refused by name on save and on update", (t) => {
  const env = makeHome(t, "roadmap-horizon");
  makeProject(t, env, "alpha");
  assert.throws(() => saveRoadmapItem({ type: "improvement", project: "alpha", horizon: "now", title: "x" }, env), /`horizon` was removed in schema v17: use `priority`/);
  const item = addItem(env, { title: "x" });
  assert.throws(() => updateRoadmapItem(item.id, { horizon: "next" }, env), /`horizon` was removed in schema v17/);
});

test("the listing groups by workflow status and narrows only by the filters it is given", (t) => {
  const env = makeHome(t, "roadmap-filters");
  makeProject(t, env, "alpha");
  addItem(env, { title: "delivered", status: "done" });
  addItem(env, { title: "later", status: "backlog", priority: 1 });
  addItem(env, { title: "next up", priority: 3 });
  addItem(env, { title: "dropped", status: "cancelled" });

  assert.deepEqual(listRoadmap("alpha", {}, env).items.map((item) => item.title), ["later", "next up", "delivered", "dropped"]);
  assert.deepEqual(listRoadmap("alpha", { status: ["todo", "done"] }, env).items.map((item) => item.title), ["next up", "delivered"]);
  assert.deepEqual(listRoadmap("alpha", { priority: [1, 3] }, env).items.map((item) => item.title), ["later", "next up"]);
  assert.deepEqual(listRoadmap("alpha", { status: [] }, env).items.length, 4);
  assert.throws(() => listRoadmap("alpha", { status: ["open"] }, env), /invalid roadmap `status` filter `open`/);
  assert.throws(() => listRoadmap("alpha", { priority: [0] }, env), /invalid roadmap `priority` filter `0`/);
});

test("moving an item inside its priority group renumbers the group to contiguous positions", (t) => {
  const env = makeHome(t, "roadmap-move-within");
  makeProject(t, env, "alpha");
  const first = addItem(env, { title: "a" });
  addItem(env, { title: "b" });
  const third = addItem(env, { title: "c" });

  updateRoadmapItem(first.id, { position: 3 }, env);
  assert.deepEqual(titlesOf(env, 5), ["b", "c", "a"]);
  assertContiguous(env, 5, 3);

  updateRoadmapItem(third.id, { position: 1 }, env);
  assert.deepEqual(titlesOf(env, 5), ["c", "b", "a"]);
  assertContiguous(env, 5, 3);

  updateRoadmapItem(third.id, { position: 99 }, env);
  assert.deepEqual(titlesOf(env, 5), ["b", "a", "c"]);
  assertContiguous(env, 5, 3);
});

test("a priority change moves the item to the end of its new group and leaves both groups contiguous", (t) => {
  const env = makeHome(t, "roadmap-move-across");
  makeProject(t, env, "alpha");
  addItem(env, { title: "a" });
  const moved = addItem(env, { title: "b" });
  addItem(env, { title: "c" });
  addItem(env, { priority: 2, title: "x" });

  updateRoadmapItem(moved.id, { priority: 2 }, env);
  assert.deepEqual(titlesOf(env, 5), ["a", "c"]);
  assert.deepEqual(titlesOf(env, 2), ["x", "b"]);
  assertContiguous(env, 5, 2);
  assertContiguous(env, 2, 2);

  updateRoadmapItem(moved.id, { priority: 9, position: 1 }, env);
  assert.deepEqual(titlesOf(env, 2), ["x"]);
  assert.deepEqual(titlesOf(env, 9), ["b"]);
  assertContiguous(env, 9, 1);
  assert.equal(getRoadmapItem(moved.id, env).priority, 9);
  assert.throws(() => updateRoadmapItem(moved.id, { priority: 0 }, env), /expected an integer 1-9/);
});

test("by hand every status is accepted but in_progress, backwards moves included, and closed_at follows done", (t) => {
  const env = makeHome(t, "roadmap-update");
  makeProject(t, env, "alpha");
  const item = addItem(env, { title: "deliver the roadmap", detail: "with priorities" });

  const updated = updateRoadmapItem(item.id, { title: "deliver the roadmap CLI", detail: null }, env);
  assert.equal(updated.title, "deliver the roadmap CLI");
  assert.equal(updated.detail, "with priorities");
  for (const status of ["backlog", "todo", "in_review", "cancelled"]) {
    assert.equal(updateRoadmapItem(item.id, { status }, env).status, status);
    assert.equal(getRoadmapItem(item.id, env).closed_at, null);
  }
  const done = updateRoadmapItem(item.id, { status: "done" }, env);
  assert.equal(done.status, "done");
  assert.notEqual(done.closed_at, null);
  const reopened = updateRoadmapItem(item.id, { status: "in_review" }, env);
  assert.equal(reopened.status, "in_review");
  assert.equal(reopened.closed_at, null);
  assert.throws(() => updateRoadmapItem(item.id, { status: "in_progress" }, env), /`in_progress` is set only by a job/);
  assert.throws(() => updateRoadmapItem(item.id, { status: "open" }, env), /expected one of backlog\|todo\|in_review\|done\|cancelled/);
  assert.throws(() => updateRoadmapItem(9999, { title: "x" }, env), /unknown roadmap item `9999`/);
  assert.throws(() => addItem(env, { title: "y", status: "in_progress" }), /`in_progress` is set only by a job/);
});

test("the linked decision must exist and belong to the project of the item", (t) => {
  const env = makeHome(t, "roadmap-decision");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const decision = saveDecision({ project: "alpha", title: "one worktree per job", context: "races", decision: "split" }, env);
  const foreign = saveDecision({ project: "beta", title: "beta decision", context: "c", decision: "d" }, env);

  const item = addItem(env, { title: "deliver it", decision_id: decision.id });
  assert.equal(getRoadmapItem(item.id, env).decision_id, decision.id);
  assert.equal(listRoadmap("alpha", {}, env).items[0].decision_number, decision.number);
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
  linkRoadmapItemJob(item.id, job.id, env);

  const statusOnly = updateRoadmapItem(item.id, { status: "todo" }, env);
  assert.equal(statusOnly.decision_number, decision.number);
  assert.equal(statusOnly.job_status, "pending");
  assert.equal(getRoadmapItem(item.id, env).decision_id, decision.id);

  const relinked = updateRoadmapItem(item.id, { decision_id: other.id }, env);
  assert.equal(relinked.decision_number, other.number);
  assert.equal(getRoadmapItem(item.id, env).decision_id, other.id);
  assert.equal(listRoadmap("alpha", {}, env).items[0].decision_number, other.number);
  assert.equal(listRoadmap("alpha", {}, env).items[0].job_status, "pending");
});

test("an item is linked once, refused while its job is live, and refused again once closed", (t) => {
  const env = makeHome(t, "roadmap-queue-link");
  makeProject(t, env, "alpha");
  const item = addItem(env, { title: "deliver the roadmap" });
  const job = addJob({ project: "alpha", prompt: "deliver the roadmap" }, env);

  assert.equal(queueableRoadmapItem(item.id, env).id, item.id);
  assert.equal(linkRoadmapItemJob(item.id, job.id, env), true);
  const linked = getRoadmapItem(item.id, env);
  assert.equal(linked.status, "in_progress");
  assert.equal(linked.job_id, job.id);
  assert.equal(linked.job_status_seen, "pending");
  assert.throws(() => queueableRoadmapItem(item.id, env), new RegExp(`already queued as job \`${job.id}\``));
  assert.equal(listRoadmap("alpha", {}, env).items[0].job_status, "pending");

  cancelJob(job.id, { reason: "not now" }, env);
  assert.equal(queueableRoadmapItem(item.id, env).id, item.id);

  updateRoadmapItem(item.id, { status: "done" }, env);
  assert.throws(() => queueableRoadmapItem(item.id, env), /is `done`; move it back to `todo`/);
  updateRoadmapItem(item.id, { status: "cancelled" }, env);
  assert.throws(() => queueableRoadmapItem(item.id, env), /is `cancelled`/);
  assert.throws(() => queueableRoadmapItem(9999, env), /unknown roadmap item `9999`/);
});
