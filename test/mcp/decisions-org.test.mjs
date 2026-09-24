import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDecision, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { getRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

const ORG_DECISION = {
  org: "acme",
  title: "every repo of the product shares one queue",
  context: "six repos kept their own backlog",
  decision: "one nightqueue home per operator, one queue for the whole product",
};

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

// A home with one project of `acme` and one of `orbit`.
function makeOrgHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "acme-mobile-app", { org: "acme" });
  makeProject(t, env, "orbit-app", { org: "orbit" });
  return env;
}

test("decision_save and roadmap_save take project XOR org, and refuse both, neither and an unknown org", async (t) => {
  const env = makeOrgHome(t, "mcp-org-target");
  const client = await connect(t, env);

  const saved = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...ORG_DECISION, status: "accepted" } }));
  assert.deepEqual(saved, { ok: true, id: 1, number: 1, scope: "org", owner: "acme" });

  const both = await client.callTool({
    name: "decision_save",
    arguments: { ...ORG_DECISION, project: "acme-mobile-app" },
  });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /pass either `project` or `org`, never both/);

  const neither = await client.callTool({ name: "decision_save", arguments: { ...ORG_DECISION, org: null } });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /pass `project` .* or `org`/);

  const unknown = await client.callTool({ name: "roadmap_save", arguments: { type: "improvement", org: "ghost", title: "x" } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown org `ghost`/);
});

test("decision_list, decision_recall and roadmap_get answer the union for a project and the org alone for an org", async (t) => {
  const env = makeOrgHome(t, "mcp-org-union");
  const client = await connect(t, env);
  payloadOf(await client.callTool({ name: "decision_save", arguments: { ...ORG_DECISION, status: "accepted" } }));
  payloadOf(
    await client.callTool({
      name: "decision_save",
      arguments: {
        project: "acme-mobile-app",
        title: "the app caches the plan",
        context: "c",
        decision: "d",
        status: "accepted",
      },
    }),
  );
  payloadOf(await client.callTool({ name: "roadmap_save", arguments: { type: "improvement", org: "acme", title: "raise node" } }));
  payloadOf(
    await client.callTool({ name: "roadmap_save", arguments: { type: "improvement", project: "acme-mobile-app", title: "deliver the cache" } }),
  );

  const listed = payloadOf(await client.callTool({ name: "decision_list", arguments: { project: "acme-mobile-app" } }));
  assert.equal(listed.project, "acme-mobile-app");
  assert.deepEqual(
    listed.decisions.map((row) => [row.scope, row.owner, row.number]),
    [
      ["org", "acme", 1],
      ["project", "acme-mobile-app", 1],
    ],
  );

  const recalled = payloadOf(
    await client.callTool({ name: "decision_recall", arguments: { project: "acme-mobile-app", query: "queue plan" } }),
  );
  assert.equal(recalled[0].scope, "org");
  assert.equal(recalled[0].owner, "acme");

  const roadmap = payloadOf(await client.callTool({ name: "roadmap_get", arguments: { project: "acme-mobile-app" } }));
  assert.deepEqual(
    roadmap.items.map((item) => [item.scope, item.owner, item.title]),
    [
      ["org", "acme", "raise node"],
      ["project", "acme-mobile-app", "deliver the cache"],
    ],
  );

  const orgOnly = payloadOf(await client.callTool({ name: "decision_list", arguments: { org: "acme" } }));
  assert.deepEqual(orgOnly, { org: "acme", decisions: orgOnly.decisions });
  assert.deepEqual(orgOnly.decisions.map((row) => row.owner), ["acme"]);
  const foreign = payloadOf(await client.callTool({ name: "decision_list", arguments: { project: "orbit-app" } }));
  assert.deepEqual(foreign.decisions, [], "a acme decision reached a orbit project");
});

test("inside a job, an org row is refused by name while the job's own project is still writable", async (t) => {
  const env = makeOrgHome(t, "mcp-org-write-guard");
  const orgDecision = saveDecision({ ...ORG_DECISION, status: "accepted" }, env);
  const orgItem = saveRoadmapItem({ type: "improvement", org: "acme", title: "raise node" }, env);
  const own = saveDecision(
    { project: "acme-mobile-app", title: "the app caches", context: "c", decision: "d", status: "accepted" },
    env,
  );
  const job = addJob({ project: "acme-mobile-app", prompt: "rewrite the runner" }, env);
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const decision = await client.callTool({ name: "decision_update", arguments: { id: orgDecision.id, status: "rejected" } });
  assert.equal(decision.isError, true);
  assert.match(textOf(decision), /it belongs to org `acme`, not `acme-mobile-app`/);
  const item = await client.callTool({ name: "roadmap_update", arguments: { id: orgItem.id, status: "cancelled" } });
  assert.equal(item.isError, true);
  assert.match(textOf(item), /it belongs to org `acme`/);

  assert.equal(getDecision(orgDecision.id, env).status, "accepted", "the refused update reached the org decision");
  assert.equal(getRoadmapItem(orgItem.id, env).status, "todo", "the refused update reached the org item");
  const mine = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: own.id, status: "rejected" } }));
  assert.equal(mine.decision.status, "rejected", "a job must still update its own project");

  const recalled = payloadOf(
    await client.callTool({ name: "decision_recall", arguments: { project: "acme-mobile-app", query: "queue" } }),
  );
  assert.ok(
    recalled.some((row) => row.id === orgDecision.id),
    "a job must still READ the decisions of its org",
  );
});
