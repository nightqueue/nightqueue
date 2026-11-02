import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobWorktreePath } from "../../src/config/paths.mjs";
import { runGitAsync } from "../../src/host/git.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { cancelJobAndWorktree } from "../../src/queue/cancel.mjs";
import { prepareJobWorktree, WORKTREE_FAILED } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordPhaseDone, recordPipeline, recordRunFields } from "../../src/queue/run-state.mjs";
import { commitWip } from "../../src/queue/wip-commit.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { SLUG } from "../../test-support/streams.mjs";
import { git, gitVars, localBranches, lockWorktree, makeDirty, publishedCheckout } from "../../test-support/worktrees.mjs";

const BRANCH = `worktree-${SLUG}`;
const RUNG = `${BRANCH}-2`;

// A job of a real checkout in the given status, placed by the runtime on its own worktree.
async function placedJob(t, name, { status = "gate", start = {} } = {}) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  useFakeClaude(env, makeDir(t, `${name}-plan`), []);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = ?, slug = ?, notice_md = 'why it stopped', finished_at = datetime('now') WHERE id = ?").run(status, SLUG, id);
  const job = { id, project_id: projectId, slug: SLUG, start_branch: start.branch ?? null, start_worktree: start.worktree ?? null };
  const run = { env, id, projectId, checkout, job };
  if (start.worktree) return run;
  const placed = await place(run);
  assert.equal(placed.ok, true, placed.message);
  return { ...run, path: placed.path };
}

// The placement the runner makes for the job, with what it logged.
async function place(run, { gitImpl = runGitAsync, openHolds = async () => [] } = {}) {
  const logged = [];
  const placed = await prepareJobWorktree({ job: run.job, checkout: run.checkout, baseBranch: "main", env: run.env, gitImpl, openHolds, log: (line) => logged.push(line) });
  return { ...placed, logged };
}

// A commit in a worktree, whatever its HEAD is on.
function commitIn(path, message) {
  git(["-C", path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", message]);
  return git(["-C", path, "rev-parse", "HEAD"]).trim();
}

// Commits on a detached HEAD: no branch names this commit.
function detachAndCommit(path) {
  git(["-C", path, "checkout", "-q", "--detach"]);
  return commitIn(path, "work on a detached HEAD");
}

// The branch and worktree the state of the run records.
function recorded(run) {
  const state = readRunState({ projectId: run.projectId, slug: SLUG, env: run.env });
  return { branch: state?.branch ?? null, worktree: state?.worktree ?? null };
}

// The commit a ref names in the checkout.
function shaOf(run, ref) {
  return git(["-C", run.checkout, "rev-parse", ref]).trim();
}

// The short name of the branch a worktree holds, or HEAD when it is detached.
function headOf(path) {
  return git(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

// Asserts a placement that put the next free rung on the detached HEAD of the job's own worktree, leaving the old branch alone.
function assertOnRung(run, placed, { work, oldBranchAt }) {
  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.path, run.path);
  assert.equal(placed.branch, RUNG);
  assert.equal(headOf(run.path), RUNG);
  assert.equal(git(["-C", run.path, "rev-parse", "HEAD"]).trim(), work);
  assert.deepEqual(recorded(run), { branch: RUNG, worktree: run.path });
  assert.equal(shaOf(run, BRANCH), oldBranchAt, "the old branch moved");
  assert.equal(placed.logged.filter((line) => line.includes(BRANCH) && line.includes(RUNG)).length, 1, placed.logged.join("\n"));
}

for (const status of ["gate", "failed", "cancelled"]) {
  test(`a ${status} job on a detached HEAD: --fresh refuses and the plain retry it names places the job on that HEAD`, async (t) => {
    const run = await placedJob(t, `detached-${status}`, { status });
    const oldBranchAt = shaOf(run, BRANCH);
    const work = detachAndCommit(run.path);

    await assert.rejects(applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }), /could not be released/);
    await applyRetry({ id: run.id, note: "try again", env: run.env });

    assertOnRung(run, await place(run), { work, oldBranchAt });
  });
}

test("a gate cancel keeps a detached worktree holding work, and the retry places the job on it", async (t) => {
  const run = await placedJob(t, "detached-cancel");
  const oldBranchAt = shaOf(run, BRANCH);
  const work = detachAndCommit(run.path);

  const cancelled = await cancelJobAndWorktree({ store: openStore(run.env), id: run.id, env: run.env });
  assert.equal(cancelled.worktree?.status, "kept", JSON.stringify(cancelled.worktree));
  await applyRetry({ id: run.id, note: "try again", env: run.env });

  assertOnRung(run, await place(run), { work, oldBranchAt });
});

// Takes the second exit of the refusal: runs the printed command with a chosen name, then the fresh retry.
async function takeBranchExit(run, work) {
  const refused = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }).catch((err) => err);
  const printed = /\((git -C .* switch -c <name>)\)/.exec(refused.message)?.[1];
  assert.ok(printed, refused.message);
  const pasted = spawnSync("/bin/sh", ["-c", printed.replace("<name>", "rescue")], { env: run.env, encoding: "utf8" });
  assert.equal(pasted.status, 0, pasted.stderr);

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.equal(answer.worktree?.status, "removed", JSON.stringify(answer.worktree));
  assert.equal(answer.keptBranch, "rescue");
  assert.equal(existsSync(run.path), false);
  assert.equal(shaOf(run, "rescue"), work);
}

