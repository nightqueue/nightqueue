import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome, seedDoneJob } from "../../test-support/memory.mjs";

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

// Calls a tool that must be refused, and answers its message.
async function refusalOf(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, true, `${name} was not refused: ${textOf(result)}`);
  return textOf(result);
}

test("the job tools take a job ref or a plain id, and refuse anything else", async (t) => {
  const env = makeHome(t, "mcp-refs-jobs");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env);
  const client = await connect(t, env);

  assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: `J-${job.id}` } })).job.id, job.id);
  assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: `j-${job.id}` } })).job.id, job.id);
  assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { job_id: job.id } })).job.id, job.id);
  assert.match(await refusalOf(client, "queue_status", { job_id: "AP-1" }), /expected a job ref \(`J-<id>`\) or a job id, got `AP-1`/);
  assert.match(await refusalOf(client, "queue_run", { job_id: "soon" }), /expected a job ref/);
  assert.match(await refusalOf(client, "queue_session", { job_id: "D-1" }), /expected a job ref/);
  assert.match(await refusalOf(client, "queue_close", { job_id: `J-${job.id}` }), new RegExp(`J-${job.id}|pending`));

  const cancelled = payloadOf(await client.callTool({ name: "queue_cancel", arguments: { job_id: `J-${job.id}`, reason: "later" } }));
  assert.equal(cancelled.job.status, "cancelled");
  const retried = payloadOf(await client.callTool({ name: "queue_retry", arguments: { job_id: `J-${job.id}` } }));
  assert.equal(retried.job.status, "pending");
  assert.equal(getJob(job.id, env).status, "pending");
});

test("queue_status finds a job by the pull request it opened: one, none, several, a foreign URL", async (t) => {
  const env = makeHome(t, "mcp-refs-pr-url");
  const one = seedDoneJob(env, { prUrl: "https://github.com/Acme/api/pull/7" });
  seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/77" });
  seedDoneJob(env, { prUrl: "https://github.com/acme/web/pull/7" });
  const twins = [seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/9" }), seedDoneJob(env, { prUrl: "https://github.com/acme/api/pull/9/" })];
  const client = await connect(t, env);

  for (const url of ["https://github.com/Acme/api/pull/7", "https://github.com/acme/api/pull/7/files/", "https://github.com/ACME/API/pull/7#x"]) {
    assert.equal(payloadOf(await client.callTool({ name: "queue_status", arguments: { pr_url: url } })).job.id, one, url);
  }
  assert.match(
    await refusalOf(client, "queue_status", { pr_url: "https://github.com/acme/api/pull/9" }),
    new RegExp(`\`https://github.com/acme/api/pull/9\` was opened by more than one job: J-${twins[0]}, J-${twins[1]}; pass one of them`),
  );
  assert.match(await refusalOf(client, "queue_status", { pr_url: "https://github.com/acme/api/pull/8" }), /no job opened `https:\/\/github.com\/acme\/api\/pull\/8`/);
  assert.match(await refusalOf(client, "queue_status", { pr_url: "https://gitlab.com/acme/api/-/merge_requests/7" }), /not a GitHub pull request URL/);
  assert.match(await refusalOf(client, "queue_status", { pr_url: "https://github.com/acme/api/pull/7", job_id: one }), /pass either `job_id` or `pr_url`, never both/);
});
