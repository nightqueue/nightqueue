import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/memory/db.mjs";
import { getDecision, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

const SCHEMAS = {
  decision_save: {
    properties: ["consequences", "context", "decision", "org", "project", "status", "supersedes", "title", "unrelated"],
    required: ["context", "decision", "title"],
  },
  decision_update: {
    properties: ["consequences", "context", "decision", "id", "project", "status", "superseded_by", "title"],
    required: ["id"],
  },
  decision_list: { properties: ["org", "project", "status"], required: [] },
  decision_recall: { properties: ["id", "limit", "org", "project", "query"], required: [] },
};

const DECISION = {
  project: "alpha",
  title: "the queue keeps one job per deliverable",
  context: "jobs that depended on each other deadlocked the batch",
  decision: "cut every job so it can be reviewed and merged on its own",
  consequences: "a large plan becomes one job with numbered stages",
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

// A home with one registered project, the only shape these tools accept.
function makeDecisionHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

test("the four decision tools carry the input schema of the contract, and no issue tool is left", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-schema");
  const client = await connect(t, env);
  const tools = (await client.listTools()).tools;

  for (const [name, expected] of Object.entries(SCHEMAS)) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool, `the ${name} tool is missing`);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), expected.properties, name);
    assert.deepEqual([...(tool.inputSchema.required ?? [])].sort(), expected.required, name);
  }
  assert.deepEqual(tools.filter((tool) => tool.name.startsWith("issue_")).map((tool) => tool.name), []);
});

test("the handshake tells the agent what decisions are for, and names no issue", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-instructions");
  const client = await connect(t, env);

  const instructions = client.getInstructions();
  for (const line of [
    "decisions are the project's standing constraints - recall them before proposing architecture and save one when the user settles a design question",
  ]) {
    assert.ok(instructions.includes(line), `\`${line}\` is missing from the instructions:\n${instructions}`);
  }
  assert.equal(/issue/i.test(instructions), false, instructions);
});

test("a decision saved through the server is numbered, listed, updated and recalled", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-round-trip");
  const client = await connect(t, env);

  const saved = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...DECISION, status: "accepted" } }));
  assert.deepEqual(saved, { ok: true, id: 1, number: 1, ref: "D-1", scope: "project", owner: "alpha", contract: 4 });
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
    await client.callTool({ name: "decision_update", arguments: { id: second.ref, project: "alpha", status: "accepted", superseded_by: null } }),
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

  const badStatus = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...DECISION, title: "a second one", status: "maybe", unrelated: [1] } }));
  assert.equal(badStatus.status_defaulted, true);
  assert.equal(getDecision(badStatus.id, env).status, "proposed");

  const explicit = payloadOf(
    await client.callTool({ name: "decision_save", arguments: { ...DECISION, title: "a third one", status: "accepted", unrelated: [1, 2] } }),
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
      arguments: { ...DECISION, title: "worker pools are never shared", status: "proposed", unrelated: [1] },
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

  const updated = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: "AP/D-1", status: "superseded", superseded_by: "D-2" } }));
  assert.equal(updated.decision.title, `${title.slice(0, 500)}...`, "decision_update is not one of the untruncated surfaces");
  assert.deepEqual(Object.keys(updated.decision).sort(), ["id", "number", "owner", "ref", "scope", "status", "title", "updated_at"]);
});

// A home with two projects, each carrying one decision, plus a job of the first one.
function makeTwoProjectHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const own = saveDecision({ ...DECISION, projectId: projectIdOf(env, "alpha"), status: "accepted" }, env);
  const foreign = saveDecision({ ...DECISION, projectId: projectIdOf(env, "beta"), title: "beta keeps its own log", status: "accepted" }, env);
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "rewrite the runner" }, env);
  return { env, own, foreign, job };
}

