import assert from "node:assert/strict";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobWorktreePath } from "../../src/config/paths.mjs";
import { prepareJobWorktree, WORKTREE_FAILED } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { openJobHolds } from "../../src/queue/worktree.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { git, gitVars, localBranches, lockWorktree, publishedCheckout } from "../../test-support/worktrees.mjs";

const SLUG = "start-the-work";
const OTHER_JOB = 9;

// A job bound to its run and queued with the given starting point.
function jobOf(start = {}, slug = SLUG) {
  return { id: 7, project_id: FIXED_PROJECT_ID, slug, start_branch: start.branch ?? null, start_worktree: start.worktree ?? null };
}

// An isolated home whose git never reads the configuration of the machine.
function homeEnv(t, name) {
  return { ...makeHome(t, name), ...gitVars() };
}

// Runs the preparer the way the runner does, with the holds of the other open jobs given.
async function prepare(env, checkout, { job, holds = [] }) {
  const logged = [];
  const result = await prepareJobWorktree({ job, checkout, baseBranch: "main", env, log: (line) => logged.push(line), openHolds: async () => holds });
  return { ...result, logged };
}

// The commit a ref names in a repository.
function sha(repo, ref = "HEAD") {
  return git(["-C", repo, "rev-parse", ref]).trim();
}

