import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDecision, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { getRoadmapItem, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

const SCHEMAS = {
  decision_save: {
    properties: ["consequences", "context", "decision", "org", "project", "status", "title"],
    required: ["context", "decision", "title"],
  },
  decision_update: {
    properties: ["consequences", "context", "decision", "id", "status", "superseded_by", "title"],
    required: ["id"],
  },
  decision_list: { properties: ["org", "project", "status"], required: [] },
  decision_recall: { properties: ["limit", "org", "project", "query"], required: [] },
  roadmap_save: {
    properties: ["decision_id", "detail", "horizon", "org", "project", "title"],
    required: ["horizon", "title"],
  },
  roadmap_update: {
    properties: ["decision_id", "detail", "horizon", "id", "position", "status", "title"],
    required: ["id"],
  },
  roadmap_get: { properties: ["org", "project"], required: [] },
};

const DECISION = {
  project: "alpha",
  title: "the queue keeps one job per deliverable",
  context: "jobs that depended on each other deadlocked the batch",
  decision: "cut every job so it can be reviewed and merged on its own",
  consequences: "a large plan becomes one job with numbered stages",
};

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

// A home with one registered project, the only shape these tools accept.
function makeDecisionHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

test("the seven decision and roadmap tools carry the input schema of the contract", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-schema");
  const client = await connect(t, env);
  const tools = (await client.listTools()).tools;

  for (const [name, expected] of Object.entries(SCHEMAS)) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `the ${name} tool is missing`);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), expected.properties, name);
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), expected.required, name);
  }
});

test("the handshake tells the agent what decisions and the roadmap are for", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-instructions");
  const client = await connect(t, env);

  const instructions = client.getInstructions();
  for (const line of [
    "decisions are the project's standing constraints - recall them before proposing architecture and save one when the user settles a design question",
    'the roadmap is where "what next" lives - read it before suggesting work, and queue from it with `roadmap_item_id`',
  ]) {
    assert.ok(instructions.includes(line), `\`${line}\` is missing from the instructions:\n${instructions}`);
  }
});

test("a decision saved through the server is numbered, listed, updated and recalled", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-round-trip");
  const client = await connect(t, env);

  const saved = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...DECISION, status: "accepted" } }));
  assert.deepEqual(saved, { ok: true, id: 1, number: 1, scope: "project", owner: "alpha" });
  const second = payloadOf(
    await client.callTool({
      name: "decision_save",
      arguments: { ...DECISION, title: "embeddings stay optional", consequences: null, status: "proposed" },
    }),
  );
  assert.equal(second.number, 2);

  const listed = payloadOf(await client.callTool({ name: "decision_list", arguments: { project: "alpha", status: null } }));
  assert.equal(listed.project, "alpha");
  assert.deepEqual(
    listed.decisions.map((row) => [row.number, row.status]),
    [
      [1, "accepted"],
      [2, "proposed"],
    ],
  );

  const updated = payloadOf(
    await client.callTool({ name: "decision_update", arguments: { id: second.id, status: "accepted", superseded_by: null } }),
  );
  assert.equal(updated.decision.status, "accepted");
  assert.equal(updated.decision.number, 2);

  const recalled = payloadOf(
    await client.callTool({ name: "decision_recall", arguments: { project: "alpha", query: "embeddings", limit: null } }),
  );
  assert.deepEqual(
    recalled.map((row) => row.number),
    [2],
  );
  assert.equal(recalled[0].context, DECISION.context);
});

test("a missing or invalid status falls back to proposed and flags it; a valid one is untouched", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-status-default");
  const client = await connect(t, env);

  const noStatus = payloadOf(await client.callTool({ name: "decision_save", arguments: DECISION }));
  assert.equal(noStatus.status_defaulted, true);
  assert.equal(getDecision(noStatus.id, env).status, "proposed");

  const badStatus = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...DECISION, title: "a second one", status: "maybe" } }));
  assert.equal(badStatus.status_defaulted, true);
  assert.equal(getDecision(badStatus.id, env).status, "proposed");

  const explicit = payloadOf(
    await client.callTool({ name: "decision_save", arguments: { ...DECISION, title: "a third one", status: "accepted" } }),
  );
  assert.equal("status_defaulted" in explicit, false);
  assert.equal(getDecision(explicit.id, env).status, "accepted");
});

