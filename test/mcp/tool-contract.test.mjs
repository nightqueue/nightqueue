import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addJob, listJobs } from "../../src/memory/jobs.mjs";
import { STALE_CONTRACT_ADVISORY, TOOL_CONTRACT } from "../../src/mcp/tool-contract.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const STALE_LINE = "your client has the tool definitions of an older nightqueue (contract 7, this server is 8): start a new session or restart the MCP client";

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

// A home with alpha and beta in org acme, and a job of alpha.
function makeContractHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta", { org: "acme" });
  const job = addJob({ projectId: projectIdOf(env, "alpha"), prompt: "work" }, env);
  return { env, job };
}

test("the handshake and every answer publish the tool contract, and a current client sees no warning", async (t) => {
  const { env } = makeContractHome(t, "contract-published");
  const client = await connect(t, env);

  assert.equal(TOOL_CONTRACT, 8);
  assert.match(client.getServerVersion().title, /tool contract 8/);
  assert.match(client.getInstructions(), /tool contract 8/);
  const status = await answer(client, "queue_status", {});
  assert.equal(status.contract, TOOL_CONTRACT);
  assert.equal(status.advisories.includes(STALE_CONTRACT_ADVISORY), false);
  const read = await answer(client, "tracker_read", { ref: "MK-49" });
  assert.equal(read.error, "no-connection");
  assert.equal(read.contract, TOOL_CONTRACT);
  assert.equal("deprecated_input" in read, false);
});

test("queue_add with the tracker field an older client still sends is the stale line, never a plain job without it", async (t) => {
  const { env } = makeContractHome(t, "contract-renamed-field");
  const client = await connect(t, env);
  const renamedField = `${["road", "map"].join("")}_item_id`;
  const jobsBefore = listJobs({}, env).length;

  assert.equal(await refusal(client, "queue_add", { project: "alpha", prompt: "operator note", [renamedField]: "AP-1" }), STALE_LINE);
  assert.equal(await refusal(client, "queue_add", { project: "alpha", [renamedField]: "AP-1" }), STALE_LINE);
  assert.equal(await refusal(client, "queue_add", { project: "alpha", prompt: "operator note", issue_id: "AP-1" }), STALE_LINE);
  assert.equal(await refusal(client, "queue_add", { project: "alpha", prompt: "operator note", issue_id: null }), STALE_LINE);
  assert.equal(await refusal(client, "queue_add", { project: "alpha", issue_id: 1 }), STALE_LINE);
  assert.equal(listJobs({}, env).length, jobsBefore, "a refused call queued a job");
  assert.equal((await answer(client, "queue_status", {})).advisories.includes(STALE_CONTRACT_ADVISORY), true);
  const queued = await answer(client, "queue_add", { project: "alpha", prompt: "fix the worker" });
  assert.equal(Object.hasOwn(queued, "issue_ref"), false);
  assert.equal(listJobs({}, env).length, jobsBefore + 1);
});

test("the four removed decision tools are unlisted, and a call to each is the stale line", async (t) => {
  const { env } = makeContractHome(t, "contract-removed-tools");
  const client = await connect(t, env);
  const removed = ["decision_save", "decision_update", "decision_list", "decision_recall"];

  const listed = (await client.listTools()).tools.map((tool) => tool.name);
  assert.deepEqual(listed.filter((name) => name.startsWith("decision_")), []);
  for (const name of removed) {
    assert.equal(await refusal(client, name, { project: "alpha", title: "t", context: "c", decision: "d" }), STALE_LINE, name);
  }
  assert.equal((await answer(client, "queue_status", {})).advisories.includes(STALE_CONTRACT_ADVISORY), true);
  assert.match(await refusal(client, "no_such_tool", {}), /no_such_tool not found/);
});

test("queue_status advises about the older contract once the server saw an old shape", async (t) => {
  const { env } = makeContractHome(t, "contract-advisory");
  const client = await connect(t, env);

  assert.equal((await answer(client, "queue_status", {})).advisories.includes(STALE_CONTRACT_ADVISORY), false);
  await refusal(client, "queue_add", { project: "alpha", prompt: "operator note", issue_id: "AP-1" });
  const status = await answer(client, "queue_status", {});
  assert.equal(status.advisories.includes(STALE_CONTRACT_ADVISORY), true);
  assert.match(status.hint, /this client's tool contract is older than the server/);
});
