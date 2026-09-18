import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { createPrStateCache } from "../../src/queue/pr-state.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { addWorktree, gitVars, localBranches, makeDirty, publishedCheckout } from "../../test-support/worktrees.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const MERGED_PR = "https://github.com/acme/api/pull/1";

// A home whose project `alpha` is a real published checkout.
function makeCloseHome(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  return { env, checkout };
}

// A job in the given status whose run recorded a real worktree of the checkout, dirty when the test asks for it.
function jobWithWorktree(home, { slug, status, prUrl = null, dirty = false }) {
  const worktree = addWorktree(home.checkout, `feat+${slug}`);
  if (dirty) makeDirty(worktree.path);
  const id = addJob({ project: "alpha", prompt: `work of ${slug}` }, home.env).id;
  openDb(home.env).prepare("UPDATE jobs SET status = ?, slug = ?, pr_url = ? WHERE id = ?").run(status, slug, prUrl, id);
  recordRunFields({ project: "alpha", slug, fields: { worktree: worktree.path }, env: home.env });
  return { id, ...worktree };
}

// Runs `nightshift queue close ...` in this process, capturing stdout and stderr.
async function runQueueClose(env, argv, { prStates } = {}) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line), prStates });
  return { code, out, err };
}

test("queue close removes the clean, pushed worktree of a closed job, keeps a dirty one by name, and still exits 0", async (t) => {
  const home = makeCloseHome(t, "close-wt-ids");
  const clean = jobWithWorktree(home, { slug: "clean-run", status: "done" });
  const dirty = jobWithWorktree(home, { slug: "dirty-run", status: "gate", dirty: true });

  const text = await runQueueClose(home.env, ["queue", "close", String(clean.id), String(dirty.id)]);

  assert.equal(text.code, 0, text.err.join("\n"));
  assert.equal(getJob(clean.id, home.env).status, "closed");
  assert.equal(getJob(dirty.id, home.env).status, "closed");
  assert.equal(existsSync(clean.path), false, "the clean, pushed worktree is still on disk");
  assert.ok(localBranches(home.checkout).includes(clean.branch), "the close deleted the local branch");
  assert.equal(existsSync(dirty.path), true, "the dirty worktree was removed");
  assert.deepEqual(text.out, [
    `closed job #${clean.id}`,
    `worktree removed: ${clean.path}`,
    `closed job #${dirty.id}`,
    `worktree kept: ${dirty.path} - it has uncommitted changes`,
  ]);
});

test("queue close --json carries every worktree it released or kept, and a job with none adds no entry", async (t) => {
  const home = makeCloseHome(t, "close-wt-json");
  const clean = jobWithWorktree(home, { slug: "clean-run", status: "failed" });
  const dirty = jobWithWorktree(home, { slug: "dirty-run", status: "cancelled", dirty: true });
  const bare = addJob({ project: "alpha", prompt: "no run" }, home.env).id;
  openDb(home.env).prepare("UPDATE jobs SET status = 'done' WHERE id = ?").run(bare);

  const json = await runQueueClose(home.env, ["queue", "close", String(clean.id), String(dirty.id), String(bare), "--json"]);

  assert.equal(json.code, 0, json.err.join("\n"));
  assert.equal(json.out.length, 1, json.out.join("\n"));
  const payload = JSON.parse(json.out[0]);
  assert.deepEqual(payload.closed.map((job) => job.id), [clean.id, dirty.id, bare]);
  assert.deepEqual(payload.refused, []);
  assert.deepEqual(payload.worktrees, [
    { id: clean.id, path: clean.path, status: "removed" },
    { id: dirty.id, path: dirty.path, status: "kept", reason: "it has uncommitted changes" },
  ]);
});

test("a refused close touches no worktree", async (t) => {
  const home = makeCloseHome(t, "close-wt-refused");
  const pending = jobWithWorktree(home, { slug: "pending-run", status: "pending" });

  const refused = await runQueueClose(home.env, ["queue", "close", String(pending.id)]);

  assert.equal(refused.code, 1);
  assert.match(refused.err.join("\n"), /is pending; the queue still owes work for it/);
  assert.equal(getJob(pending.id, home.env).status, "pending");
  assert.equal(existsSync(pending.path), true, "a refused close removed the worktree");
});

test("queue close --merged removes the worktree of the job it closes and reports it", async (t) => {
  const home = makeCloseHome(t, "close-wt-merged");
  const merged = jobWithWorktree(home, { slug: "merged-run", status: "done", prUrl: MERGED_PR });
  const prStates = createPrStateCache({ viewImpl: async () => ({ ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" }) });
  await prStates.refresh([MERGED_PR], { ...home.env, NIGHTSHIFT_NO_PR_CHECK: undefined });

  const text = await runQueueClose(home.env, ["queue", "close", "--merged"], { prStates });
  assert.equal(text.code, 0, text.err.join("\n"));
  assert.deepEqual(text.out, [`closed job #${merged.id}`, `worktree removed: ${merged.path}`]);
  assert.equal(existsSync(merged.path), false);

  const again = jobWithWorktree(home, { slug: "merged-again", status: "done", prUrl: MERGED_PR });
  const json = await runQueueClose(home.env, ["queue", "close", "--merged", "--json"], { prStates });
  assert.deepEqual(JSON.parse(json.out[0]).worktrees, [{ id: again.id, path: again.path, status: "removed" }]);
  assert.equal(existsSync(again.path), false);
});

test("MCP queue_close removes the clean, pushed worktree and answers it in `worktree`", async (t) => {
  const home = makeCloseHome(t, "close-wt-mcp");
  const clean = jobWithWorktree(home, { slug: "clean-run", status: "done" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env: home.env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());

  const result = await client.callTool({ name: "queue_close", arguments: { job_id: clean.id } });

  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = JSON.parse(result.content.map((block) => block.text).join("\n"));
  assert.equal(payload.ok, true);
  assert.equal(payload.job.status, "closed");
  assert.deepEqual(payload.worktree, { path: clean.path, status: "removed" });
  assert.equal(existsSync(clean.path), false);
});
