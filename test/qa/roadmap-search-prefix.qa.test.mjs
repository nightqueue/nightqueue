import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { insertComment } from "../../src/memory/roadmap-comments.mjs";
import { searchRoadmap } from "../../src/memory/roadmap-search.mjs";
import { saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// H-A1: fileHits (src/memory/roadmap-search.mjs:38-43) does a raw `substr` prefix
// comparison with no path-boundary check, so a query for "src/queue" also matches a
// sibling directory whose name merely starts with the same characters, e.g.
// "src/queue2/report.mjs". This PoC proves that over-match from the user's point of
// view: searching for "src/queue" must return only items whose file refs are under
// src/queue/ (or exactly src/queue), never an unrelated sibling like src/queue2/*.

// Saves one improvement item of the given project.
function item(env, project, title) {
  return saveRoadmapItem({ project, type: "improvement", title }, env);
}

// Appends a runtime-shaped comment to an item with the given recorded file paths.
function comment(env, itemId, files) {
  const refs = { job_id: 1, pr: null, branch: null, sha: null, files: files.map((path) => ({ path })), decision_id: null };
  insertComment(openDb(env), { itemId, kind: "pr", author: "job:1", body: "job done", refs, project: null });
}

// The ids of the hits, in order.
function ids(hits) {
  return hits.map((hit) => hit.id);
}

test("a file search for a directory prefix excludes a sibling directory that merely shares the prefix", (t) => {
  const env = makeHome(t, "roadmap-search-prefix");
  makeProject(t, env, "alpha", { org: "acme" });

  const sibling = item(env, "alpha", "unrelated report tool");
  comment(env, sibling.id, ["src/queue2/report.mjs"]);

  const real = item(env, "alpha", "queue rewrite");
  comment(env, real.id, ["src/queue/x.mjs"]);

  const hits = searchRoadmap({ project: "alpha", file: "src/queue" }, env);

  assert.equal(ids(hits).includes(sibling.id), false, "src/queue2/report.mjs must not match a search for src/queue");
  assert.deepEqual(ids(hits), [real.id]);
});
