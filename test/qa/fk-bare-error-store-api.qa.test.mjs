import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { linkPipelineRun } from "../../src/memory/jobs.mjs";
import { linkRoadmapItemJob, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { ensureProject, makeHome } from "../../test-support/memory.mjs";

// H3: a store writer fed a job that does not exist must answer a UserError naming the job, never the bare engine text.
function assertNamedRefusal(fn) {
  let caught = null;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, "the writer accepted a job that does not exist");
  assert.notEqual(caught.message, "FOREIGN KEY constraint failed", "bare engine error reached the caller");
  assert.match(caught.message, /999/, "the refusal does not name the missing job");
  assert.ok(caught instanceof UserError, `expected UserError, got ${caught.constructor.name}`);
}

test("linkRoadmapItemJob names a missing job instead of a bare FOREIGN KEY error", (t) => {
  const env = makeHome(t, "fk-h3-item");
  const projectId = ensureProject(env, "alpha");
  const item = saveRoadmapItem({ type: "improvement", projectId, priority: 2, title: "x" }, env);
  assertNamedRefusal(() => linkRoadmapItemJob(item.id, 999, env));
});

test("linkPipelineRun names a missing job instead of a bare FOREIGN KEY error", (t) => {
  const env = makeHome(t, "fk-h3-run");
  const projectId = ensureProject(env, "alpha");
  logPipelineRun({ projectId, slug: "fix-x", tier: "simple", outcome: "pr_opened" }, env);
  assertNamedRefusal(() => linkPipelineRun(999, { projectId, slug: "fix-x" }, env));
});
