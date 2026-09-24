import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/tools.mjs";
import { cancelJobAndWorktree } from "../../src/queue/cancel.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { addWorktree, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const PR_URL = "https://github.com/acme/api/pull/7";

// A home whose project `alpha` is a published checkout, so a job's worktree can really be released.
function cancelHome(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  return { env, checkout };
}

// Calls one tool of the real server wired in-process, answering its JSON payload.
async function callTool(t, env, name, args) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightshift-tests-cancel", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((block) => block.text).join("\n");
  assert.notEqual(result.isError, true, text);
  return JSON.parse(text);
}

// A job of `alpha` in the given status whose run recorded a worktree of its own, clean and published.
function jobWithWorktree(home, { status, slug, prUrl = null }) {
  const worktree = addWorktree(home.checkout, `feat+${slug}`);
  const id = addJob({ project: "alpha", prompt: `a ${status} job` }, home.env).id;
  const lease = status === "running" ? "datetime('now', '-1 hour')" : "NULL";
  openDb(home.env)
    .prepare(`UPDATE jobs SET status = ?, slug = ?, pr_url = ?, worker = 'host:1', lease_until = ${lease} WHERE id = ?`)
    .run(status, slug, prUrl, id);
  recordRunFields({ project: "alpha", slug, fields: { worktree: worktree.path }, env: home.env });
  return { id, path: worktree.path };
}

test("cancelling a done or a failed job releases its worktree; a pending, gated or orphaned one keeps it", async (t) => {
  const home = cancelHome(t, "cancel-worktree");
  const store = openStore(home.env);
  const released = [jobWithWorktree(home, { status: "done", slug: "done-one", prUrl: PR_URL }), jobWithWorktree(home, { status: "failed", slug: "failed-one" })];
  for (const job of released) {
    const answer = await cancelJobAndWorktree({ store, id: job.id, env: home.env });
    assert.equal(answer.job.status, "cancelled");
    assert.deepEqual(answer.worktree, { path: job.path, status: "removed" });
    assert.equal(existsSync(job.path), false, `the worktree of a job cancelled from ${answer.job.cancelled_from} is still on disk`);
  }
  const kept = ["pending", "gate", "running"].map((status) => jobWithWorktree(home, { status, slug: `${status}-one` }));
  for (const job of kept) {
    const answer = await cancelJobAndWorktree({ store, id: job.id, env: home.env });
    assert.equal(answer.job.status, "cancelled");
    assert.equal(answer.worktree, null, `a ${answer.job.cancelled_from} cancel released a worktree`);
    assert.equal(existsSync(job.path), true, `a ${answer.job.cancelled_from} cancel removed the worktree`);
  }
});

test("a refused cancel touches nothing on disk", async (t) => {
  const home = cancelHome(t, "cancel-refused");
  const job = jobWithWorktree(home, { status: "cancelled", slug: "already" });
  await assert.rejects(cancelJobAndWorktree({ store: openStore(home.env), id: job.id, env: home.env }), /already finished with status `cancelled`/);
  assert.equal(existsSync(job.path), true);
});

test("queue cancel prints the released worktree, and --json and queue_cancel answer it as `worktree`", async (t) => {
  const home = cancelHome(t, "cancel-cli");
  const out = [];
  const ctx = { ...defaultContext(), env: home.env, out: (line) => out.push(line), err: () => {} };

  const done = jobWithWorktree(home, { status: "done", slug: "cli-done", prUrl: PR_URL });
  assert.equal(await run(["queue", "cancel", String(done.id)], ctx), 0);
  assert.deepEqual(out, [`cancelled job #${done.id}`, `worktree removed: ${done.path}`]);

  out.length = 0;
  const failed = jobWithWorktree(home, { status: "failed", slug: "cli-failed" });
  assert.equal(await run(["queue", "cancel", String(failed.id), "--json"], ctx), 0);
  const payload = JSON.parse(out[0]);
  assert.equal(payload.job.status, "cancelled");
  assert.deepEqual(payload.worktree, { path: failed.path, status: "removed" });

  out.length = 0;
  const pending = jobWithWorktree(home, { status: "pending", slug: "cli-pending" });
  assert.equal(await run(["queue", "cancel", String(pending.id), "--json"], ctx), 0);
  assert.equal(JSON.parse(out[0]).worktree, null);

  const viaMcp = jobWithWorktree(home, { status: "done", slug: "mcp-done", prUrl: PR_URL });
  const answer = await callTool(t, home.env, "queue_cancel", { job_id: viaMcp.id, reason: "abandoned" });
  assert.equal(answer.ok, true);
  assert.equal(answer.job.status, "cancelled");
  assert.deepEqual(answer.worktree, { path: viaMcp.path, status: "removed" });
  assert.equal(getJob(viaMcp.id, home.env).operator_note, "abandoned");
});
