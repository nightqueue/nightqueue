import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { addJob } from "../../src/memory/jobs.mjs";
import { queueRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { ROADMAP_BODY_FILE, roadmapBodyFile } from "../../src/queue/roadmap-trail.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const BODY = "## Report\n\nthe thing is done.\n\n";

// A home with one project, a run directory and the agent's body file.
function makeTrailHome(t, name, body = BODY) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const runDir = makeDir(t, `${name}-run`);
  const bodyFile = join(makeDir(t, `${name}-body`), "body.md");
  writeFileSync(bodyFile, body);
  return { env, runDir, bodyFile, store: openStore(env) };
}

// The sha-256 of a file, to prove the agent's body was never edited.
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("a job queued from a roadmap item publishes a copy of the body ending with its Roadmap line, once, and the agent's file is unchanged", async (t) => {
  const { env, runDir, bodyFile, store } = makeTrailHome(t, "roadmap-trail-linked");
  const item = saveRoadmapItem({ type: "feature", project: "alpha", title: "ship it" }, env);
  const { job } = await queueRoadmapItem({ id: item.id }, env);
  const before = hashOf(bodyFile);

  const first = await roadmapBodyFile({ bodyFile, runDir, jobId: job.id, store });
  const second = await roadmapBodyFile({ bodyFile, runDir, jobId: job.id, store });

  assert.equal(first, join(runDir, ROADMAP_BODY_FILE));
  assert.equal(second, first);
  const published = readFileSync(first, "utf8");
  assert.equal(published, `## Report\n\nthe thing is done.\n\nRoadmap: alpha#${item.id}\n`);
  assert.equal(published.match(/^Roadmap:/gm).length, 1);
  assert.equal(hashOf(bodyFile), before, "the agent's body file was edited");
});

test("a job queued from an org item for one project ends its body with the org item's Roadmap line", async (t) => {
  const { env, runDir, bodyFile, store } = makeTrailHome(t, "roadmap-trail-org");
  makeProject(t, env, "beta", { org: "acme" });
  makeProject(t, env, "gamma", { org: "acme" });
  const item = saveRoadmapItem({ type: "chore", org: "acme", title: "pin node" }, env);
  const { jobs } = await queueRoadmapItem({ id: item.id, project: "all" }, env);
  assert.equal(jobs.length, 2);

  for (const job of jobs) {
    const published = await roadmapBodyFile({ bodyFile, runDir, jobId: job.id, store });
    assert.match(readFileSync(published, "utf8"), new RegExp(`\\n\\nRoadmap: acme#${item.id}\\n$`));
  }
});

test("the body is published as written outside a job, for a job with no roadmap item, and when it already names one", async (t) => {
  const { env, runDir, bodyFile, store } = makeTrailHome(t, "roadmap-trail-absent");
  const plain = addJob({ project: "alpha", prompt: "fix it" }, env);
  assert.equal(await roadmapBodyFile({ bodyFile, runDir, jobId: null, store }), bodyFile);
  assert.equal(await roadmapBodyFile({ bodyFile, runDir, jobId: plain.id, store }), bodyFile);

  const named = makeTrailHome(t, "roadmap-trail-named", `${BODY}Roadmap: alpha#1\n`);
  const item = saveRoadmapItem({ type: "bug", project: "alpha", title: "fix it" }, named.env);
  const { job } = await queueRoadmapItem({ id: item.id }, named.env);
  assert.equal(await roadmapBodyFile({ ...named, jobId: job.id }), named.bodyFile);
});

test("a store that cannot answer costs the Roadmap line, never the pull request", async (t) => {
  const { runDir, bodyFile } = makeTrailHome(t, "roadmap-trail-broken");
  const store = { roadmap: { roadmapRefOfJob: async () => { throw new Error("database is locked"); } } };
  assert.equal(await roadmapBodyFile({ bodyFile, runDir, jobId: 1, store }), bodyFile);
});
