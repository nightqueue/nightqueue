import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { addJob, cancelJob, getJob, retryJob } from "../../src/memory/jobs.mjs";
import { isValidBranchName } from "../../src/memory/start-point.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

// A home with the `alpha` project registered, answering its env and project id.
function alphaHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return { env, projectId: ensureProject(env, "alpha") };
}

test("a job queued with a start branch or a start worktree stores it, trimmed, and blank means none", (t) => {
  const { env, projectId } = alphaHome(t, "job-start-point");
  const onBranch = addJob({ projectId, prompt: "finish it", startBranch: "  feat/login  " }, env);
  assert.equal(onBranch.startBranch, "feat/login");
  assert.equal(getJob(onBranch.id, env).start_branch, "feat/login");
  assert.equal(getJob(onBranch.id, env).start_worktree, null);

  const inWorktree = addJob({ projectId, prompt: "finish it", startWorktree: "/tmp/alpha-wt" }, env);
  assert.equal(getJob(inWorktree.id, env).start_worktree, "/tmp/alpha-wt");

  const blank = addJob({ projectId, prompt: "fix it", startBranch: "   ", startWorktree: "" }, env);
  assert.equal(getJob(blank.id, env).start_branch, null);
  assert.equal(getJob(blank.id, env).start_worktree, null);
});

test("a starting point is refused by syntax at queue time and queues nothing", (t) => {
  const { env, projectId } = alphaHome(t, "job-start-point-refused");
  assert.throws(() => addJob({ projectId, prompt: "x", startBranch: "feat/x", startWorktree: "/tmp/x" }, env), (err) => err instanceof UserError && /not both/.test(err.message));
  assert.throws(() => addJob({ projectId, prompt: "x", startWorktree: "relative/path" }, env), (err) => err instanceof UserError && /absolute path/.test(err.message));
  assert.throws(() => addJob({ projectId, prompt: "x", startBranch: "bad name" }, env), (err) => err instanceof UserError && /valid git branch name/.test(err.message));
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("the branch name check mirrors git check-ref-format --branch", () => {
  for (const good of ["feat/x", "fix/login-google", "worktree-a+b", "release/1.2"]) assert.equal(isValidBranchName(good), true, good);
  const bad = ["", "@", "-x", "/x", "x/", "x.", "a..b", "a~b", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "a b", "a@{b", "a//b", "a/.b", ".a", "a.lock", "a.lock/b"];
  for (const name of bad) assert.equal(isValidBranchName(name), false, name);
});

test("a --fresh retry keeps the starting point while it drops the run", (t) => {
  const { env, projectId } = alphaHome(t, "job-start-point-fresh");
  const { id } = addJob({ projectId, prompt: "finish it", startBranch: "feat/login" }, env);
  cancelJob(id, { reason: "stop" }, env);
  retryJob(id, { fresh: true }, env);
  assert.equal(getJob(id, env).start_branch, "feat/login");
});

test("a home without the starting point columns gains them on open", (t) => {
  const { env, projectId } = alphaHome(t, "job-start-point-columns");
  openDb(env).exec("ALTER TABLE jobs DROP COLUMN start_branch; ALTER TABLE jobs DROP COLUMN start_worktree;");
  closeDb(env);
  const { id } = addJob({ projectId, prompt: "finish it", startBranch: "feat/login" }, env);
  assert.equal(getJob(id, env).start_branch, "feat/login");
});
