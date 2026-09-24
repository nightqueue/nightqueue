import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queueRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { roadmapBodyFile } from "../../src/queue/roadmap-trail.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

// H-B1: ROADMAP_LINE (/^Roadmap:\s/m) matches ANY line starting with "Roadmap:" anywhere in the
// body, not only the runtime's own trailer. An agent that writes prose starting with "Roadmap:"
// (not a trailer at all, and not naming the job's own item) makes roadmapBodyFile believe the
// trailer is already present, so it silently returns the original bodyFile — the real
// "Roadmap: <ref>" line the git trail depends on is never appended.
test("a PR body whose prose merely starts with 'Roadmap:' still gets the job's real Roadmap trailer appended", async (t) => {
  const env = makeHome(t, "roadmap-trail-false-positive");
  makeProject(t, env, "alpha");
  const runDir = makeDir(t, "roadmap-trail-false-positive-run");
  const bodyFile = join(makeDir(t, "roadmap-trail-false-positive-body"), "body.md");
  // Agent prose whose first paragraph happens to start with "Roadmap:" but is not the trailer,
  // and does not name the job's own item.
  writeFileSync(
    bodyFile,
    "Roadmap: this PR is step one of the migration roadmap.\n\n## Report\n\nthe thing is done.\n"
  );
  const store = openStore(env);

  const item = saveRoadmapItem({ type: "feature", project: "alpha", title: "ship it" }, env);
  const { job } = await queueRoadmapItem({ id: item.id }, env);

  const published = await roadmapBodyFile({ bodyFile, runDir, jobId: job.id, store });
  const text = readFileSync(published, "utf8");

  const trailerLines = text.split("\n").filter((line) => line === `Roadmap: alpha#${item.id}`);
  assert.equal(
    trailerLines.length,
    1,
    `expected exactly one "Roadmap: alpha#${item.id}" trailer line in the published body, got: ${JSON.stringify(text)}`
  );
});
