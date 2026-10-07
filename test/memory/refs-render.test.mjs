import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { decisionView, listDecisions, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { decisionRef } from "../../src/memory/refs.mjs";
import * as registry from "../../src/memory/registry.mjs";
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

// The refs of a listing, keyed by title.
function refsByTitle(rows) {
  return Object.fromEntries(rows.map((row) => [row.title, row.ref]));
}

test("decisions and jobs render their refs for a project, an org and the global owner", async (t) => {
  const { env, orgId, projectId } = makeKeyedHome(t, "refs-render-owners");
  decide(env, { orgId }, "one queue per product");
  decide(env, { projectId }, "the runner owns its lease");
  decide(env, { projectId: null }, "everything is UTC");

  assert.deepEqual(refsByTitle(listDecisions({ projectId }, env).map(decisionView)), {
    "one queue per product": "DLW/D-1",
    "the runner owns its lease": "D-1",
    "everything is UTC": "G/D-1",
  });

  const job = addJob({ projectId, prompt: "deliver the second item" }, env);
  const detail = await jobDetailView(openStore(env), job.id);
  assert.equal(detail.ref, `J-${job.id}`);
  assert.equal(Object.hasOwn(detail, "item_ref"), false);
});

test("a key rename is read at once by the decisions", (t) => {
  const { env, db, orgId, projectId } = makeKeyedHome(t, "refs-render-rename");
  decide(env, { orgId }, "one queue per product");

  registry.setProjectKey(db, { id: projectId, key: "NX" });
  registry.setOrgKey(db, { id: orgId, key: "DLX" });

  assert.deepEqual(listDecisions({ projectId }, env).map(decisionRef), ["DLX/D-1"]);
});
