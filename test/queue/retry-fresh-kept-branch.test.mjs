import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { prepareJobWorktree } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordAdoptedWorktree } from "../../src/queue/run-state.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { SLUG } from "../../test-support/streams.mjs";
import { git, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const BRANCH = `worktree-${SLUG}`;

// A gated job of a real checkout, placed by the runtime on its own worktree.
async function placedGateJob(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  useFakeClaude(env, makeDir(t, `${name}-plan`), []);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'gate', slug = ?, notice_md = 'why it stopped', finished_at = datetime('now') WHERE id = ?").run(SLUG, id);
  const placed = await prepareJobWorktree({ job: { id, project_id: projectId, slug: SLUG }, checkout, baseBranch: "main", env });
  assert.equal(placed.ok, true, placed.message);
  return { env, id, projectId, checkout, path: readRunState({ projectId, slug: SLUG, env }).worktree };
}

// Records the run as having adopted the path.
function adopt(run, path) {
  const written = recordAdoptedWorktree({ projectId: run.projectId, slug: SLUG, branch: BRANCH, worktree: path, env: run.env });
  assert.equal(written.status, "written", written.reason);
}

// The branch a fresh retry of the run names as kept.
async function keptBranchOf(run) {
  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });
  return answer.keptBranch;
}

test("an adopted path that is a plain directory inside a foreign repository names the branch the run recorded", async (t) => {
  const run = await placedGateJob(t, "kept-branch-foreign");
  const foreign = initGitRepo(makeDir(t, "kept-branch-foreign-repo"));
  git(["-C", foreign, "switch", "-q", "-c", "foreign-branch"]);
  const adopted = join(foreign, "adopted-dir");
  mkdirSync(adopted);
  adopt(run, adopted);

  assert.equal(await keptBranchOf(run), BRANCH);
});

test("an adopted path that is a plain directory inside the checkout names the branch the run recorded, not the checkout's HEAD", async (t) => {
  const run = await placedGateJob(t, "kept-branch-own-checkout");
  const adopted = join(run.checkout, "adopted-dir");
  mkdirSync(adopted);
  adopt(run, adopted);

  assert.equal(await keptBranchOf(run), BRANCH);
});

test("an adopted worktree git registers on another branch names the branch it holds", async (t) => {
  const run = await placedGateJob(t, "kept-branch-adopted-held");
  const adopted = join(makeDir(t, "kept-branch-adopted-held-dir"), "wt");
  git(["-C", run.checkout, "worktree", "add", "-q", "-b", "feat/held", adopted, "main"]);
  adopt(run, adopted);

  assert.equal(await keptBranchOf(run), "feat/held");
});

test("a worktree moved to another branch names the branch it holds", async (t) => {
  const run = await placedGateJob(t, "kept-branch-held");
  git(["-C", run.path, "switch", "-q", "-c", "feat/moved"]);

  assert.equal(await keptBranchOf(run), "feat/moved");
});

test("a detached worktree with nothing to lose names the branch the run recorded", async (t) => {
  const run = await placedGateJob(t, "kept-branch-detached");
  git(["-C", run.path, "checkout", "-q", "--detach"]);

  assert.equal(await keptBranchOf(run), BRANCH);
});
