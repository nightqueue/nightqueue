import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { closeJobAndWorktree } from "../../src/queue/close.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { removeRunWorktree } from "../../src/queue/worktree.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { addWorktree, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

// A home whose project `alpha` is a real published checkout.
function makeRaceHome(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  return { env, checkout };
}

// A `done` job whose run recorded a real, clean, pushed worktree of the checkout.
function doneJobWithWorktree(home, slug) {
  const worktree = addWorktree(home.checkout, `feat+${slug}`);
  const id = addJob({ project: "alpha", prompt: `work of ${slug}` }, home.env).id;
  openDb(home.env).prepare("UPDATE jobs SET status = 'done', slug = ? WHERE id = ?").run(slug, id);
  recordRunFields({ project: "alpha", slug, fields: { worktree: worktree.path }, env: home.env });
  return { id, ...worktree };
}

test("an operator's close racing finalize's own post-commit removal never reports the gone worktree as kept", async (t) => {
  const home = makeRaceHome(t, "worktree-race");
  const job = doneJobWithWorktree(home, "race-run");
  const store = openStore(home.env);
  t.after(() => store.close());

  // The row is already `status = done` (finish.written already committed by the time dropRunWorktree runs, runner.mjs:432-433),
  // so an operator's `queue close <id>` (closeJobAndWorktree, close.mjs:4-8) is already free to land on the SAME id while
  // finalize's own dropRunWorktree (runner.mjs:394, a plain removeRunWorktree on the worktree it inspected pre-commit) is
  // still removing the worktree on disk. Fire both at once, exactly as the runner and an operator's call would overlap.
  const [{ job: closedJob, worktree: closeResult }, finalizeRemoval] = await Promise.all([
    closeJobAndWorktree({ store, id: job.id, env: home.env }),
    removeRunWorktree({ checkout: home.checkout, path: job.path, env: home.env }),
  ]);

  assert.equal(finalizeRemoval.ok, true, "the setup itself failed to remove the worktree");
  assert.equal(existsSync(job.path), false, "the worktree is not actually gone after the race");
  assert.equal(closedJob.status, "closed");
  assert.notEqual(
    closeResult?.status,
    "kept",
    `close reported "kept" for a worktree that is actually gone: ${JSON.stringify(closeResult)}`,
  );
});
