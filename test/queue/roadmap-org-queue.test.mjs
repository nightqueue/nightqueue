import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { getJob, listJobs } from "../../src/memory/jobs.mjs";
import { getRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

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
  const item = saveRoadmapItem({ org: "acme", horizon: "now", title: "raise the node version" }, env);
  return { env, cwd, item };
}

test("queue_add on an org item requires a project of that org and never links the item to the job", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-mcp");
  const client = await connect(t, env);

  const bare = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } });
  assert.equal(bare.isError, true);
  assert.match(textOf(bare), /belongs to org `acme`/);
  const outside = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "orbit-app" } });
  assert.equal(outside.isError, true);
  assert.match(textOf(outside), /projects of `acme`: acme-mobile-app, acme-api/);

  const queued = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "acme-mobile-app" } }),
  );
  assert.equal(queued.project, "acme-mobile-app");
  assert.equal(queued.roadmapItemId, item.id);
  assert.match(queued.hint, /stays `open` and unlinked/);
  assert.equal(getJob(queued.id, env).prompt, "## Task\nraise the node version");
  const row = getRoadmapItem(item.id, env);
  assert.equal(row.status, "open");
  assert.equal(row.job_id, null);

  const second = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "acme-api" } }),
  );
  assert.equal(second.project, "acme-api", "the item was refused a second project while the first job was alive");
});

test("the prompt of an org item quotes the decisions of its org and nothing of another org", async (t) => {
  const { env, item } = makeOrgItemHome(t, "roadmap-org-queue-prompt");
  const linked = saveDecision(
    { org: "acme", title: "every repo runs one node version", context: "drift", decision: "pin it in the toolchain" },
    env,
  );
  saveDecision({ org: "orbit", title: "orbit pins node too", context: "drift", decision: "pin it" }, env);
  const client = await connect(t, env);
  payloadOf(await client.callTool({ name: "roadmap_update", arguments: { id: item.id, decision_id: linked.id } }));

  const queued = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, project: "acme-api" } }),
  );
  const prompt = getJob(queued.id, env).prompt;
  assert.ok(prompt.includes("## Linked decision\ndlw#1 every repo runs one node version (accepted)"), prompt);
  assert.equal(prompt.includes("orbit pins node too"), false, "a decision of another org reached the prompt");
});

test("nightshift queue add --roadmap --project queues an org item, and the current directory answers for it", (t) => {
  const { env, cwd, item } = makeOrgItemHome(t, "roadmap-org-queue-cli");
  const elsewhere = makeDir(t, "roadmap-org-queue-cwd");

  const named = spawnSync(
    process.execPath,
    [CLI, "queue", "add", "--roadmap", String(item.id), "--project", "acme-api"],
    { env, cwd: elsewhere, encoding: "utf8" },
  );
  assert.equal(named.status, 0, named.stderr);
  assert.match(named.stdout, /roadmap item #1 of org `acme` queued for `acme-api`; it stays `open` until you mark it done/);

  const fromCwd = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id)], {
    env,
    cwd,
    encoding: "utf8",
  });
  assert.equal(fromCwd.status, 0, fromCwd.stderr);
  assert.match(fromCwd.stdout, /project `acme-mobile-app` resolved from the current directory/);

  const nowhere = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id)], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(nowhere.status, 1);
  assert.match(nowhere.stderr, /--project <name>/);
  assert.deepEqual(
    listJobs({ limit: 10 }, env).map((job) => job.project).sort(),
    ["acme-api", "acme-mobile-app"],
  );
  assert.equal(getRoadmapItem(item.id, env).status, "open");
});

test("`--project` names the project of a prompt job, stays inside the prompt as a word, and is refused twice", (t) => {
  const env = makeHome(t, "queue-add-project-flag");
  makeProject(t, env, "alpha");
  const elsewhere = makeDir(t, "queue-add-project-cwd");
  const flagged = spawnSync(process.execPath, [CLI, "queue", "add", "--project", "alpha", "rewrite the runner"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(flagged.status, 0, flagged.stderr);
  assert.deepEqual([listJobs({ limit: 1 }, env)[0].project, listJobs({ limit: 1 }, env)[0].prompt], [
    "alpha",
    "rewrite the runner",
  ]);

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "alpha", "fix the --project flag"], {
    env,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(listJobs({ limit: 1 }, env)[0].prompt, "fix the --project flag");

  const twice = spawnSync(process.execPath, [CLI, "queue", "add", "--project", "alpha", "alpha", "rewrite the runner"], {
    env,
    encoding: "utf8",
  });
  assert.equal(twice.status, 1);
  assert.match(twice.stderr, /name the project once/);
});