test("the printed `switch -c` opens the fresh retry, which keeps that branch", async (t) => {
  const run = await placedJob(t, "detached-exit-two");
  await takeBranchExit(run, detachAndCommit(run.path));
});

test("on a run under another pipeline version, where the plain retry refuses, the printed `switch -c` still opens the fresh retry", async (t) => {
  const run = await placedJob(t, "detached-exit-two-version");
  const target = { projectId: run.projectId, slug: SLUG, env: run.env };
  assert.equal(recordPipeline({ ...target, pipeline: { name: "resolve", version: "0.0.0-older" } }).status, "written");
  assert.equal(recordPhaseDone({ ...target, phase: "triage" }).status, "written");
  const work = detachAndCommit(run.path);

  await assert.rejects(applyRetry({ id: run.id, note: "go on", env: run.env }), /retry with --fresh/);

  await takeBranchExit(run, work);
});

test("a dirty detached worktree keeps its files through the placement", async (t) => {
  const run = await placedJob(t, "detached-dirty");
  const work = detachAndCommit(run.path);
  makeDirty(run.path);
  writeFileSync(join(run.path, "staged.txt"), "staged\n");
  git(["-C", run.path, "add", "staged.txt"]);

  const placed = await place(run);

  assert.equal(placed.ok, true, placed.message);
  assert.equal(git(["-C", run.path, "rev-parse", "HEAD"]).trim(), work);
  assert.equal(existsSync(join(run.path, "uncommitted.txt")), true);
  assert.match(git(["-C", run.path, "status", "--porcelain"]), /^A {2}staged\.txt$/m);
});

// Leaves a worktree stopped in a conflicting rebase started from a detached HEAD.
function stopInRebase(path) {
  const base = git(["-C", path, "rev-parse", "HEAD"]).trim();
  const commitFile = (text) => {
    writeFileSync(join(path, "conflict.txt"), text);
    git(["-C", path, "add", "conflict.txt"]);
    return commitIn(path, text);
  };
  git(["-C", path, "checkout", "-q", "--detach"]);
  const mine = commitFile("mine\n");
  git(["-C", path, "checkout", "-q", "--detach", base]);
  commitFile("theirs\n");
  git(["-C", path, "branch", "conflicting"]);
  git(["-C", path, "checkout", "-q", "--detach", mine]);
  const rebase = spawnSync("git", ["-C", path, "-c", "commit.gpgsign=false", "rebase", "conflicting"], { env: { ...process.env, ...gitVars() }, encoding: "utf8" });
  assert.notEqual(rebase.status, 0, "the rebase did not stop on its conflict");
}

// Tells whether a rebase is in progress in a worktree.
function rebaseInProgress(path) {
  return existsSync(join(git(["-C", path, "rev-parse", "--absolute-git-dir"]).trim(), "rebase-merge"));
}

test("mid-rebase the placement gates naming git's line and what to do, the rebase and the state untouched; once aborted it places the job", async (t) => {
  const run = await placedJob(t, "detached-rebase");
  stopInRebase(run.path);
  assert.equal(rebaseInProgress(run.path), true);
  const before = recorded(run);

  const refused = await place(run);

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /cannot switch branch while rebasing/);
  assert.match(refused.message, /finish or abort what is in progress there, then retry/);
  assert.deepEqual(recorded(run), before);
  assert.equal(rebaseInProgress(run.path), true, "the placement touched the rebase");
  assert.equal(localBranches(run.checkout).includes(RUNG), false);

  git(["-C", run.path, "rebase", "--abort"]);
  const placed = await place(run);

  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.branch, RUNG);
});

test("a switch git refuses, or that throws, leaves the state as it was and no new branch", async (t) => {
  const run = await placedJob(t, "detached-switch-fails");
  detachAndCommit(run.path);
  const before = recorded(run);
  const answers = [
    async () => ({ ok: false, stdout: "", stderr: "fatal: refused here", exitCode: 128 }),
    async () => {
      throw new Error("spawn failed");
    },
  ];

  for (const answer of answers) {
    const gitImpl = (call) => (call.args[0] === "switch" ? answer() : runGitAsync(call));
    const placed = await place(run, { gitImpl });
    assert.equal(placed.code, WORKTREE_FAILED, placed.message);
    assert.deepEqual(recorded(run), before);
    assert.equal(localBranches(run.checkout).includes(RUNG), false);
  }
});

test("a worktree detached exactly on a wip commit keeps it, committed, on the new branch with a clean tree", async (t) => {
  const run = await placedJob(t, "detached-wip");
  makeDirty(run.path);
  const wip = commitWip({ cwd: run.path, slug: SLUG, phase: "qa", reason: "stopped", env: run.env });
  assert.equal(wip.status, "committed", JSON.stringify(wip));
  git(["-C", run.path, "checkout", "-q", "--detach"]);

  const placed = await place(run);
  assert.equal(placed.ok, true, placed.message);

  assert.equal(git(["-C", run.path, "symbolic-ref", "--short", "HEAD"]).trim(), RUNG);
  assert.equal(git(["-C", run.path, "rev-parse", "HEAD"]).trim(), wip.commit);
  assert.equal(git(["-C", run.path, "status", "--porcelain"]), "");
});

