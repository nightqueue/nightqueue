import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { insertComment } from "../../src/memory/roadmap-comments.mjs";
import { searchRoadmap } from "../../src/memory/roadmap-search.mjs";
import { saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { makeHome, makeProject, seedLegacyV16Roadmap } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

// A home with two projects of `acme` and one of `orbit`.
function makeSearchHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta", { org: "acme" });
  makeProject(t, env, "gamma", { org: "orbit" });
  return env;
}

// Saves one improvement item of an owner.
function item(env, owner, title, detail = null) {
  return saveRoadmapItem({ type: "improvement", ...owner, title, detail }, env);
}

// Appends a runtime-shaped comment to an item, optionally under a project and with recorded files.
function comment(env, itemId, { body = "job done", project = null, files = [] } = {}) {
  const refs = { job_id: 1, pr: null, branch: null, sha: null, files: files.map((path) => ({ path })), decision_id: null };
  insertComment(openDb(env), { itemId, kind: "pr", author: "job:1", body, refs, project });
}

// The ids of the hits, in order.
function ids(hits) {
  return hits.map((hit) => hit.id);
}

test("a search returns at most five hits, and the limit is clamped to 1..5", (t) => {
  const env = makeSearchHome(t, "roadmap-search-limit");
  for (let n = 0; n < 7; n += 1) item(env, { project: "alpha" }, `upgrade node step ${n}`);
  assert.equal(searchRoadmap({ project: "alpha", query: "node" }, env).length, 5);
  assert.equal(searchRoadmap({ project: "alpha", query: "node", limit: 2 }, env).length, 2);
  assert.equal(searchRoadmap({ project: "alpha", query: "node", limit: 99 }, env).length, 5);
  assert.throws(() => searchRoadmap({ project: "alpha" }, env), /needs `query`, `file` or both/);
});

test("a search matches the title, the detail and a comment, and names how it matched", (t) => {
  const env = makeSearchHome(t, "roadmap-search-text");
  const titled = item(env, { project: "alpha" }, "rotate the webhook secret");
  const detailed = item(env, { project: "alpha" }, "security chores", "the webhook signing key must rotate");
  const commented = item(env, { project: "alpha" }, "unrelated title");
  comment(env, commented.id, { body: "the webhook retries twice" });
  item(env, { project: "alpha" }, "nothing to see");

  const hits = searchRoadmap({ project: "alpha", query: "webhook" }, env);
  assert.deepEqual(ids(hits).sort(), [titled.id, detailed.id, commented.id].sort());
  assert.equal(hits.find((hit) => hit.id === commented.id).via, "comment");
  assert.equal(hits.find((hit) => hit.id === titled.id).via, "text");
  assert.deepEqual(Object.keys(hits[0]).sort(), ["id", "priority", "ref", "status", "title", "type", "via"]);
  assert.equal(hits.find((hit) => hit.id === titled.id).ref, `alpha#${titled.id}`);
});

test("a file search matches a recorded path exactly or by prefix, first, and takes % and _ literally", (t) => {
  const env = makeSearchHome(t, "roadmap-search-file");
  const touched = item(env, { project: "alpha" }, "the runner rewrite");
  comment(env, touched.id, { files: ["src/queue/runner.mjs", "src/ax.mjs"] });
  const texty = item(env, { project: "alpha" }, "mentions runner in text");

  assert.deepEqual(ids(searchRoadmap({ project: "alpha", file: "src/queue/runner.mjs" }, env)), [touched.id]);
  assert.deepEqual(ids(searchRoadmap({ project: "alpha", file: "src/queue/" }, env)), [touched.id]);
  assert.deepEqual(searchRoadmap({ project: "alpha", file: "src/_x" }, env), []);
  assert.deepEqual(searchRoadmap({ project: "alpha", file: "src/%" }, env), []);
  assert.deepEqual(searchRoadmap({ project: "alpha", file: "SRC/queue" }, env), []);

  const both = searchRoadmap({ project: "alpha", file: "src/queue/runner.mjs", query: "runner" }, env);
  assert.deepEqual(ids(both), [touched.id, texty.id], "the file match leads, the text match follows, each item once");
  assert.equal(both[0].via, "file");
});

test("a project finds its org's items but never another org's item nor a sibling project's comment", (t) => {
  const env = makeSearchHome(t, "roadmap-search-visibility");
  const orgItem = item(env, { org: "acme" }, "pin the toolchain");
  const otherOrg = item(env, { org: "orbit" }, "pin the toolchain too");
  const sibling = item(env, { project: "beta" }, "pin beta toolchain");
  comment(env, orgItem.id, { body: "beta hit a snag with pnpm", project: "beta", files: ["beta/only.mjs"] });
  comment(env, orgItem.id, { body: "alpha is fine with pnpm", project: "alpha" });

  assert.deepEqual(ids(searchRoadmap({ project: "alpha", query: "toolchain" }, env)), [orgItem.id]);
  assert.deepEqual(searchRoadmap({ project: "alpha", query: "snag" }, env), [], "a sibling project's comment leaked");
  assert.deepEqual(searchRoadmap({ project: "alpha", file: "beta/only.mjs" }, env), [], "a sibling project's file leaked");
  assert.deepEqual(ids(searchRoadmap({ project: "alpha", query: "pnpm" }, env)), [orgItem.id]);
  assert.deepEqual(ids(searchRoadmap({ project: "beta", query: "snag" }, env)), [orgItem.id]);
  assert.deepEqual(ids(searchRoadmap({ org: "acme", query: "toolchain" }, env)), [orgItem.id]);
  assert.equal(ids(searchRoadmap({ project: "alpha", query: "toolchain" }, env)).includes(otherOrg.id), false);
  assert.equal(ids(searchRoadmap({ project: "alpha", query: "toolchain" }, env)).includes(sibling.id), false);
});

test("the FTS finds a legacy title right after the v17 migration", (t) => {
  const env = makeSearchHome(t, "roadmap-search-legacy");
  seedLegacyV16Roadmap(env, {
    items: [{ id: 4, project: "alpha", horizon: "now", status: "open", position: 1, title: "legacy flamingo title" }],
  });
  assert.deepEqual(ids(searchRoadmap({ project: "alpha", query: "flamingo" }, env)), [4]);
});

// Connects a real stdio client to `nightshift mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

test("roadmap_search inside a job reads only the job's project, and refuses another owner by name", async (t) => {
  const env = makeSearchHome(t, "roadmap-search-mcp");
  const orgItem = item(env, { org: "acme" }, "shared cache layer");
  comment(env, orgItem.id, { body: "beta cache miss", project: "beta" });
  item(env, { project: "beta" }, "beta cache layer");
  const job = addJob({ project: "alpha", prompt: "work" }, env);
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

  const own = JSON.parse(textOf(await client.callTool({ name: "roadmap_search", arguments: { query: "cache" } })));
  assert.equal(own.project, "alpha");
  assert.deepEqual(ids(own.hits), [orgItem.id]);
  const miss = JSON.parse(textOf(await client.callTool({ name: "roadmap_search", arguments: { query: "miss" } })));
  assert.deepEqual(miss.hits, []);

  const foreign = await client.callTool({ name: "roadmap_search", arguments: { query: "cache", project: "beta" } });
  assert.equal(foreign.isError, true);
  assert.match(textOf(foreign), /inside a job `roadmap_search` reads the job's project `alpha`/);
});
