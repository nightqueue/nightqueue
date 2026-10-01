import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, cancelJob } from "../../src/memory/jobs.mjs";
import {
  getIssue,
  linkIssueJob,
  listIssues,
  queueableIssue,
  saveIssue,
  updateIssue,
} from "../../src/memory/issues.mjs";
import { ensureProject, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

// Saves an issue of a project with the fields every test would otherwise repeat.
function addItem(env, { project = "alpha", priority, status, title, detail, decision_id }) {
  return saveIssue({ type: "improvement", projectId: projectIdOf(env, project), priority, status, title, detail, decision_id }, env);
}

// Titles of one priority group, in the order the issues listing returns them.
function titlesOf(env, priority) {
  return listIssues(projectIdOf(env, "alpha"), {}, env)
    .items.filter((item) => item.priority === priority)
    .map((item) => item.title);
}

// Positions a priority group holds in the database, plus the SQLite type of each one.
function positionsOf(env, priority) {
  return openDb(env)
    .prepare("SELECT position, typeof(position) AS kind FROM issues WHERE project_id IS ? AND priority = ? ORDER BY position")
    .all(projectIdOf(env, "alpha"), priority);
}

// Asserts a priority group holds the contiguous integer positions 1..N.
function assertContiguous(env, priority, total) {
  const rows = positionsOf(env, priority);
  assert.deepEqual(rows.map((row) => row.position), Array.from({ length: total }, (_, index) => index + 1));
  assert.deepEqual(new Set(rows.map((row) => row.kind)), new Set(total ? ["integer"] : []));
}

test("an item is appended at the end of its priority group, and the listing puts priority 1 first", (t) => {
  const env = makeHome(t, "issue-append");
  makeProject(t, env, "alpha");
  const first = addItem(env, { title: "first p5" });
  assert.equal(first.position, 1);
  assert.equal(first.priority, 5);
  assert.equal(first.status, "todo");
  assert.equal(addItem(env, { title: "second p5" }).position, 2);
  assert.equal(addItem(env, { priority: 2, title: "first p2" }).position, 1);

  const listing = listIssues(projectIdOf(env, "alpha"), {}, env);
  assert.equal(listing.project, "alpha");
  assert.deepEqual(listing.items.map((item) => item.title), ["first p2", "first p5", "second p5"]);
  assert.equal("horizon" in listing.items[0], false);
  assert.throws(() => addItem(env, { priority: 10, title: "x" }), /expected an integer 1-9/);
  assert.throws(() => addItem(env, { title: "" }), /issue field `title` is required/);
});

test("the retired horizon is refused by name on save and on update", (t) => {
  const env = makeHome(t, "issue-horizon");
  makeProject(t, env, "alpha");
  assert.throws(() => saveIssue({ type: "improvement", projectId: projectIdOf(env, "alpha"), horizon: "now", title: "x" }, env), /`horizon` was removed in schema v17: use `priority`/);
  const item = addItem(env, { title: "x" });
  assert.throws(() => updateIssue(item.id, { horizon: "next" }, env), /`horizon` was removed in schema v17/);
});

test("the listing groups by workflow status and narrows only by the filters it is given", (t) => {
  const env = makeHome(t, "issue-filters");
  makeProject(t, env, "alpha");
  addItem(env, { title: "delivered", status: "done" });
  addItem(env, { title: "later", status: "backlog", priority: 1 });
  addItem(env, { title: "next up", priority: 3 });
  addItem(env, { title: "dropped", status: "cancelled" });

  assert.deepEqual(listIssues(projectIdOf(env, "alpha"), {}, env).items.map((item) => item.title), ["later", "next up", "delivered", "dropped"]);
  assert.deepEqual(listIssues(projectIdOf(env, "alpha"), { status: ["todo", "done"] }, env).items.map((item) => item.title), ["next up", "delivered"]);
  assert.deepEqual(listIssues(projectIdOf(env, "alpha"), { priority: [1, 3] }, env).items.map((item) => item.title), ["later", "next up"]);
  assert.deepEqual(listIssues(projectIdOf(env, "alpha"), { status: [] }, env).items.length, 4);
  assert.throws(() => listIssues(projectIdOf(env, "alpha"), { status: ["open"] }, env), /invalid issue `status` filter `open`/);
  assert.throws(() => listIssues(projectIdOf(env, "alpha"), { priority: [0] }, env), /invalid issue `priority` filter `0`/);
});

test("moving an item inside its priority group renumbers the group to contiguous positions", (t) => {
  const env = makeHome(t, "issue-move-within");
  makeProject(t, env, "alpha");
  const first = addItem(env, { title: "a" });
  addItem(env, { title: "b" });
  const third = addItem(env, { title: "c" });

  updateIssue(first.id, { position: 3 }, env);
  assert.deepEqual(titlesOf(env, 5), ["b", "c", "a"]);
  assertContiguous(env, 5, 3);

  updateIssue(third.id, { position: 1 }, env);
  assert.deepEqual(titlesOf(env, 5), ["c", "b", "a"]);
  assertContiguous(env, 5, 3);

  updateIssue(third.id, { position: 99 }, env);
  assert.deepEqual(titlesOf(env, 5), ["b", "a", "c"]);
  assertContiguous(env, 5, 3);
});

test("a priority change moves the item to the end of its new group and leaves both groups contiguous", (t) => {
  const env = makeHome(t, "issue-move-across");
  makeProject(t, env, "alpha");
  addItem(env, { title: "a" });
  const moved = addItem(env, { title: "b" });
  addItem(env, { title: "c" });
  addItem(env, { priority: 2, title: "x" });

  updateIssue(moved.id, { priority: 2 }, env);
  assert.deepEqual(titlesOf(env, 5), ["a", "c"]);
  assert.deepEqual(titlesOf(env, 2), ["x", "b"]);
  assertContiguous(env, 5, 2);
  assertContiguous(env, 2, 2);

  updateIssue(moved.id, { priority: 9, position: 1 }, env);
  assert.deepEqual(titlesOf(env, 2), ["x"]);
  assert.deepEqual(titlesOf(env, 9), ["b"]);
  assertContiguous(env, 9, 1);
  assert.equal(getIssue(moved.id, env).priority, 9);
  assert.throws(() => updateIssue(moved.id, { priority: 0 }, env), /expected an integer 1-9/);
});

test("by hand every status is accepted but in_progress, backwards moves included, and closed_at follows done", (t) => {
  const env = makeHome(t, "issue-update");
  makeProject(t, env, "alpha");
  const item = addItem(env, { title: "deliver the issues", detail: "with priorities" });

  const updated = updateIssue(item.id, { title: "deliver the issues CLI", detail: null }, env);
  assert.equal(updated.title, "deliver the issues CLI");
  assert.equal(updated.detail, "with priorities");
  for (const status of ["backlog", "todo", "in_review", "cancelled"]) {
    assert.equal(updateIssue(item.id, { status }, env).status, status);
    assert.equal(getIssue(item.id, env).closed_at, null);
  }
  const done = updateIssue(item.id, { status: "done" }, env);
  assert.equal(done.status, "done");
  assert.notEqual(done.closed_at, null);
  const reopened = updateIssue(item.id, { status: "in_review" }, env);
  assert.equal(reopened.status, "in_review");
  assert.equal(reopened.closed_at, null);
  assert.throws(() => updateIssue(item.id, { status: "in_progress" }, env), /`in_progress` is set only by a job/);
  assert.throws(() => updateIssue(item.id, { status: "open" }, env), /expected one of backlog\|todo\|in_review\|done\|cancelled/);
  assert.throws(() => updateIssue(9999, { title: "x" }, env), /unknown issue `9999`/);
  assert.throws(() => addItem(env, { title: "y", status: "in_progress" }), /`in_progress` is set only by a job/);
});

test("the linked decision must exist and belong to the project of the item", (t) => {
  const env = makeHome(t, "issue-decision");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const decision = saveDecision({ projectId: projectIdOf(env, "alpha"), title: "one worktree per job", context: "races", decision: "split" }, env);
  const foreign = saveDecision({ projectId: projectIdOf(env, "beta"), title: "beta decision", context: "c", decision: "d" }, env);

  const item = addItem(env, { title: "deliver it", decision_id: decision.id });
  assert.equal(getIssue(item.id, env).decision_id, decision.id);
  assert.equal(listIssues(projectIdOf(env, "alpha"), {}, env).items[0].decision_number, decision.number);
  assert.throws(() => addItem(env, { title: "bad", decision_id: foreign.id }), /belongs to project `beta`/);
  assert.throws(() => updateIssue(item.id, { decision_id: 9999 }, env), /unknown decision `9999`/);
});

test("updateIssue answers the linked decision number and live job status the way issue_get does", (t) => {
  const env = makeHome(t, "issue-update-view");
  makeProject(t, env, "alpha");
  const decision = saveDecision({ projectId: projectIdOf(env, "alpha"), title: "one worktree per job", context: "races", decision: "split" }, env);
  const other = saveDecision({ projectId: projectIdOf(env, "alpha"), title: "second decision", context: "c", decision: "d" }, env);
  const item = addItem(env, { title: "deliver it", decision_id: decision.id });
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "deliver it" }, env);
  linkIssueJob(item.id, job.id, env);

  const statusOnly = updateIssue(item.id, { status: "todo" }, env);
  assert.equal(statusOnly.decision_number, decision.number);
  assert.equal(statusOnly.job_status, "pending");
  assert.equal(getIssue(item.id, env).decision_id, decision.id);

  const relinked = updateIssue(item.id, { decision_id: other.id }, env);
  assert.equal(relinked.decision_number, other.number);
  assert.equal(getIssue(item.id, env).decision_id, other.id);
  assert.equal(listIssues(projectIdOf(env, "alpha"), {}, env).items[0].decision_number, other.number);
  assert.equal(listIssues(projectIdOf(env, "alpha"), {}, env).items[0].job_status, "pending");
});

