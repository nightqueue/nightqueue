import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, getJob, listJobs } from "../../src/memory/jobs.mjs";
import {
  getRoadmapItem,
  getRoadmapItemDetail,
  listRoadmap,
  roadmapDrift,
  roadmapRefOfJob,
  saveRoadmapItem,
  updateRoadmapItem,
} from "../../src/memory/roadmap.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject, settleThroughStore } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const PR_URL = "https://github.com/acme/alpha/pull/7";
const DB_MODULE_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;
const PROJECTS_MODULE_URL = new URL("../../src/memory/roadmap-projects.mjs", import.meta.url).href;

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// A home with two projects of `acme`, one of `orbit`, and one org roadmap item every project has to do.
function makeOrgItemHome(t, name) {
  const env = makeHome(t, name);
  const cwd = makeProject(t, env, "acme-mobile-app", { org: "acme" });
  makeProject(t, env, "acme-api", { org: "acme" });
  makeProject(t, env, "orbit-app", { org: "orbit" });
  const item = saveRoadmapItem({ type: "improvement", org: "acme", title: "raise the node version" }, env);
  return { env, cwd, item };
}

// The project rows of an item as `project: status`, sorted by project.
function rowStatuses(env, itemId) {
  return Object.fromEntries(
    openDb(env)
      .prepare("SELECT project, status FROM roadmap_item_projects WHERE item_id = ? ORDER BY project")
      .all(itemId)
      .map((row) => [row.project, row.status]),
  );
}

// The comments of an item as `kind project`, in order.
function commentTrail(env, itemId) {
  return openDb(env)
    .prepare("SELECT kind, project FROM roadmap_comments WHERE item_id = ? ORDER BY id")
    .all(itemId)
    .map((row) => `${row.kind} ${row.project ?? "-"}`);
}

// Claims the job and finishes it on the given status, through the store the runner uses.
async function runTo(store, jobId, status, { prUrl } = {}) {
  assert.ok(await store.jobs.claimJobById(jobId, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(await store.jobs.finishJob(jobId, { worker: "w1", status, prUrl }), true, "setup: the job was not finished");
}

test("queue_add on an org item requires a project of that org or `all`, and links a project row, never the item", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-mcp");
  const client = await connect(t, env);

  const bare = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } });
  assert.equal(bare.isError, true);
  assert.match(textOf(bare), /belongs to org `acme`: name the project its job goes to, or `all`/);
  const outside = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "orbit-app" } });
  assert.equal(outside.isError, true);
  assert.match(textOf(outside), /projects of `acme`: acme-mobile-app, acme-api/);

  const queued = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "acme-mobile-app" } }),
  );
  assert.equal(queued.project, "acme-mobile-app");
  assert.equal(queued.roadmapItemId, item.id);
  assert.deepEqual(queued.jobs, [{ id: queued.id, project: "acme-mobile-app" }]);
  assert.deepEqual(queued.skipped, []);
  assert.match(queued.hint, /`in_progress` while any row is, `done` once every row is done or cancelled/);
  assert.equal(
    getJob(queued.id, env).prompt,
    "## Task\nraise the node version\n\n## Roadmap item\nRoadmap: acme#1\nType: improvement\nCommit type: refactor or perf",
  );
  const row = getRoadmapItem(item.id, env);
  assert.equal(row.status, "in_progress", "the org status is derived from its one in-progress row");
  assert.equal(row.job_id, null, "the org item's own row never carries a job");
  assert.deepEqual(rowStatuses(env, item.id), { "acme-mobile-app": "in_progress" });
  assert.equal(roadmapRefOfJob(queued.id, env), "acme#1");

  const again = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "acme-mobile-app" } });
  assert.equal(again.isError, true);
  assert.match(textOf(again), /already queued for `acme-mobile-app` \(job `1`, `pending`\)/);

  const all = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "all" } }));
  assert.deepEqual(all.jobs.map((job) => job.project), ["acme-api"]);
  assert.deepEqual(all.skipped, [{ project: "acme-mobile-app", job_id: queued.id, job_status: "pending" }]);
  assert.match(all.hint, /Skipped, a live job already holds them: `acme-mobile-app`/);
  assert.deepEqual(rowStatuses(env, item.id), { "acme-api": "in_progress", "acme-mobile-app": "in_progress" });
});

