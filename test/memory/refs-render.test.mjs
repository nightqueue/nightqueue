import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { decisionView, listDecisions, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { decisionRef } from "../../src/memory/refs.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { getIssueDetail, linkIssueJob, listIssues, issueRefOfJob, saveIssue } from "../../src/memory/issues.mjs";
import { jobDetailView } from "../../src/queue/view.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// A home with org `dlweb` (key DLW) and its project `nightqueue` (key NQ), the ids every test reads by.
function makeKeyedHome(t, name) {
  const env = makeHome(t, name);
  const db = openDb(env);
  const org = registry.insertOrg(db, "dlweb", "DLW");
  const project = registry.insertProject(db, { name: "nightqueue", path: null, orgId: org.id, key: "NQ" });
  return { env, db, orgId: org.id, projectId: project.id };
}

// Saves one accepted decision of an owner.
function decide(env, owner, title) {
  return saveDecision({ ...owner, title, context: "c", decision: "d", status: "accepted" }, env);
}

// Saves one roadmap item of an owner.
function plan(env, owner, title, extra = {}) {
  return saveIssue({ type: "improvement", ...owner, title, ...extra }, env);
}

// The refs of a listing, keyed by title.
function refsByTitle(rows) {
  return Object.fromEntries(rows.map((row) => [row.title, row.ref]));
}

test("items, decisions and jobs render their refs for a project, an org and the global owner", async (t) => {
  const { env, orgId, projectId } = makeKeyedHome(t, "refs-render-owners");
  const orgRule = decide(env, { orgId }, "one queue per product");
  decide(env, { projectId }, "the runner owns its lease");
  decide(env, { projectId: null }, "everything is UTC");

  const first = plan(env, { projectId }, "first project item");
  const second = plan(env, { projectId }, "second project item", { decision_id: orgRule.id });
  const orgItem = plan(env, { orgId }, "org item");
  const globalItem = plan(env, { projectId: null }, "global item");
  assert.deepEqual([first.ref, second.ref, orgItem.ref, globalItem.ref], ["NQ-1", "NQ-2", "DLW-1", "G-1"]);

  assert.deepEqual(refsByTitle(listDecisions({ projectId }, env).map(decisionView)), {
    "one queue per product": "DLW/D-1",
    "the runner owns its lease": "D-1",
    "everything is UTC": "G/D-1",
  });

  const job = addJob({ projectId, prompt: "deliver the second item" }, env);
  assert.equal(linkIssueJob(second.id, job.id, env), true);
  const items = listIssues({ projectId }, {}, env).items;
  assert.deepEqual(refsByTitle(items), {
    "first project item": "NQ-1",
    "second project item": "NQ-2",
    "org item": "DLW-1",
    "global item": "G-1",
  });
  const linked = items.find((item) => item.id === second.id);
  assert.equal(linked.decision_ref, "DLW/D-1");
  assert.equal(linked.job_ref, `J-${job.id}`);

  const detail = await jobDetailView(openStore(env), job.id);
  assert.equal(detail.ref, `J-${job.id}`);
  assert.equal(detail.item_ref, "NQ-2");
});

test("a key rename is read at once by the roadmap, the decisions, the job view and the item thread, and history text stays", async (t) => {
  const { env, db, orgId, projectId } = makeKeyedHome(t, "refs-render-rename");
  decide(env, { orgId }, "one queue per product");
  const item = plan(env, { projectId }, "project item");
  const job = addJob({ projectId, prompt: "deliver it" }, env);
  assert.equal(linkIssueJob(item.id, job.id, env), true);

  registry.setProjectKey(db, { id: projectId, key: "NX" });
  registry.setOrgKey(db, { id: orgId, key: "DLX" });

  assert.deepEqual(listIssues({ projectId }, {}, env).items.map((row) => row.ref), ["NX-1"]);
  assert.deepEqual(listDecisions({ projectId }, env).map(decisionRef), ["DLX/D-1"]);
  assert.equal(issueRefOfJob(job.id, env), "NX-1");
  assert.equal((await jobDetailView(openStore(env), job.id)).item_ref, "NX-1");

  const detail = getIssueDetail(item.id, {}, env);
  assert.equal(detail.ref, "NX-1");
  assert.deepEqual(detail.comments.map((comment) => comment.body), [`J-${job.id} queued`]);
});
