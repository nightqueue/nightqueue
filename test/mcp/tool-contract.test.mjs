import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, listJobs } from "../../src/memory/jobs.mjs";
import { saveIssue } from "../../src/memory/issues.mjs";
import { STALE_CONTRACT_ADVISORY, TOOL_CONTRACT } from "../../src/mcp/tool-contract.mjs";
import { makeHome, makeProject, orgIdOf, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const STALE_LINE = "your client has the tool definitions of an older nightqueue (contract 2, this server is 3): start a new session or restart the MCP client";

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
async function answer(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// The exact text of a refused tool call.
async function refusal(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} was not refused: ${textOf(result)}`);
  return textOf(result);
}

// A home with alpha and beta in org acme, each owner holding a decision and an item, and a job of alpha.
function makeContractHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta", { org: "acme" });
  const owners = { alpha: { projectId: projectIdOf(env, "alpha") }, beta: { projectId: projectIdOf(env, "beta") }, acme: { orgId: orgIdOf(env, "acme") } };
  const decide = (owner, title) => saveDecision({ ...owner, title, context: title, decision: title, status: "accepted" }, env);
  const decisions = { alpha: decide(owners.alpha, "alpha one"), alphaTwo: decide(owners.alpha, "alpha two"), beta: decide(owners.beta, "beta one"), acme: decide(owners.acme, "acme one") };
  const item = (owner, title) => saveIssue({ type: "bug", ...owner, title }, env);
  const items = { alpha: item(owners.alpha, "alpha crashes"), beta: item(owners.beta, "beta crashes"), acme: item(owners.acme, "raise node") };
  const job = addJob({ projectId: owners.alpha.projectId, prompt: "work" }, env);
  return { env, decisions, items, job };
}

test("the handshake and every answer publish the tool contract, and a current client sees no warning", async (t) => {
  const { env, items } = makeContractHome(t, "contract-published");
  const client = await connect(t, env);

  assert.equal(TOOL_CONTRACT, 3);
  assert.match(client.getServerVersion().title, /tool contract 3/);
  assert.match(client.getInstructions(), /tool contract 3/);
  const detail = await answer(client, "issue_get", { id: items.alpha.ref });
  assert.equal(detail.contract, TOOL_CONTRACT);
  assert.equal("deprecated_input" in detail, false);
  const status = await answer(client, "queue_status", {});
  assert.equal(status.contract, TOOL_CONTRACT);
  assert.equal(status.advisories.includes(STALE_CONTRACT_ADVISORY), false);
});

test("an integer id with no owner to prove it is answered with the stale-contract line alone, for every tool whose input changed", async (t) => {
  const { env, items, decisions } = makeContractHome(t, "contract-stale-line");
  const client = await connect(t, env);
  const calls = [
    ["issue_get", { id: items.alpha.id }],
    ["issue_comment", { id: items.alpha.id, body: "x" }],
    ["issue_update", { id: items.alpha.id, status: "cancelled" }],
    ["issue_update", { id: items.alpha.ref, decision_id: decisions.alpha.id }],
    ["decision_update", { id: decisions.alpha.id, status: "rejected" }],
    ["queue_add", { issue_id: items.alpha.id, cwd: "/nowhere" }],
  ];
  for (const [name, args] of calls) assert.equal(await refusal(client, name, args), STALE_LINE, name);
});

test("an integer id the caller's project owns is accepted with deprecated_input naming the field and the ref", async (t) => {
  const { env, items, decisions } = makeContractHome(t, "contract-grace");
  const client = await connect(t, env);

  const saved = await answer(client, "issue_save", { project: "alpha", type: "feature", title: "cache it", decision_id: decisions.alpha.id });
  assert.match(saved.deprecated_input, /`decision_id` \d+ is an internal id of contract 1 and resolved to AP\/D-1; .*refused after the grace release/);
  assert.equal(saved.contract, TOOL_CONTRACT);

  const updated = await answer(client, "decision_update", { id: decisions.alpha.id, project: "alpha", superseded_by: decisions.alphaTwo.id, status: "superseded" });
  assert.match(updated.deprecated_input, /`id` .* resolved to AP\/D-1; .*`superseded_by` .* resolved to AP\/D-2/);

  const orgLinked = await answer(client, "issue_save", { org: "acme", type: "chore", title: "org", decision_id: decisions.acme.id });
  assert.match(orgLinked.deprecated_input, /resolved to AM\/D-1/);

  const queued = await answer(client, "queue_add", { project: "alpha", issue_id: items.alpha.id });
  assert.match(queued.deprecated_input, /`issue_id` .* resolved to AP-1/);
  assert.equal(queued.issue_ref, items.alpha.ref);
});

test("inside a job the issue tools accept the own project's and its org's ids, and answer the stale line for a foreign one", async (t) => {
  const { env, items, job } = makeContractHome(t, "contract-in-job");
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const own = await answer(client, "issue_get", { id: items.alpha.id });
  assert.equal(own.ref, items.alpha.ref);
  assert.match(own.deprecated_input, /`id` .* resolved to AP-1/);
  const org = await answer(client, "issue_comment", { id: items.acme.id, body: "seen" });
  assert.match(org.deprecated_input, /resolved to AM-1/);
  assert.equal(await refusal(client, "issue_get", { id: items.beta.id }), STALE_LINE);
  assert.equal(await refusal(client, "issue_get", { id: 99999 }), STALE_LINE);
  const ref = await answer(client, "issue_get", { id: items.alpha.ref });
  assert.equal("deprecated_input" in ref, false);
});

test("a foreign or unknown id of another owner is the stale line, never a guess", async (t) => {
  const { env, decisions, items } = makeContractHome(t, "contract-foreign");
  const client = await connect(t, env);

  assert.equal(await refusal(client, "issue_save", { project: "alpha", type: "chore", title: "x", decision_id: decisions.beta.id }), STALE_LINE);
  assert.equal(await refusal(client, "decision_update", { id: 99999, project: "alpha", status: "rejected" }), STALE_LINE);
  assert.equal(await refusal(client, "queue_add", { project: "alpha", issue_id: items.beta.id }), STALE_LINE);
  assert.equal(await refusal(client, "decision_update", { id: decisions.beta.id, project: "alpha", status: "rejected" }), STALE_LINE);
});

test("queue_add with the issue field a contract-2 client still sends is the stale line, never a plain job without its issue", async (t) => {
  const { env, items } = makeContractHome(t, "contract-renamed-field");
  const client = await connect(t, env);
  const renamedField = `${["road", "map"].join("")}_item_id`;
  const jobsBefore = listJobs({}, env).length;

  assert.equal(await refusal(client, "queue_add", { project: "alpha", prompt: "operator note", [renamedField]: items.alpha.ref }), STALE_LINE);
  assert.equal(await refusal(client, "queue_add", { project: "alpha", [renamedField]: items.alpha.ref }), STALE_LINE);
  assert.equal(listJobs({}, env).length, jobsBefore, "a refused call queued a job");
  assert.equal((await answer(client, "queue_status", {})).advisories.includes(STALE_CONTRACT_ADVISORY), true);
  const queued = await answer(client, "queue_add", { project: "alpha", prompt: "operator note", issue_id: items.alpha.ref });
  assert.equal(queued.issue_ref, items.alpha.ref);
});

test("queue_status advises about the older contract once the server saw an old shape", async (t) => {
  const { env, items } = makeContractHome(t, "contract-advisory");
  const client = await connect(t, env);

  assert.equal((await answer(client, "queue_status", {})).advisories.includes(STALE_CONTRACT_ADVISORY), false);
  await refusal(client, "issue_get", { id: items.alpha.id });
  const status = await answer(client, "queue_status", {});
  assert.equal(status.advisories.includes(STALE_CONTRACT_ADVISORY), true);
  assert.match(status.hint, /this client's tool contract is older than the server/);
});
