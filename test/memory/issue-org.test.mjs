import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { getJob } from "../../src/memory/jobs.mjs";
import {
  getIssue,
  listIssues,
  queueIssue,
  saveIssue,
  updateIssue,
} from "../../src/memory/issues.mjs";
import { makeHome, makeProject, orgIdOf, projectIdOf } from "../../test-support/memory.mjs";

// Saves an issue of an owner with the fields every test would otherwise repeat.
function addItem(env, { project, org, title, detail, decision_id }) {
  return saveIssue({ type: "improvement", projectId: projectIdOf(env, project), orgId: orgIdOf(env, org), title, detail, decision_id }, env);
}

// A home with the two orgs of the brief: two projects in `acme`, one in `orbit`.
function makeTwoOrgHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "acme-mobile-app", { org: "acme" });
  makeProject(t, env, "acme-api", { org: "acme" });
  makeProject(t, env, "orbit-app", { org: "orbit" });
  return env;
}

// Titles of an issue listing, in the order it returns them.
function titlesOf(listing) {
  return listing.items.map((item) => item.title);
}

// Positions an owner holds in a priority group, straight from the database.
function positionsOf(env, priority, { project = null, org = null }) {
  return openDb(env)
    .prepare(
      "SELECT title, position FROM issues WHERE project_id IS ? AND org_id IS ? AND priority = ? ORDER BY position",
    )
    .all(projectIdOf(env, project), orgIdOf(env, org), priority)
    .map((row) => [row.title, row.position]);
}

test("positions are counted inside one owner: two orgs and a project share a priority without renumbering each other", (t) => {
  const env = makeTwoOrgHome(t, "issue-org-position");
  addItem(env, { org: "acme", title: "acme first" });
  const second = addItem(env, { org: "acme", title: "acme second" });
  addItem(env, { org: "orbit", title: "orbit first" });
  addItem(env, { project: "acme-mobile-app", title: "project first" });
  assert.equal(second.position, 2);

  updateIssue(second.id, { position: 1 }, env);
  assert.deepEqual(positionsOf(env, 5, { org: "acme" }), [
    ["acme second", 1],
    ["acme first", 2],
  ]);
  assert.deepEqual(positionsOf(env, 5, { org: "orbit" }), [["orbit first", 1]]);
  assert.deepEqual(positionsOf(env, 5, { project: "acme-mobile-app" }), [["project first", 1]]);
});

test("a project listing shows its org's items first and never another org's", (t) => {
  const env = makeTwoOrgHome(t, "issue-org-union");
  addItem(env, { project: "acme-mobile-app", title: "deliver the app cache" });
  addItem(env, { org: "acme", title: "every repo delivers the cache" });
  addItem(env, { org: "orbit", title: "orbit delivers nothing" });

  assert.deepEqual(titlesOf(listIssues(projectIdOf(env, "acme-mobile-app"), {}, env)), [
    "every repo delivers the cache",
    "deliver the app cache",
  ]);
  assert.deepEqual(titlesOf(listIssues(projectIdOf(env, "orbit-app"), {}, env)), ["orbit delivers nothing"]);
  assert.deepEqual(titlesOf(listIssues({ orgId: orgIdOf(env, "acme") }, {}, env)), ["every repo delivers the cache"]);
});

test("an item links a decision its owner sees: its own, or its org's for a project item, never a sibling project's", (t) => {
  const env = makeTwoOrgHome(t, "issue-org-decision");
  const orgDecision = saveDecision({ orgId: orgIdOf(env, "acme"), title: "one queue", context: "c", decision: "d" }, env);
  const projectDecision = saveDecision({ projectId: projectIdOf(env, "acme-api"), title: "api caches", context: "c", decision: "d" }, env);

  const item = addItem(env, { project: "acme-mobile-app", title: "follow the org", decision_id: orgDecision.id });
  assert.equal(getIssue(item.id, env).decision_id, orgDecision.id);
  assert.throws(
    () => addItem(env, { project: "acme-mobile-app", title: "steal", decision_id: projectDecision.id }),
    /belongs to project `acme-api`/,
  );
  assert.throws(
    () => addItem(env, { org: "acme", title: "steal", decision_id: projectDecision.id }),
    /belongs to project `acme-api`/,
  );
  const orgItem = addItem(env, { org: "acme", title: "org follows itself", decision_id: orgDecision.id });
  assert.equal(getIssue(orgItem.id, env).decision_id, orgDecision.id);
});

test("an org item queues one job per named project on its own row, stays unlinked itself, and refuses a project outside its org", async (t) => {
  const env = makeTwoOrgHome(t, "issue-org-queue");
  const item = addItem(env, { org: "acme", title: "raise the node version" });

  await assert.rejects(() => queueIssue({ id: item.id }, env), /belongs to org `acme`.*--project <name\|all>/s);
  await assert.rejects(
    () => queueIssue({ id: item.id, projectId: projectIdOf(env, "orbit-app") }, env),
    /projects of `acme`: acme-mobile-app, acme-api/,
  );

  const first = await queueIssue({ id: item.id, projectId: projectIdOf(env, "acme-mobile-app") }, env);
  assert.equal(first.targetProject, "acme-mobile-app");
  assert.equal(getJob(first.job.id, env).project, "acme-mobile-app");
  const stored = getIssue(item.id, env);
  assert.equal(stored.status, "in_progress", "an org item derives its status from its in-progress row");
  assert.equal(stored.job_id, null, "an org item must never carry a job id");

  const second = await queueIssue({ id: item.id, projectId: projectIdOf(env, "acme-api") }, env);
  assert.equal(second.targetProject, "acme-api");
  assert.notEqual(second.job.id, first.job.id, "the second project got no job of its own");
  assert.equal(getIssue(item.id, env).status, "in_progress");
  assert.equal(updateIssue(item.id, { status: "done" }, env).status, "done", "the operator closes it by hand");
});

test("a project item keeps its own queue path: it is linked, and a project that is not its own is still refused", async (t) => {
  const env = makeTwoOrgHome(t, "issue-org-project-item");
  const item = addItem(env, { project: "acme-mobile-app", title: "deliver the app cache" });

  await assert.rejects(
    () => queueIssue({ id: item.id, projectId: projectIdOf(env, "acme-api") }, env),
    /belongs to project `acme-mobile-app`, not `acme-api`/,
  );
  const queued = await queueIssue({ id: item.id, projectId: projectIdOf(env, "acme-mobile-app") }, env);
  assert.equal(queued.targetProject, "acme-mobile-app");
  const stored = getIssue(item.id, env);
  assert.equal(stored.status, "in_progress");
  assert.equal(stored.job_id, queued.job.id);
});
