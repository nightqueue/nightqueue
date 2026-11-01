import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { ensureProject, registerCheckout } from "../../test-support/memory.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/mcp/tools.mjs";
import { cancelJobAndWorktree } from "../../src/queue/cancel.mjs";
import { recordAdoptedWorktree, recordRunFields } from "../../src/queue/run-state.mjs";
import { ADOPTED_WORKTREE_REASON, UNCOMMITTED_WORKTREE_REASON } from "../../src/queue/worktree.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { addWorktree, git, gitVars, makeDirty, publishedCheckout } from "../../test-support/worktrees.mjs";

const PR_URL = "https://github.com/acme/api/pull/7";

// A home whose project `alpha` is a published checkout, so a job's worktree can really be released.
function cancelHome(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  return { env, checkout };
}

// Calls one tool of the real server wired in-process, answering its JSON payload.
async function callTool(t, env, name, args) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-cancel", version: "0.0.0" });
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

// A job of `alpha` in the given status whose run recorded a worktree of its own, clean and, unless told otherwise, published.
function jobWithWorktree(home, { status, slug, prUrl = null, push = true }) {
  const worktree = addWorktree(home.checkout, `feat+${slug}`, { push });
  const id = addJob({ projectId: ensureProject(home.env, "alpha"), prompt: `a ${status} job` }, home.env).id;
  const lease = status === "running" ? "datetime('now', '-1 hour')" : "NULL";
  openDb(home.env)
    .prepare(`UPDATE jobs SET status = ?, slug = ?, pr_url = ?, worker = 'host:1', lease_until = ${lease} WHERE id = ?`)
    .run(status, slug, prUrl, id);
  recordRunFields({ projectId: ensureProject(home.env, "alpha"), slug, fields: { worktree: worktree.path }, env: home.env });
  return { id, path: worktree.path };
}

test("cancelling a done, a failed or a gated job releases its worktree; a pending or orphaned one keeps it", async (t) => {
  const home = cancelHome(t, "cancel-worktree");
  const store = openStore(home.env);
  const released = [
    jobWithWorktree(home, { status: "done", slug: "done-one", prUrl: PR_URL }),
    jobWithWorktree(home, { status: "failed", slug: "failed-one" }),
    jobWithWorktree(home, { status: "gate", slug: "gate-one" }),
  ];
  for (const job of released) {
    const answer = await cancelJobAndWorktree({ store, id: job.id, env: home.env });
    assert.equal(answer.job.status, "cancelled");
    assert.deepEqual(answer.worktree, { path: job.path, status: "removed" });
    assert.equal(existsSync(job.path), false, `the worktree of a job cancelled from ${answer.job.cancelled_from} is still on disk`);
  }
  const kept = ["pending", "running"].map((status) => jobWithWorktree(home, { status, slug: `${status}-one` }));
  for (const job of kept) {
    const answer = await cancelJobAndWorktree({ store, id: job.id, env: home.env });
    assert.equal(answer.job.status, "cancelled");
    assert.equal(answer.worktree, null, `a ${answer.job.cancelled_from} cancel released a worktree`);
    assert.equal(existsSync(job.path), true, `a ${answer.job.cancelled_from} cancel removed the worktree`);
  }
});

test("cancelling a gated job removes its clean worktree even unpushed and leaves the branch with its commit", async (t) => {
  const home = cancelHome(t, "cancel-gate-unpushed");
  const job = jobWithWorktree(home, { status: "gate", slug: "gate-unpushed", push: false });
  const branch = "worktree-feat+gate-unpushed";
  const commit = git(["-C", job.path, "rev-parse", "HEAD"]).trim();

  const answer = await cancelJobAndWorktree({ store: openStore(home.env), id: job.id, env: home.env });

  assert.deepEqual(answer.worktree, { path: job.path, status: "removed" });
  assert.equal(existsSync(job.path), false, "the clean worktree stayed");
  assert.equal(git(["-C", home.checkout, "rev-parse", branch]).trim(), commit, "the branch lost its commit");
});

test("cancelling a failed job still keeps a clean worktree whose branch was never pushed", async (t) => {
  const home = cancelHome(t, "cancel-failed-unpushed");
  const job = jobWithWorktree(home, { status: "failed", slug: "failed-unpushed", push: false });

  const answer = await cancelJobAndWorktree({ store: openStore(home.env), id: job.id, env: home.env });

  assert.equal(answer.worktree.status, "kept");
  assert.equal(existsSync(job.path), true, "the unpushed worktree of a failed job was removed");
});

test("cancelling a gated job keeps a dirty worktree, cancels anyway and says where, in the text and in --json", async (t) => {
  const home = cancelHome(t, "cancel-gate-dirty");
  const out = [];
  const ctx = { ...defaultContext(), env: home.env, out: (line) => out.push(line), err: () => {} };

  const text = jobWithWorktree(home, { status: "gate", slug: "gate-dirty" });
  makeDirty(text.path);
  assert.equal(await run(["queue", "cancel", String(text.id)], ctx), 0);
  assert.deepEqual(out, [`cancelled J-${text.id}`, `worktree kept: ${text.path} - ${UNCOMMITTED_WORKTREE_REASON}`]);
  assert.equal(existsSync(join(text.path, "uncommitted.txt")), true, "the uncommitted file was lost");
  assert.equal(getJob(text.id, home.env).status, "cancelled");

  out.length = 0;
  const json = jobWithWorktree(home, { status: "gate", slug: "gate-dirty-json" });
  makeDirty(json.path);
  assert.equal(await run(["queue", "cancel", String(json.id), "--json"], ctx), 0);
  assert.equal(JSON.parse(out[0]).worktree.status, "kept");
  assert.equal(JSON.parse(out[0]).worktree.reason, UNCOMMITTED_WORKTREE_REASON);
});

test("cancelling a gated job leaves an adopted worktree alone and says why", async (t) => {
  const home = cancelHome(t, "cancel-gate-adopted");
  const job = jobWithWorktree(home, { status: "gate", slug: "gate-adopted" });
  const projectId = ensureProject(home.env, "alpha");
  recordAdoptedWorktree({ projectId, slug: "gate-adopted", branch: "worktree-feat+gate-adopted", worktree: job.path, env: home.env });

  const answer = await cancelJobAndWorktree({ store: openStore(home.env), id: job.id, env: home.env });

  assert.deepEqual(answer.worktree, { path: job.path, status: "kept", reason: ADOPTED_WORKTREE_REASON });
  assert.equal(existsSync(job.path), true, "the adopted worktree was removed");
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
  assert.deepEqual(out, [`cancelled J-${done.id}`, `worktree removed: ${done.path}`]);

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
  assert.equal(existsSync(pending.path), true, "a pending cancel removed the worktree");

  const gateViaMcp = jobWithWorktree(home, { status: "gate", slug: "mcp-gate", push: false });
  const gateAnswer = await callTool(t, home.env, "queue_cancel", { job_id: gateViaMcp.id });
  assert.deepEqual(gateAnswer.worktree, { path: gateViaMcp.path, status: "removed" });

  const viaMcp = jobWithWorktree(home, { status: "done", slug: "mcp-done", prUrl: PR_URL });
  const answer = await callTool(t, home.env, "queue_cancel", { job_id: viaMcp.id, reason: "abandoned" });
  assert.equal(answer.ok, true);
  assert.equal(answer.job.status, "cancelled");
  assert.deepEqual(answer.worktree, { path: viaMcp.path, status: "removed" });
  assert.equal(getJob(viaMcp.id, home.env).operator_note, "abandoned");
});
