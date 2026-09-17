import assert from "node:assert/strict";
import { test } from "node:test";
import { addJob, claimJobById, getJob, releaseJob } from "../../src/memory/jobs.mjs";
import { acquire } from "../../src/queue/claim.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Deterministic interleave: right when `acquire`'s refusal path re-reads the job to phrase the
// reason, another process claims-then-releases it back to pending in that exact instant.
// A `getJob` call that races a release must never report a job as "not-pending" when it is,
// at that very read, genuinely pending again.
test("with no ceiling, a job that raced back to pending is never explained as not-pending", async (t) => {
  const env = makeHome(t, "claim-no-cap-refusal-race");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;

  // A ghost worker claims the job first, so the caller under test finds it already running.
  const claimed = claimJobById(id, { worker: "ghost-worker", cap: null }, env);
  assert.equal(claimed.id, id, "setup: the ghost worker must own the job before the race");

  const store = openStore(env);
  const realGetJob = store.jobs.getJob;
  let released = false;
  store.jobs.getJob = async (jobId) => {
    if (jobId === id && !released) {
      released = true;
      const changed = releaseJob(id, { worker: "ghost-worker", result: null }, env);
      assert.equal(changed, true, "setup: the race release must land before the reread");
    }
    return realGetJob(jobId);
  };

  let result;
  try {
    result = await acquire({ jobId: id, cap: null, env });
  } finally {
    store.jobs.getJob = realGetJob;
  }

  assert.equal(released, true, "setup: the injected race must have fired");
  const rowAfter = getJob(id, env);
  assert.equal(rowAfter.status, "pending", "setup: the row is genuinely pending at the moment acquire answers");
  assert.notEqual(result.reason, "not-pending", `acquire reported "${result.reason}" for a job that is genuinely pending: ${JSON.stringify(result)}`);
});