test("the prompt of an org item quotes the decisions of its org and nothing of another org", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-prompt");
  const linked = saveDecision(
    {
      org: "acme",
      title: "every repo runs one node version",
      context: "drift",
      decision: "pin it in the toolchain",
      status: "accepted",
    },
    env,
  );
  saveDecision({ org: "orbit", title: "orbit pins node too", context: "drift", decision: "pin it" }, env);
  const client = await connect(t, env);
  payloadOf(await client.callTool({ name: "roadmap_update", arguments: { id: item.id, decision_id: linked.id } }));

  const queued = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "acme-api" } }),
  );
  const prompt = getJob(queued.id, env).prompt;
  assert.ok(prompt.includes("## Linked decision\nacme#1 every repo runs one node version (accepted)"), prompt);
  assert.equal(prompt.includes("orbit pins node too"), false, "a decision of another org reached the prompt");
});

test("nightqueue queue add --roadmap needs --project <name|all> for an org item, never the current directory", (t) => {
  const { env, cwd, item } = makeOrgItemHome(t, "roadmap-org-queue-cli");
  const elsewhere = makeDir(t, "roadmap-org-queue-cwd");

  const fromCwd = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id)], { env, cwd, encoding: "utf8" });
  assert.equal(fromCwd.status, 1);
  assert.match(fromCwd.stderr, /--project <name\|all>/);

  const runAll = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id), "--project", "all", "--run"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(runAll.status, 1);
  assert.match(runAll.stderr, /`--run` starts one job/);

  const named = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id), "--project", "acme-api"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /roadmap item #1 of org `acme` queued for `acme-api`; its status is derived from its project rows/);

  const all = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id), "--project", "all"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /queued for `acme-mobile-app`/);
  assert.match(all.stdout, /skipped `acme-api`: job #1 \(pending\) still holds it/);
  assert.deepEqual(listJobs({ limit: 10 }, env).map((job) => job.project).sort(), ["acme-api", "acme-mobile-app"]);
  assert.equal(getRoadmapItem(item.id, env).status, "in_progress");

  const matrix = spawnSync(process.execPath, [CLI, "roadmap", "--org", "acme"], { env, cwd: elsewhere, encoding: "utf8" });
  assert.equal(matrix.status, 0, matrix.stderr);
  assert.match(matrix.stdout, /in_progress:\n {2}p5 acme #1 raise the node version\n {5}acme-api: in_progress job #1 \(pending\)\n {5}acme-mobile-app: in_progress job #2 \(pending\)/);
  const project = spawnSync(process.execPath, [CLI, "roadmap", "--project", "acme-api"], { env, cwd: elsewhere, encoding: "utf8" });
  assert.equal(project.status, 0, project.stderr);
  assert.match(project.stdout, /p5 acme #1 raise the node version \(in_progress\)/);
  assert.doesNotMatch(project.stdout, /acme-mobile-app/);
});

test("an org item queued for `all` derives its status from every row, and closes once the last job is closed", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-lifecycle");
  const store = openStore(env);
  const queued = await store.roadmap.queueRoadmapItem({ id: item.id, project: "all" });
  const [app, api] = ["acme-mobile-app", "acme-api"].map((name) => queued.jobs.find((job) => job.project === name));
  assert.equal(queued.jobs.length, 2);
  assert.equal(getRoadmapItem(item.id, env).status, "in_progress");

  await runTo(store, app.id, "done", { prUrl: PR_URL });
  assert.deepEqual(rowStatuses(env, item.id), { "acme-api": "in_progress", "acme-mobile-app": "in_review" });
  assert.equal(getRoadmapItem(item.id, env).status, "in_progress");

  await runTo(store, api.id, "failed");
  assert.deepEqual(rowStatuses(env, item.id), { "acme-api": "todo", "acme-mobile-app": "in_review" });
  assert.equal(getRoadmapItem(item.id, env).status, "todo", "the lowest open row status");

  await store.jobs.retryJob(api.id, {});
  assert.equal(getRoadmapItem(item.id, env).status, "in_progress");
  await runTo(store, api.id, "done", { prUrl: PR_URL });
  assert.equal(getRoadmapItem(item.id, env).status, "in_review");

  await settleThroughStore(store, app.id);
  assert.equal(getRoadmapItem(item.id, env).status, "in_review");
  await settleThroughStore(store, api.id);
  const closed = getRoadmapItem(item.id, env);
  assert.equal(closed.status, "done");
  assert.notEqual(closed.closed_at, null);
  assert.equal(closed.job_id, null);
  assert.deepEqual(roadmapDrift(env), []);

  const trail = commentTrail(env, item.id);
  assert.ok(trail.includes("queued acme-api") && trail.includes("queued acme-mobile-app"), trail.join(", "));
  assert.ok(trail.includes("pr acme-mobile-app") && trail.includes("failed acme-api"), trail.join(", "));
  assert.equal(trail.at(-1), "closed -", "the org-level comment of the derived close has no project");
});