test("decision_recall never returns a proposed decision and never truncates, where decision_list truncates", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-truncation");
  const client = await connect(t, env);
  const title = `worker ${"x".repeat(600)}`;

  payloadOf(await client.callTool({ name: "decision_save", arguments: { ...DECISION, title, status: "accepted" } }));
  payloadOf(
    await client.callTool({
      name: "decision_save",
      arguments: { ...DECISION, title: "worker pools are never shared", status: "proposed" },
    }),
  );

  const listed = payloadOf(await client.callTool({ name: "decision_list", arguments: { project: "alpha" } }));
  assert.equal(listed.decisions[0].title, `${title.slice(0, 500)}...`);

  const recalled = payloadOf(await client.callTool({ name: "decision_recall", arguments: { project: "alpha", query: "worker" } }));
  assert.deepEqual(
    recalled.map((row) => row.number),
    [1],
  );
  assert.equal(recalled[0].title, title);

  const updated = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: 1, status: "superseded" } }));
  assert.equal(updated.decision.title, `${title.slice(0, 500)}...`, "decision_update is not one of the untruncated surfaces");
  assert.deepEqual(Object.keys(updated.decision).sort(), ["id", "number", "owner", "scope", "status", "title", "updated_at"]);
});

test("the roadmap tools order a project by horizon and refuse a status only the queue may set", async (t) => {
  const env = makeDecisionHome(t, "mcp-roadmap-tools");
  const client = await connect(t, env);
  const decision = payloadOf(await client.callTool({ name: "decision_save", arguments: DECISION }));

  const first = payloadOf(
    await client.callTool({
      name: "roadmap_save",
      arguments: { project: "alpha", horizon: "now", title: "split the runner", detail: null, decision_id: decision.id },
    }),
  );
  const second = payloadOf(
    await client.callTool({ name: "roadmap_save", arguments: { project: "alpha", horizon: "now", title: "index the logs" } }),
  );
  assert.deepEqual([first.position, second.position], [1, 2]);

  const moved = payloadOf(await client.callTool({ name: "roadmap_update", arguments: { id: second.id, position: 1 } }));
  assert.equal(moved.item.position, 1);

  const roadmap = payloadOf(await client.callTool({ name: "roadmap_get", arguments: { project: "alpha" } }));
  assert.deepEqual(
    roadmap.horizons.map((group) => group.horizon),
    ["now", "next", "later"],
  );
  assert.deepEqual(
    roadmap.horizons[0].items.map((item) => [item.position, item.title, item.decision_number, item.job_status]),
    [
      [1, "index the logs", null, null],
      [2, "split the runner", 1, null],
    ],
  );

  const refused = await client.callTool({ name: "roadmap_update", arguments: { id: first.id, status: "queued" } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /only becomes `queued` through `queue_add` with `roadmap_item_id`/);

  const unknownProject = await client.callTool({ name: "roadmap_get", arguments: { project: "ghost" } });
  assert.equal(unknownProject.isError, true);
  assert.match(textOf(unknownProject), /pass the registered project NAME/);
});

// A home with two projects, each carrying one decision and one roadmap item, plus a job of the first one.
function makeTwoProjectHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const own = saveDecision({ ...DECISION, project: "alpha", status: "accepted" }, env);
  const foreign = saveDecision({ ...DECISION, project: "beta", title: "beta keeps its own log", status: "accepted" }, env);
  const foreignItem = saveRoadmapItem({ project: "beta", horizon: "now", title: "beta ships its dashboard" }, env);
  const job = addJob({ project: "alpha", prompt: "rewrite the runner" }, env);
  return { env, own, foreign, foreignItem, job };
}

test("inside a job, decision_update and roadmap_update refuse a row of another project and change nothing", async (t) => {
  const { env, own, foreign, foreignItem, job } = makeTwoProjectHome(t, "mcp-decisions-cross-project");
  const client = await connect(t, { ...env, NIGHTSHIFT_JOB_ID: String(job.id) });

  const decision = await client.callTool({ name: "decision_update", arguments: { id: foreign.id, status: "rejected" } });
  assert.equal(decision.isError, true);
  assert.match(textOf(decision), new RegExp(`refusing to update decision \`${foreign.id}\` from inside job \`${job.id}\``));
  assert.match(textOf(decision), /it belongs to project `beta`, not `alpha`/);

  const item = await client.callTool({ name: "roadmap_update", arguments: { id: foreignItem.id, status: "dropped" } });
  assert.equal(item.isError, true);
  assert.match(textOf(item), new RegExp(`refusing to update roadmap item \`${foreignItem.id}\` from inside job \`${job.id}\``));

  assert.equal(getDecision(foreign.id, env).status, "accepted", "the refused update reached the other project's decision");
  assert.equal(getRoadmapItem(foreignItem.id, env).status, "open", "the refused update reached the other project's item");

  const mine = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: own.id, status: "rejected" } }));
  assert.equal(mine.decision.status, "rejected", "a job must still update its own project");
});

test("outside a job the ownership guard restricts nothing: the operator updates any project", async (t) => {
  const { env, foreign, foreignItem } = makeTwoProjectHome(t, "mcp-decisions-operator-scope");
  const client = await connect(t, env);

  const decision = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: foreign.id, status: "rejected" } }));
  assert.equal(decision.decision.status, "rejected");
  const item = payloadOf(await client.callTool({ name: "roadmap_update", arguments: { id: foreignItem.id, status: "dropped" } }));
  assert.equal(item.item.status, "dropped");
});