// The branch a worktree has checked out.
function headBranch(path) {
  return git(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"]).trim();
}

// Creates a local branch carrying one commit of its own, leaving the checkout on main.
function branchWithCommit(checkout, name) {
  git(["-C", checkout, "checkout", "-q", "-b", name]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", `work on ${name}`]);
  const work = sha(checkout);
  git(["-C", checkout, "checkout", "-q", "main"]);
  return work;
}

// Adds a linked worktree on a new branch outside the home, answering its path.
function linkedWorktree(t, checkout, { name, branch }) {
  const path = join(makeDir(t, `${name}-linked`), "wt");
  git(["-C", checkout, "worktree", "add", "-q", "-b", branch, path, "main"]);
  return path;
}

// The branch and worktree the state of the run names.
function recordedPlace(env, slug = SLUG) {
  const state = readRunState({ projectId: FIXED_PROJECT_ID, slug, env });
  return { branch: state?.branch ?? null, worktree: state?.worktree ?? null };
}

// Tells whether two paths name the same directory.
function samePath(a, b) {
  return realpathSync(a) === realpathSync(b);
}

// The hold of another open job, the shape `openJobHolds` answers.
function otherHold({ branch = null, worktree = null }) {
  return { jobId: OTHER_JOB, projectId: FIXED_PROJECT_ID, slug: "other-run", type: null, branch, worktree };
}

test("a job queued with an existing local branch works on it with its commits, never on a fresh worktree branch", async (t) => {
  const env = homeEnv(t, "start-local-branch");
  const checkout = initGitRepo(makeDir(t, "start-local-branch-repo"));
  const work = branchWithCommit(checkout, "feat/x");

  const prepared = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }) });

  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  assert.deepEqual({ ok: prepared.ok, path: prepared.path, branch: prepared.branch, reused: prepared.reused }, { ok: true, path: target, branch: "feat/x", reused: false }, prepared.message);
  assert.equal(headBranch(target), "feat/x");
  assert.equal(sha(target), work);
  assert.deepEqual(recordedPlace(env), { branch: "feat/x", worktree: target });
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}`), false);
});

test("a start branch that exists only on origin gets a worktree made from origin's copy", async (t) => {
  const env = homeEnv(t, "start-origin-branch");
  const { checkout } = publishedCheckout(t, "start-origin-branch");
  const work = branchWithCommit(checkout, "feat/remote");
  git(["-C", checkout, "push", "-q", "origin", "feat/remote"]);
  git(["-C", checkout, "branch", "-D", "-q", "feat/remote"]);
  git(["-C", checkout, "update-ref", "-d", "refs/remotes/origin/feat/remote"]);

  const prepared = await prepare(env, checkout, { job: jobOf({ branch: "feat/remote" }) });

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch, reused: prepared.reused }, { ok: true, branch: "feat/remote", reused: false }, prepared.message);
  assert.equal(sha(prepared.path), work);
});

test("a start branch a linked worktree holds, with no other open job owning it, starts in that worktree", async (t) => {
  const env = homeEnv(t, "start-held-branch");
  const checkout = initGitRepo(makeDir(t, "start-held-branch-repo"));
  const held = linkedWorktree(t, checkout, { name: "start-held-branch", branch: "feat/held" });

  const prepared = await prepare(env, checkout, { job: jobOf({ branch: "feat/held" }) });

  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.reused, true);
  assert.equal(prepared.branch, "feat/held");
  assert.ok(samePath(prepared.path, held));
  assert.ok(samePath(recordedPlace(env).worktree, held));
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false);
});

test("a start point another open job holds gates naming that job, by its worktree or by its branch alone", async (t) => {
  const env = homeEnv(t, "start-owned");
  const checkout = initGitRepo(makeDir(t, "start-owned-repo"));
  const held = linkedWorktree(t, checkout, { name: "start-owned", branch: "feat/held" });
  branchWithCommit(checkout, "feat/x");

  const byWorktree = await prepare(env, checkout, { job: jobOf({ branch: "feat/held" }), holds: [otherHold({ worktree: realpathSync(held) })] });
  assert.equal(byWorktree.code, WORKTREE_FAILED);
  assert.match(byWorktree.message, /belongs to J-9, which is not closed/);

  const byBranch = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }), holds: [otherHold({ branch: "feat/x" })] });
  assert.equal(byBranch.code, WORKTREE_FAILED);
  assert.match(byBranch.message, /belongs to J-9/);
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false);
  assert.deepEqual(recordedPlace(env), { branch: null, worktree: null });
});

test("the job's own hold never refuses it", async (t) => {
  const env = homeEnv(t, "start-own-hold");
  const checkout = initGitRepo(makeDir(t, "start-own-hold-repo"));
  branchWithCommit(checkout, "feat/x");

  const prepared = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }), holds: [{ ...otherHold({ branch: "feat/x" }), jobId: 7 }] });

  assert.equal(prepared.ok, true, prepared.message);
});

test("a start worktree a live session locked gates naming its pid", async (t) => {
  const env = homeEnv(t, "start-locked");
  const checkout = initGitRepo(makeDir(t, "start-locked-repo"));
  const held = linkedWorktree(t, checkout, { name: "start-locked", branch: "feat/held" });
  lockWorktree(checkout, held, process.pid);

  const prepared = await prepare(env, checkout, { job: jobOf({ worktree: held }) });

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, new RegExp(`locked by a live session \\(pid ${process.pid}\\)`));
});

test("the default branch and the main checkout's branch are refused as a starting point", async (t) => {
  const env = homeEnv(t, "start-main");
  const checkout = initGitRepo(makeDir(t, "start-main-repo"));

  const onDefault = await prepare(env, checkout, { job: jobOf({ branch: "main" }) });
  assert.equal(onDefault.code, WORKTREE_FAILED);
  assert.match(onDefault.message, /`main` is the default branch/);

  branchWithCommit(checkout, "dev");
  git(["-C", checkout, "checkout", "-q", "dev"]);
  const onMainCheckout = await prepare(env, checkout, { job: jobOf({ branch: "dev" }) });
  assert.equal(onMainCheckout.code, WORKTREE_FAILED);
  assert.match(onMainCheckout.message, /`dev` is the main checkout's branch/);
});

test("a start worktree is reused in place when it is a linked worktree on a branch, and refused otherwise", async (t) => {
  const env = homeEnv(t, "start-worktree");
  const checkout = initGitRepo(makeDir(t, "start-worktree-repo"));
  const held = linkedWorktree(t, checkout, { name: "start-worktree", branch: "feat/wt" });

  const unregistered = await prepare(env, checkout, { job: jobOf({ worktree: makeDir(t, "start-worktree-loose") }) });
  assert.match(unregistered.message ?? "", /is not a linked worktree/);

  const mainCheckout = await prepare(env, checkout, { job: jobOf({ worktree: checkout }) });
  assert.match(mainCheckout.message ?? "", /is not a linked worktree/);

  const detachedPath = join(makeDir(t, "start-worktree-detached"), "wt");
  git(["-C", checkout, "worktree", "add", "-q", "--detach", detachedPath, "main"]);
  const detached = await prepare(env, checkout, { job: jobOf({ worktree: detachedPath }) });
  assert.match(detached.message ?? "", /is detached/);

  const prepared = await prepare(env, checkout, { job: jobOf({ worktree: held }) });
  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.reused, true);
  assert.equal(prepared.branch, "feat/wt");
  assert.ok(samePath(prepared.path, held));
  assert.equal(recordedPlace(env).branch, "feat/wt");

  const again = await prepare(env, checkout, { job: jobOf({ worktree: held }) });
  assert.equal(again.reused, true, "the retry did not resume in the recorded start worktree");
});

test("a start branch that exists nowhere gates and creates nothing", async (t) => {
  const env = homeEnv(t, "start-nowhere");
  const { checkout } = publishedCheckout(t, "start-nowhere");

  const prepared = await prepare(env, checkout, { job: jobOf({ branch: "feat/nowhere" }) });

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /the branch `feat\/nowhere` does not exist in .* nor on origin/);
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false);
  assert.equal(localBranches(checkout).includes("feat/nowhere"), false);
});

test("an unreadable queue gates a job with a starting point, and a job without one never reads it", async (t) => {
  const env = homeEnv(t, "start-unreadable");
  const checkout = initGitRepo(makeDir(t, "start-unreadable-repo"));
  branchWithCommit(checkout, "feat/x");

  const gated = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }), holds: null });
  assert.equal(gated.code, WORKTREE_FAILED);
  assert.match(gated.message, /the queue could not be read/);

  let reads = 0;
  const openHolds = async () => {
    reads += 1;
    return null;
  };
  const plain = await prepareJobWorktree({ job: jobOf({}, "plain-run"), checkout, baseBranch: "main", env, openHolds });
  assert.equal(plain.ok, true, plain.message);
  assert.equal(plain.branch, "worktree-plain-run");
  assert.equal(reads, 0);
});

test("the holds of the open jobs come from their run states, and an unreadable queue answers null, never an empty list", async (t) => {
  const env = homeEnv(t, "start-holds");
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: "held-run", fields: { branch: "feat/held", worktree: "/tmp/held-wt" }, env });
  const jobs = [
    { id: 3, project_id: FIXED_PROJECT_ID, slug: "held-run" },
    { id: 4, project_id: FIXED_PROJECT_ID, slug: "empty-run" },
  ];

  const holds = await openJobHolds({ store: { jobs: { listOpenJobs: async () => jobs } }, env });
  assert.equal(holds.length, 1);
  assert.deepEqual({ ...holds[0], worktree: undefined }, { jobId: 3, projectId: FIXED_PROJECT_ID, slug: "held-run", type: null, branch: "feat/held", worktree: undefined });

  const failing = { jobs: { listOpenJobs: async () => Promise.reject(new Error("database is locked")) } };
  assert.equal(await openJobHolds({ store: failing, env }), null);
});

test("a job whose run was cleared, as by a --fresh retry, is placed again on its start branch", async (t) => {
  const env = homeEnv(t, "start-fresh");
  const checkout = initGitRepo(makeDir(t, "start-fresh-repo"));
  const work = branchWithCommit(checkout, "feat/x");
  const first = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }) });
  git(["-C", checkout, "worktree", "remove", first.path]);

  const fresh = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }, "start-the-work-2") });

  assert.equal(fresh.ok, true, fresh.message);
  assert.equal(fresh.branch, "feat/x");
  assert.equal(sha(fresh.path), work);
  assert.deepEqual(recordedPlace(env, "start-the-work-2"), { branch: "feat/x", worktree: jobWorktreePath(FIXED_PROJECT_ID, "start-the-work-2", env) });
});