test("closing an org item by hand cancels its open rows with one comment each, and leaves a done row alone", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-manual-close");
  const store = openStore(env);
  const queued = await store.roadmap.queueRoadmapItem({ id: item.id, project: "all" });
  const app = queued.jobs.find((job) => job.project === "acme-mobile-app");
  await runTo(store, app.id, "done", { prUrl: PR_URL });
  await settleThroughStore(store, app.id);
  assert.deepEqual(rowStatuses(env, item.id), { "acme-api": "in_progress", "acme-mobile-app": "done" });

  const cancelled = updateRoadmapItem(item.id, { status: "cancelled" }, env);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(rowStatuses(env, item.id), { "acme-api": "cancelled", "acme-mobile-app": "done" });
  const closing = openDb(env)
    .prepare("SELECT author, project, body FROM roadmap_comments WHERE item_id = ? AND kind = 'closed' AND author = 'operator'")
    .all(item.id);
  assert.deepEqual(closing.map((row) => [row.author, row.project]), [["operator", "acme-api"]]);
  assert.match(closing[0].body, /set to `cancelled` by the operator/);
  assert.deepEqual(roadmapDrift(env), [], "a hand-cancelled item whose rows are all closed agrees with its derivation");
});

test("a project reads only its own row and its own comments of an org item; the org reads the whole matrix", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-visibility");
  const store = openStore(env);
  await store.roadmap.queueRoadmapItem({ id: item.id, project: "all" });
  await store.roadmap.addRoadmapComment({ id: item.id, body: "api only", author: "operator", viewer: "acme-api" });

  const api = listRoadmap({ project: "acme-api" }, {}, env).items[0];
  assert.equal(api.project_status, "in_progress");
  assert.equal(api.projects, undefined);
  const org = listRoadmap({ org: "acme" }, {}, env).items[0];
  assert.deepEqual(org.projects.map((row) => row.project), ["acme-api", "acme-mobile-app"]);

  const seenByApp = getRoadmapItemDetail(item.id, { viewer: "acme-mobile-app" }, env);
  assert.deepEqual(seenByApp.projects.map((row) => row.project), ["acme-mobile-app"]);
  assert.ok(seenByApp.comments.every((comment) => comment.project === null || comment.project === "acme-mobile-app"));
  assert.equal(seenByApp.comments.some((comment) => comment.body === "api only"), false);
  const operator = getRoadmapItemDetail(item.id, {}, env);
  assert.equal(operator.projects.length, 2);
  assert.ok(operator.comments.some((comment) => comment.body === "api only"));
});

// Source of a child process that tries, for a while, to link its own job to the same project row of an org item.
function linkerSource() {
  return [
    `import { openDb } from ${JSON.stringify(DB_MODULE_URL)};`,
    `import { linkOrgRow } from ${JSON.stringify(PROJECTS_MODULE_URL)};`,
    "const [, , itemRaw, jobRaw, durationRaw] = process.argv;",
    "const deadline = Date.now() + Number(durationRaw);",
    "let linked = 0;",
    "while (Date.now() < deadline) {",
    "  if (linkOrgRow(openDb(process.env), { itemId: Number(itemRaw), project: 'acme-api', jobId: Number(jobRaw) })) linked += 1;",
    "}",
    "process.stdout.write(String(linked));",
  ].join("\n");
}

// Runs one linker process to its end and returns how many times it linked.
function runLinker(script, env, { itemId, jobId }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, String(itemId), String(jobId), "400"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr, linked: Number(stdout) }));
  });
}

test("two processes linking their own job to the same project row at once leave one link and one queued comment", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-race");
  const jobs = [1, 2].map(() => addJob({ project: "acme-api", prompt: "raise node" }, env));
  const script = join(makeDir(t, "roadmap-org-queue-race-script"), "linker.mjs");
  writeFileSync(script, linkerSource(), "utf8");

  const results = await Promise.all(jobs.map((job) => runLinker(script, env, { itemId: item.id, jobId: job.id })));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.equal(results.reduce((sum, result) => sum + result.linked, 0), 1, "exactly one process linked the row");
  const rows = openDb(env).prepare("SELECT job_id FROM roadmap_item_projects WHERE item_id = ?").all(item.id);
  assert.equal(rows.length, 1);
  assert.ok(jobs.some((job) => job.id === rows[0].job_id));
  assert.deepEqual(commentTrail(env, item.id), ["queued acme-api", "note -"], "one queued comment, one derived move to in_progress");
});
