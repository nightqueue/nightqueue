import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { getJob } from "../../src/memory/jobs.mjs";
import {
  getRoadmapItem,
  listRoadmap,
  queueRoadmapItem,
  saveRoadmapItem,
  updateRoadmapItem,
} from "../../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Saves a roadmap item of an owner with the fields every test would otherwise repeat.
function addItem(env, { project, org, horizon = "now", title, detail, decision_id }) {
  return saveRoadmapItem({ project, org, horizon, title, detail, decision_id }, env);
}

// A home with the two orgs of the brief: two projects in `acme`, one in `orbit`.
function makeTwoOrgHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "acme-mobile-app", { org: "acme" });
  makeProject(t, env, "acme-api", { org: "acme" });
  makeProject(t, env, "orbit-app", { org: "orbit" });
  return env;
}

// Titles of a horizon group, in the order the roadmap returns them.
function titlesOf(roadmap, horizon) {
  return roadmap.horizons.find((group) => group.horizon === horizon).items.map((item) => item.title);
}

// Positions an owner holds in a horizon, straight from the database.
function positionsOf(env, horizon, { project = null, org = null }) {
  return openDb(env)
    .prepare(
      "SELECT title, position FROM roadmap_items WHERE project IS ? AND org IS ? AND horizon = ? ORDER BY position",
    )
    .all(project, org, horizon)
    .map((row) => [row.title, row.position]);
}

test("positions are counted inside one owner: two orgs and a project share a horizon without renumbering each other", (t) => {
  const env = makeTwoOrgHome(t, "roadmap-org-position");
  addItem(env, { org: "acme", title: "acme first" });
  const second = addItem(env, { org: "acme", title: "acme second" });
  addItem(env, { org: "orbit", title: "orbit first" });
  addItem(env, { project: "acme-mobile-app", title: "project first" });
  assert.equal(second.position, 2);

  updateRoadmapItem(second.id, { position: 1 }, env);
  assert.deepEqual(positionsOf(env, "now", { org: "acme" }), [
    ["acme second", 1],
    ["acme first", 2],
  ]);
  assert.deepEqual(positionsOf(env, "now", { org: "orbit" }), [["orbit first", 1]]);
  assert.deepEqual(positionsOf(env, "now", { project: "acme-mobile-app" }), [["project first", 1]]);
});

test("a project roadmap shows its org's items first and never another org's", (t) => {
  const env = makeTwoOrgHome(t, "roadmap-org-union");
  addItem(env, { project: "acme-mobile-app", title: "ship the app cache" });
  addItem(env, { org: "acme", title: "every repo ships the cache" });
  addItem(env, { org: "orbit", title: "orbit ships nothing" });

  assert.deepEqual(titlesOf(listRoadmap("acme-mobile-app", env), "now"), [
    "every repo ships the cache",
    "ship the app cache",
  ]);
  assert.deepEqual(titlesOf(listRoadmap("orbit-app", env), "now"), ["orbit ships nothing"]);
  assert.deepEqual(titlesOf(listRoadmap({ org: "acme" }, env), "now"), ["every repo ships the cache"]);
});

test("an item links a decision its owner sees: its own, or its org's for a project item, never a sibling project's", (t) => {
  const env = makeTwoOrgHome(t, "roadmap-org-decision");
  const orgDecision = saveDecision({ org: "acme", title: "one queue", context: "c", decision: "d" }, env);
  const projectDecision = saveDecision({ project: "acme-api", title: "api caches", context: "c", decision: "d" }, env);

  const item = addItem(env, { project: "acme-mobile-app", title: "follow the org", decision_id: orgDecision.id });
  assert.equal(getRoadmapItem(item.id, env).decision_id, orgDecision.id);
  assert.throws(
    () => addItem(env, { project: "acme-mobile-app", title: "steal", decision_id: projectDecision.id }),
    /belongs to project `acme-api`/,
  );
  assert.throws(
    () => addItem(env, { org: "acme", title: "steal", decision_id: projectDecision.id }),
    /belongs to project `acme-api`/,
  );
  const orgItem = addItem(env, { org: "acme", title: "org follows itself", decision_id: orgDecision.id });
  assert.equal(getRoadmapItem(orgItem.id, env).decision_id, orgDecision.id);
});

test("an org item queues one job per named project, stays open and unlinked, and refuses a project outside its org", async (t) => {
  const env = makeTwoOrgHome(t, "roadmap-org-queue");
  const item = addItem(env, { org: "acme", title: "raise the node version" });

  await assert.rejects(() => queueRoadmapItem({ id: item.id }, env), /belongs to org `acme`.*--project <name>/s);
  await assert.rejects(
    () => queueRoadmapItem({ id: item.id, project: "orbit-app" }, env),
    /projects of `acme`: acme-mobile-app, acme-api/,
  );

  const first = await queueRoadmapItem({ id: item.id, project: "acme-mobile-app" }, env);
  assert.equal(first.targetProject, "acme-mobile-app");
  assert.equal(getJob(first.job.id, env).project, "acme-mobile-app");
  const stored = getRoadmapItem(item.id, env);
  assert.equal(stored.status, "open", "an org item must stay open");
  assert.equal(stored.job_id, null, "an org item must never carry a job id");

  const second = await queueRoadmapItem({ id: item.id, project: "acme-api" }, env);
  assert.equal(second.targetProject, "acme-api");
  assert.notEqual(second.job.id, first.job.id, "the second project got no job of its own");
  assert.equal(getRoadmapItem(item.id, env).status, "open");
  assert.equal(updateRoadmapItem(item.id, { status: "done" }, env).status, "done", "the operator closes it by hand");
});

test("a project item keeps its own queue path: it is linked, and a project that is not its own is still refused", async (t) => {
  const env = makeTwoOrgHome(t, "roadmap-org-project-item");
  const item = addItem(env, { project: "acme-mobile-app", title: "ship the app cache" });

  await assert.rejects(
    () => queueRoadmapItem({ id: item.id, project: "acme-api" }, env),
    /belongs to project `acme-mobile-app`, not `acme-api`/,
  );
  const queued = await queueRoadmapItem({ id: item.id, project: "acme-mobile-app" }, env);
  assert.equal(queued.targetProject, "acme-mobile-app");
  const stored = getRoadmapItem(item.id, env);
  assert.equal(stored.status, "queued");
  assert.equal(stored.job_id, queued.job.id);
});
