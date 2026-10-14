import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
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

test("a job renders its ref whatever the keys of its project and org", async (t) => {
  const { env, db, orgId, projectId } = makeKeyedHome(t, "refs-render-jobs");
  const job = addJob({ projectId, prompt: "deliver the second item" }, env);

  registry.setProjectKey(db, { id: projectId, key: "NX" });
  registry.setOrgKey(db, { id: orgId, key: "DLX" });

  const detail = await jobDetailView(openStore(env), job.id);
  assert.equal(detail.ref, `J-${job.id}`);
  assert.equal(Object.hasOwn(detail, "item_ref"), false);
});