test("inside a job, decision_update refuses a row of another project and changes nothing", async (t) => {
  const { env, foreign, job } = makeTwoProjectHome(t, "mcp-decisions-cross-project");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const decision = await client.callTool({ name: "decision_update", arguments: { id: "BT/D-1", status: "rejected" } });
  assert.equal(decision.isError, true);
  assert.match(textOf(decision), new RegExp(`refusing to update decision \`BT/D-1\` from inside job \`${job.id}\``));
  assert.match(textOf(decision), /it belongs to project `beta`, not `alpha`/);

  assert.equal(getDecision(foreign.id, env).status, "accepted", "the refused update reached the other project's decision");

  const mine = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: "D-1", status: "rejected" } }));
  assert.equal(mine.decision.status, "rejected", "a job must still update its own project");
});

test("outside a job the ownership guard restricts nothing: the operator updates any project", async (t) => {
  const { env } = makeTwoProjectHome(t, "mcp-decisions-operator-scope");
  const client = await connect(t, env);

  const decision = payloadOf(await client.callTool({ name: "decision_update", arguments: { id: "BT/D-1", status: "rejected" } }));
  assert.equal(decision.decision.status, "rejected");
});

test("an overlapping decision_save answers needs_review, writes nothing, and saves once every candidate is named", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-needs-review");
  const client = await connect(t, env);
  payloadOf(await client.callTool({ name: "decision_save", arguments: { ...DECISION, status: "accepted" } }));

  const overlapping = { ...DECISION, title: "the queue keeps one job per runner", status: "accepted" };
  const refused = payloadOf(await client.callTool({ name: "decision_save", arguments: overlapping }));
  assert.equal(refused.ok, false);
  assert.equal(refused.status, "needs_review");
  assert.deepEqual(
    refused.candidates.map((row) => [row.number, row.status, row.via]),
    [[1, "accepted", "lexical"]],
  );
  assert.match(refused.hint, /nothing was saved/);
  assert.equal(getDecision(2, env), null, "a refused save wrote a row");

  const saved = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...overlapping, supersedes: [1] } }));
  assert.deepEqual(saved, { ok: true, id: 2, number: 2, ref: "D-2", scope: "project", owner: "alpha", superseded: [1], contract: 4 });
  assert.equal(getDecision(1, env).status, "superseded");
  assert.equal(getDecision(1, env).superseded_by, 2);
});

test("inside a job decision_save stamps job_id, refuses supersedes, and refuses a second proposal", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-job-proposal");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "rewrite the runner" }, env);
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const first = payloadOf(await client.callTool({ name: "decision_save", arguments: { ...DECISION, status: "proposed" } }));
  assert.equal(first.job_id, job.id);
  assert.equal(getDecision(first.id, env).job_id, job.id);

  const second = await client.callTool({
    name: "decision_save",
    arguments: { ...DECISION, title: "embeddings stay optional", status: "proposed" },
  });
  assert.equal(second.isError, true);
  assert.match(textOf(second), new RegExp(`J-${job.id} already proposed decision D-1; a job proposes at most one decision`));

  const superseding = await client.callTool({
    name: "decision_save",
    arguments: { ...DECISION, title: "embeddings stay optional", status: "accepted", supersedes: [1] },
  });
  assert.equal(superseding.isError, true);
  assert.ok(textOf(superseding).includes(`inside J-${job.id} \`supersedes\` is refused`), textOf(superseding));
  assert.equal(getDecision(first.id, env).status, "proposed");
});

test("inside a job missing from this database decision_save is refused naming the job, and nothing is saved", async (t) => {
  const env = makeDecisionHome(t, "mcp-decisions-missing-job");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: "999" });

  const refused = await client.callTool({ name: "decision_save", arguments: { ...DECISION, status: "proposed" } });
  assert.equal(refused.isError, true);
  assert.ok(
    textOf(refused).includes(
      "job `999` is not in the queue of this database, so a decision saved from it cannot record its job of origin; save it outside the job",
    ),
    textOf(refused),
  );
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM decisions").get().n, 0);
});
