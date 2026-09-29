import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { queueRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { publishedBodyFile } from "../../src/queue/pr-footer.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

// H-B1: prose that merely starts like a trail line ("Roadmap:", "Refs are…") once made the runtime believe the trail was
// already there and skip it. The footer is now appended unconditionally from the job row, so prose never suppresses it.
test("a PR body whose prose merely starts like a trail line still gets exactly one footer of the job's item", async (t) => {
  const env = makeHome(t, "pr-footer-false-positive");
  makeProject(t, env, "alpha");
  const runDir = makeDir(t, "pr-footer-false-positive-run");
  const bodyFile = join(makeDir(t, "pr-footer-false-positive-body"), "body.md");
  writeFileSync(bodyFile, "Roadmap: this PR is step one of the migration roadmap.\n\nRefs are resolved at the edge.\n\n## Report\n\nthe thing is done.\n");
  const store = openStore(env);

  const item = saveRoadmapItem({ type: "feature", projectId: projectIdOf(env, "alpha"), title: "ship it" }, env);
  const { job } = await queueRoadmapItem({ id: item.id }, env);

  const text = readFileSync(await publishedBodyFile({ bodyFile, runDir, jobId: job.id, store }), "utf8");

  assert.deepEqual(text.split("\n").filter((line) => line === `Refs ${item.ref}`), [`Refs ${item.ref}`], JSON.stringify(text));
  assert.ok(text.endsWith(`\n\nRefs ${item.ref}\n\nOpened by nightqueue · ${item.ref}\n`), JSON.stringify(text));
});
