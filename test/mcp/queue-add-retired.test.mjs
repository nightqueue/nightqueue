import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../../src/memory/db.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const PROMPT = "## Brief\nqueue status shows the same notice twice\n";

// The real tool server and a client wired together in-process over a temporary home.
async function connectInProcess(t, env) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-retired", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// How many jobs the home's queue holds.
function jobCount(env) {
  return openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
}

test("queue_add refuses a run_dir with D-58 and queues nothing; a null or blank one is ignored", async (t) => {
  const env = makeHome(t, "queue-add-retired");
  makeProject(t, env, "alpha");
  const client = await connectInProcess(t, env);

  const refused = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT, run_dir: "/x" } });
  assert.equal(refused.isError, true, textOf(refused));
  assert.match(textOf(refused), /`run_dir` was removed by D-58/);
  assert.equal(jobCount(env), 0);

  for (const run_dir of [null, ""]) {
    const queued = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT, run_dir } });
    assert.notEqual(queued.isError, true, textOf(queued));
  }
  assert.equal(jobCount(env), 2);
});

test("queue_add no longer lists run_dir in its schema", async (t) => {
  const env = makeHome(t, "queue-add-retired-schema");
  const client = await connectInProcess(t, env);

  const tool = (await client.listTools()).tools.find((entry) => entry.name === "queue_add");
  assert.equal(Object.hasOwn(tool.inputSchema.properties, "run_dir"), false);
});
