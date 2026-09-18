import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { writeRunTerminal } from "../../src/queue/resume.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const WORKER = "host:1000";
const CAP = 4;
const SLUG = "fix-worker";
const PR_URL = "https://github.com/acme/api/pull/7";
const FINISHED_AT = "2026-09-11T03:15:00Z";
const WRITTEN_BY = "/tmp/runtime/versions/0.1.0-20260911T031500Z";

// A home with one registered project and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Connects a real stdio client to `nightshift mcp`, closed at the end of the test.
async function connectMcp(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// JSON payload of a tool result.
function payloadOf(result) {
  return JSON.parse(result.content.map((block) => block.text).join("\n"));
}

// Enqueues a job, claims it and records the slug of its run: the row a runner owns while it works.
function runningJob(env, { slug = SLUG } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  return id;
}

// Moves the lease past the reclaim grace, which is how a runner that died looks from the outside.
function expireLease(env, id) {
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
}

// Writes the witness a runner leaves next to the run once it has finished the job.
function witness(env, { slug = SLUG, status = "done", prUrl = PR_URL } = {}) {
  return writeRunTerminal({
    project: "alpha",
    slug,
    terminal: { status, prUrl, finishedAt: FINISHED_AT, writtenBy: WRITTEN_BY, pid: 4242 },
    env,
  });
}

// A job whose row still says `running` under a dead runner, with the witness of its real outcome on disk.
function lostFinish(env, options = {}) {
  const id = runningJob(env, options);
  expireLease(env, id);
  witness(env, options);
  return id;
}

// True when the tool answer mentions the repair failure anywhere the operator could read it.
function surfacesRepairFailure(answer) {
  return JSON.stringify(answer).toLowerCase().includes("repair");
}

// Asks queue_status until its answer mentions the repair, within five seconds: the server's maintenance timer runs the repair, not the call.
async function pollUntilRepairSurfaces(client) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const answer = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
    if (surfacesRepairFailure(answer) || Date.now() > deadline) return answer;
    await new Promise((done) => setTimeout(done, 100));
  }
}

test("H3: MCP queue_status stays silent about a repair the database refused, unlike `queue status`", async (t) => {
  const env = makeQueue(t, "mcp-reconcile-refused");
  const id = lostFinish(env);
  openDb(env).exec(
    `CREATE TRIGGER refuse_repair BEFORE UPDATE OF status ON jobs WHEN NEW.status = 'done'
     BEGIN SELECT RAISE(ABORT, 'attempt to write a readonly database'); END`,
  );

  const client = await connectMcp(t, env);
  const answer = await pollUntilRepairSurfaces(client);

  assert.equal(getJob(id, env).status, "running", "the repair should have been refused, not silently applied");
  assert.ok(
    surfacesRepairFailure(answer),
    `MCP queue_status gave no signal that job #${id}'s repair failed, unlike the CLI's stderr warning: ${JSON.stringify(answer)}`,
  );
});
