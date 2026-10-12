import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));

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

// Every memory row of the home, oldest first.
function memoryRows(env) {
  return openDb(env).prepare("SELECT id, project_id, key, value FROM memory ORDER BY id").all();
}

// A home with the project `alpha` registered.
function makeAlphaHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Calls memory_save with the given arguments.
async function saveMemory(client, args) {
  return await client.callTool({ name: "memory_save", arguments: args });
}

test("memory_save answers the id, the ref and the project of a new key", async (t) => {
  const env = makeAlphaHome(t, "mcp-memory-save-new");
  const client = await connect(t, env);

  const saved = payloadOf(await saveMemory(client, { project: "alpha", key: "  queue storage ", value: " SQLite in the home " }));

  const [row] = memoryRows(env);
  assert.equal(saved.ok, true);
  assert.equal(saved.id, row.id);
  assert.equal(saved.ref, `M${row.id}`);
  assert.equal(saved.project, "alpha");
  assert.equal(saved.deduped, false);
  assert.equal(saved.value, "SQLite in the home");
  assert.deepEqual({ ...row }, { id: row.id, project_id: projectIdOf(env, "alpha"), key: "queue storage", value: "SQLite in the home" });
});

test("memory_save keeps an existing key: the same id, deduped, and the stored value unchanged", async (t) => {
  const env = makeAlphaHome(t, "mcp-memory-save-dedup");
  const client = await connect(t, env);

  const first = payloadOf(await saveMemory(client, { project: "alpha", key: "queue storage", value: "SQLite in the home" }));
  const again = payloadOf(await saveMemory(client, { project: "alpha", key: "queue storage", value: "Postgres" }));

  assert.equal(again.id, first.id);
  assert.equal(again.deduped, true);
  assert.equal(again.value, "SQLite in the home");
  assert.deepEqual(
    memoryRows(env).map((row) => row.value),
    ["SQLite in the home"],
  );
});

test("memory_save refuses an empty key or value with the field it misses, and writes nothing", async (t) => {
  const env = makeAlphaHome(t, "mcp-memory-save-empty");
  const client = await connect(t, env);

  for (const [args, field] of [
    [{ project: "alpha", key: "  ", value: "a fact" }, "key"],
    [{ project: "alpha", key: "a key", value: "   " }, "value"],
  ]) {
    const refused = await saveMemory(client, args);
    assert.equal(refused.isError, true, field);
    assert.match(textOf(refused), new RegExp(`memory field \`${field}\` is required and cannot be empty`));
  }
  assert.equal(memoryRows(env).length, 0, "a refused memory_save wrote a row");
});

test("memory_save refuses an unknown project name and writes nothing", async (t) => {
  const env = makeAlphaHome(t, "mcp-memory-save-ghost");
  const client = await connect(t, env);

  const refused = await saveMemory(client, { project: "ghost", key: "a key", value: "a fact" });

  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /unknown project `ghost`; known projects: alpha/);
  assert.equal(memoryRows(env).length, 0);
});

test("memory_save from an absolute path inside no checkout saves a global memory", async (t) => {
  const env = makeAlphaHome(t, "mcp-memory-save-global");
  const outside = makeDir(t, "memory-save-outside");
  const client = await connect(t, env);

  const saved = payloadOf(await saveMemory(client, { project: outside, key: "editor", value: "the team uses one formatter" }));

  assert.equal(saved.project, null);
  assert.equal(saved.deduped, false);
  assert.equal(memoryRows(env)[0].project_id, null);
});

test("memory_save is allowed inside a job", async (t) => {
  const env = makeAlphaHome(t, "mcp-memory-save-job");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "rewrite the runner" }, env);
  const client = await connect(t, { ...env, NIGHTQUEUE_JOB_ID: String(job.id) });

  const saved = payloadOf(await saveMemory(client, { project: "alpha", key: "runner", value: "one runner per home" }));

  assert.equal(saved.ok, true);
  assert.equal(saved.deduped, false);
  assert.equal(memoryRows(env).length, 1);
});