test("an item is linked once, refused while its job is live, and refused again once closed", (t) => {
  const env = makeHome(t, "issue-queue-link");
  makeProject(t, env, "alpha");
  const item = addItem(env, { title: "deliver the issues" });
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "deliver the issues" }, env);

  assert.equal(queueableIssue(item.id, env).id, item.id);
  assert.equal(linkIssueJob(item.id, job.id, env), true);
  const linked = getIssue(item.id, env);
  assert.equal(linked.status, "in_progress");
  assert.equal(linked.job_id, job.id);
  assert.equal(linked.job_status_seen, "pending");
  assert.throws(() => queueableIssue(item.id, env), new RegExp(`already queued as J-${job.id}`));
  assert.equal(listIssues(projectIdOf(env, "alpha"), {}, env).items[0].job_status, "pending");

  cancelJob(job.id, { reason: "not now" }, env);
  assert.equal(queueableIssue(item.id, env).id, item.id);

  updateIssue(item.id, { status: "done" }, env);
  assert.throws(() => queueableIssue(item.id, env), /is `done`; move it back to `todo`/);
  updateIssue(item.id, { status: "cancelled" }, env);
  assert.throws(() => queueableIssue(item.id, env), /is `cancelled`/);
  assert.throws(() => queueableIssue(9999, env), /unknown issue `9999`/);
});
