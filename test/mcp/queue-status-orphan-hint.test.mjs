import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { queuePausedPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, LEASE_GRACE_S } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { FAKE_CLAUDE } from "../../test-support/queue-fake.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

// A home whose queue is paused, so a detached runner started by a test never claims anything.
function makeQueueHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  env.NIGHTSHIFT_CLAUDE_BIN = FAKE_CLAUDE;
  writeFileSync(queuePausedPath(env), `${new Date().toISOString()}\n`);
  return env;
}

// Connects a real stdio client to `nightshift mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, result.content.map((block) => block.text).join("\n"));
  return JSON.parse(result.content.map((block) => block.text).join("\n"));
}

// Expires a job's lease well past the grace window, the same runtime-derived shape `doctor` treats as orphaned.
function orphanLease(env, id) {
  const staleSeconds = LEASE_GRACE_S * 2;
  openDb(env).prepare(`UPDATE jobs SET lease_until = datetime('now', '-${staleSeconds} seconds') WHERE id = ?`).run(id);
}

test("queue_status does not call an orphaned running job (dead lease, no watcher) a live runner", async (t) => {
  const env = makeQueueHome(t, "mcp-queue-orphan-hint");
  const orphaned = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(orphaned, { worker: "host:4242", cap: 4 }, env);
  orphanLease(env, orphaned);
  addJob({ project: "alpha", prompt: "fix the parser" }, env);

  const client = await connect(t, env);
  const status = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));

  assert.equal(status.counts.running, 1, "the fixture did not land the orphaned job in `running`");
  assert.notEqual(
    status.hint,
    "runner active — 1 pending after this one",
    `queue_status claimed a runner is active over a lease dead for ${LEASE_GRACE_S * 2}s: ${status.hint}`,
  );
});