test("with its old branch deleted the detached worktree takes the job's own name", async (t) => {
  const run = await placedJob(t, "detached-no-old-branch");
  const work = detachAndCommit(run.path);
  git(["-C", run.checkout, "branch", "-q", "-D", BRANCH]);

  const placed = await place(run);

  assert.equal(placed.branch, BRANCH, placed.message);
  assert.equal(git(["-C", run.path, "rev-parse", BRANCH]).trim(), work);
});

test("a rung another open job holds is skipped, and another open job holding the job's own name is a refusal naming it", async (t) => {
  const rungHeld = await placedJob(t, "detached-rung-held");
  detachAndCommit(rungHeld.path);
  const skipped = await place(rungHeld, { openHolds: async () => [{ jobId: 90, projectId: rungHeld.projectId, slug: "other", type: null, branch: RUNG, worktree: null }] });
  assert.equal(skipped.branch, `${BRANCH}-3`, skipped.message);

  const nameHeld = await placedJob(t, "detached-name-held");
  detachAndCommit(nameHeld.path);
  const before = recorded(nameHeld);
  const refused = await place(nameHeld, { openHolds: async () => [{ jobId: 90, projectId: nameHeld.projectId, slug: "other", type: null, branch: BRANCH, worktree: null }] });
  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /J-90/);
  assert.deepEqual(recorded(nameHeld), before);
  assert.equal(headOf(nameHeld.path), "HEAD");
});

test("a live session's lock on the detached worktree refuses naming its pid, and nothing is written", async (t) => {
  const run = await placedJob(t, "detached-locked");
  detachAndCommit(run.path);
  lockWorktree(run.checkout, run.path, process.pid);
  const before = recorded(run);

  const refused = await place(run);

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, new RegExp(`pid ${process.pid}`));
  assert.deepEqual(recorded(run), before);
  assert.equal(headOf(run.path), "HEAD");
});

test("the operator's own start worktree is never branched: left detached the run recreates its branch at the job's path, and detached at the start the refusal names the way out", async (t) => {
  const adoptedDir = makeDir(t, "detached-adopted-dir");
  const run = await placedJob(t, "detached-adopted", { start: { worktree: join(adoptedDir, "wt") } });
  const adopted = run.job.start_worktree;

  git(["-C", run.checkout, "worktree", "add", "-q", "--detach", adopted, "main"]);
  const refused = await place(run);
  assert.equal(refused.code, WORKTREE_FAILED);
  assert.ok(refused.message.includes(`git -C '${realpathSync(adopted)}' switch -c <name>`), refused.message);

  git(["-C", adopted, "switch", "-q", "-c", "feat/mine"]);
  const first = await place(run);
  assert.equal(first.ok, true, first.message);
  git(["-C", adopted, "checkout", "-q", "--detach"]);
  const head = git(["-C", adopted, "rev-parse", "HEAD"]).trim();

  const again = await place(run);

  assert.equal(again.ok, true, again.message);
  assert.equal(again.path, jobWorktreePath(run.projectId, SLUG, run.env));
  assert.equal(again.branch, "feat/mine");
  assert.equal(headOf(adopted), "HEAD", "nightqueue moved the operator's HEAD");
  assert.equal(git(["-C", adopted, "rev-parse", "HEAD"]).trim(), head);
});

test("a detached worktree recorded at a legacy location is branched there, its commit reachable, and no second worktree appears", async (t) => {
  const run = await placedJob(t, "detached-legacy");
  git(["-C", run.checkout, "worktree", "remove", run.path]);
  const legacyRoot = join(run.checkout, ".claude", "worktrees");
  mkdirSync(legacyRoot, { recursive: true });
  const legacy = join(legacyRoot, SLUG);
  git(["-C", run.checkout, "worktree", "add", "-q", legacy, BRANCH]);
  recordRunFields({ projectId: run.projectId, slug: SLUG, fields: { worktree: legacy }, env: run.env });
  const work = detachAndCommit(legacy);

  const placed = await place(run);

  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.path, legacy);
  assert.equal(placed.legacy, true);
  assert.equal(placed.branch, RUNG);
  assert.equal(shaOf(run, RUNG), work);
  assert.equal(existsSync(jobWorktreePath(run.projectId, SLUG, run.env)), false, "a second worktree appeared at the job's path");
});

test("the placement's log line names both branches", async (t) => {
  const run = await placedJob(t, "detached-log");
  detachAndCommit(run.path);

  const placed = await place(run);

  assert.equal(placed.logged.length, 1, placed.logged.join("\n"));
  assert.equal(placed.logged[0], `the run's worktree ${run.path} was on a detached HEAD: the run takes \`${RUNG}\` on it and leaves \`${BRANCH}\` untouched`);
});
