import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { createPrStateCache } from "../../src/queue/pr-state.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { fakeCloseDeps, mergedPr } from "../../test-support/close.mjs";
import { addWorktree, gitVars, localBranches, makeDirty, publishedCheckout } from "../../test-support/worktrees.mjs";

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

// Runs `nightqueue queue close ...` in this process over a merged pull request, capturing stdout and stderr.
async function runQueueClose(env, argv, { prStates } = {}) {
  const out = [];
  const err = [];
  const closeDeps = fakeCloseDeps({ pr: mergedPr() }).deps;
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line), prStates, closeDeps });
  return { code, out, err };
}

test("queue close removes the clean, pushed worktree of the job it closed, and keeps its local branch", async (t) => {
  const home = makeCloseHome(t, "close-wt-clean");
  const clean = jobWithWorktree(home, { slug: "clean-run", status: "done", prUrl: MERGED_PR });

  const text = await runQueueClose(home.env, ["queue", "close", String(clean.id), "--foreground"]);

  assert.equal(text.code, 0, text.err.join("\n"));
  assert.equal(getJob(clean.id, home.env).status, "closed");
  assert.equal(existsSync(clean.path), false, "the clean, pushed worktree is still on disk");
  assert.ok(localBranches(home.checkout).includes(clean.branch), "the close deleted the local branch");
  assert.equal(text.out.at(-1), `job #${clean.id} closed: PR #7 merged as abc1234; worktree removed: ${clean.path}`);
});

test("queue close keeps a dirty worktree by name, still closes the job and exits 0, and --json carries it in the checklist", async (t) => {
  const home = makeCloseHome(t, "close-wt-dirty");
  const dirty = jobWithWorktree(home, { slug: "dirty-run", status: "done", prUrl: MERGED_PR, dirty: true });

  const json = await runQueueClose(home.env, ["queue", "close", String(dirty.id), "--foreground", "--json"]);

  assert.equal(json.code, 0, json.err.join("\n"));
  assert.equal(json.out.length, 1, json.out.join("\n"));
  const payload = JSON.parse(json.out[0]);
  assert.equal(payload.job.status, "closed");
  assert.equal(existsSync(dirty.path), true, "the dirty worktree was removed");
  assert.deepEqual(jobView(getJob(dirty.id, home.env)).close.steps.settle.worktree, {
    path: dirty.path,
    status: "kept",
    reason: "it has uncommitted changes",
  });
});

test("a refused close touches no worktree", async (t) => {
  const home = makeCloseHome(t, "close-wt-refused");
  const pending = jobWithWorktree(home, { slug: "pending-run", status: "pending" });
  const failed = jobWithWorktree(home, { slug: "failed-run", status: "failed", prUrl: MERGED_PR });

  for (const job of [pending, failed]) {
    const refused = await runQueueClose(home.env, ["queue", "close", String(job.id), "--foreground"]);
    assert.equal(refused.code, 1);
    assert.match(refused.err.join("\n"), /is pending; it has not produced a pull request yet|failed; retry it or cancel it/);
    assert.equal(existsSync(job.path), true, "a refused close removed the worktree");
  }
  assert.equal(getJob(pending.id, home.env).status, "pending");
  assert.equal(getJob(failed.id, home.env).status, "failed");
});

test("queue close --merged removes the worktree of the job it closes and reports it", async (t) => {
  const home = makeCloseHome(t, "close-wt-merged");
  const merged = jobWithWorktree(home, { slug: "merged-run", status: "done", prUrl: MERGED_PR });
  const prStates = createPrStateCache({ viewImpl: async () => ({ ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z" }) });
  await prStates.refresh([MERGED_PR], { ...home.env, NIGHTQUEUE_NO_PR_CHECK: undefined });

  const text = await runQueueClose(home.env, ["queue", "close", "--merged"], { prStates });
  assert.equal(text.code, 0, text.err.join("\n"));
  assert.deepEqual(text.out, [`closed job #${merged.id}`, `worktree removed: ${merged.path}`]);
  assert.equal(existsSync(merged.path), false);

  const again = jobWithWorktree(home, { slug: "merged-again", status: "done", prUrl: MERGED_PR });
  const json = await runQueueClose(home.env, ["queue", "close", "--merged", "--json"], { prStates });
  assert.deepEqual(JSON.parse(json.out[0]).worktrees, [{ id: again.id, path: again.path, status: "removed" }]);
  assert.equal(existsSync(again.path), false);
});