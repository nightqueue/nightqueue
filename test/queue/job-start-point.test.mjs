import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobWorktreePath, startPointsLockPath } from "../../src/config/paths.mjs";
import { runGitAsync } from "../../src/host/git.mjs";
import { prepareJobWorktree, WORKTREE_FAILED } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { ADOPTED_WORKTREE_REASON, openJobHolds, releaseJobWorktree } from "../../src/queue/worktree.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { git, gitVars, localBranches, lockWorktree, makeDirty, publishedCheckout } from "../../test-support/worktrees.mjs";

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

// The holds the runner would read with job 9 done or cancelled and holding `feat/x` in its run state.
async function holdsOfJobNine(env, status) {
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: "other-run", fields: { branch: "feat/x", worktree: "/tmp/other-wt" }, env });
  const jobs = [{ id: OTHER_JOB, project_id: FIXED_PROJECT_ID, slug: "other-run", status }];
  return await openJobHolds({ store: { jobs: { listOpenJobs: async () => jobs } }, env });
}

test("a cancelled job no longer holds its branch for another job's start, while a done one still does", async (t) => {
  const env = homeEnv(t, "start-cancelled-owner");
  const checkout = initGitRepo(makeDir(t, "start-cancelled-owner-repo"));
  branchWithCommit(checkout, "feat/x");

  const stillDone = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }), holds: await holdsOfJobNine(env, "done") });
  assert.equal(stillDone.code, WORKTREE_FAILED);
  assert.match(stillDone.message, /belongs to J-9, which is not closed; two open jobs never share a branch/);

  const afterCancel = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }), holds: await holdsOfJobNine(env, "cancelled") });
  assert.equal(afterCancel.ok, true, afterCancel.message);
  assert.equal(afterCancel.branch, "feat/x");
});

test("a cancelled job retried after another job took its branch is refused naming that job, and resumes when nobody holds it", async (t) => {
  const env = homeEnv(t, "start-cancelled-retry");
  const checkout = initGitRepo(makeDir(t, "start-cancelled-retry-repo"));
  branchWithCommit(checkout, "feat/x");
  const first = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }) });
  assert.equal(first.ok, true, first.message);

  const refused = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }), holds: [otherHold({ branch: "feat/x" })] });
  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /belongs to J-9, which is not closed/);

  const resumed = await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }) });
  assert.equal(resumed.ok, true, resumed.message);
  assert.equal(resumed.branch, "feat/x");
  assert.equal(resumed.reused, true);
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

const RIVALS = [
  { id: 7, slug: "rival-seven" },
  { id: 8, slug: "rival-eight" },
];

// The holds of the rival jobs read from their real run states, the way `openJobHolds` reads every open job.
function rivalHolds(env) {
  return async () =>
    RIVALS.flatMap(({ id, slug }) => {
      const { branch, worktree } = recordedPlace(env, slug);
      return branch || worktree ? [{ jobId: id, projectId: FIXED_PROJECT_ID, slug, type: null, branch, worktree }] : [];
    });
}

// Prepares one rival job queued on the given start branch, with the git runner the test chose.
function startRival(env, checkout, { rival, branch, gitImpl = runGitAsync }) {
  const job = { id: rival.id, project_id: FIXED_PROJECT_ID, slug: rival.slug, start_branch: branch, start_worktree: null };
  return prepareJobWorktree({ job, checkout, baseBranch: "main", env, gitImpl, openHolds: rivalHolds(env) });
}

// The rival that won a race and the rival that lost it, with their results; asserts there is exactly one of each.
function raceOutcome(results) {
  assert.equal(results.filter((result) => result.ok === true).length, 1, `not exactly one winner: ${JSON.stringify(results)}`);
  const winner = results.findIndex((result) => result.ok === true);
  return { winner: RIVALS[winner], loser: RIVALS[1 - winner], lost: results[1 - winner] };
}

test("two jobs started at once on the branch a linked worktree holds: exactly one takes it, the other gates naming it", async (t) => {
  const env = homeEnv(t, "race-held");
  const checkout = initGitRepo(makeDir(t, "race-held-repo"));
  linkedWorktree(t, checkout, { name: "race-held", branch: "feat/held" });

  const results = await Promise.all(RIVALS.map((rival) => startRival(env, checkout, { rival, branch: "feat/held" })));

  const { winner, loser, lost } = raceOutcome(results);
  assert.equal(lost.code, WORKTREE_FAILED);
  assert.match(lost.message, new RegExp(`belongs to J-${winner.id}, which is not closed`));
  assert.deepEqual(recordedPlace(env, loser.slug), { branch: null, worktree: null });
});

test("two jobs started at once on a local start branch: one worktree is created, and the loser gates before any git worktree add", async (t) => {
  const env = homeEnv(t, "race-create");
  const checkout = initGitRepo(makeDir(t, "race-create-repo"));
  const work = branchWithCommit(checkout, "feat/x");
  const adds = new Map();
  const counting = (rival) => async (options) => {
    if (options.args[0] === "worktree" && options.args[1] === "add") adds.set(rival.id, (adds.get(rival.id) ?? 0) + 1);
    return await runGitAsync(options);
  };

  const results = await Promise.all(RIVALS.map((rival) => startRival(env, checkout, { rival, branch: "feat/x", gitImpl: counting(rival) })));

  const { winner, loser, lost } = raceOutcome(results);
  assert.match(lost.message, new RegExp(`belongs to J-${winner.id}, which is not closed`));
  assert.equal(adds.has(loser.id), false, "the loser ran git worktree add");
  assert.deepEqual(recordedPlace(env, loser.slug), { branch: null, worktree: null });
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, loser.slug, env)), false);
  assert.equal(sha(jobWorktreePath(FIXED_PROJECT_ID, winner.slug, env)), work);
});

test("a second job started after the first took the start branch gates naming the first", async (t) => {
  const env = homeEnv(t, "race-sequential");
  const checkout = initGitRepo(makeDir(t, "race-sequential-repo"));
  linkedWorktree(t, checkout, { name: "race-sequential", branch: "feat/held" });

  const first = await startRival(env, checkout, { rival: RIVALS[0], branch: "feat/held" });
  const second = await startRival(env, checkout, { rival: RIVALS[1], branch: "feat/held" });

  assert.equal(first.ok, true, first.message);
  assert.match(second.message ?? "", /belongs to J-7, which is not closed/);
});

test("a start point whose claim lock another live process holds gates asking for a retry, and records nothing", async (t) => {
  const env = homeEnv(t, "claim-busy");
  const checkout = initGitRepo(makeDir(t, "claim-busy-repo"));
  linkedWorktree(t, checkout, { name: "claim-busy", branch: "feat/held" });
  const lock = startPointsLockPath(FIXED_PROJECT_ID, env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), String(process.pid));

  const gated = await prepareJobWorktree({ job: jobOf({ branch: "feat/held" }), checkout, baseBranch: "main", env, openHolds: async () => [], claimTimeoutMs: 100 });

  assert.equal(gated.code, WORKTREE_FAILED);
  assert.match(gated.message, /another job of this project is taking its starting point right now - retry/);
  assert.deepEqual(recordedPlace(env), { branch: null, worktree: null });
});

test("a dirty start worktree is taken with a job-log line naming its uncommitted paths, and a clean one logs nothing", async (t) => {
  const env = homeEnv(t, "start-dirty");
  const checkout = initGitRepo(makeDir(t, "start-dirty-repo"));
  const dirty = linkedWorktree(t, checkout, { name: "start-dirty", branch: "feat/dirty" });
  writeFileSync(join(dirty, "tracked.txt"), "first\n");
  git(["-C", dirty, "add", "tracked.txt"]);
  git(["-C", dirty, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "tracked"]);
  writeFileSync(join(dirty, "tracked.txt"), "changed\n");
  makeDirty(dirty);

  const prepared = await prepare(env, checkout, { job: jobOf({ worktree: dirty }) });

  assert.deepEqual({ ok: prepared.ok, reused: prepared.reused }, { ok: true, reused: true }, prepared.message);
  const line = prepared.logged.find((entry) => entry.includes("has uncommitted changes"));
  assert.match(line ?? "", /tracked\.txt/);
  assert.match(line ?? "", /uncommitted\.txt/);
  assert.match(line ?? "", /nightqueue never removes this worktree/);

  const clean = linkedWorktree(t, checkout, { name: "start-clean", branch: "feat/clean" });
  const quiet = await prepare(env, checkout, { job: jobOf({ worktree: clean }, "clean-run") });
  assert.equal(quiet.ok, true, quiet.message);
  assert.equal(quiet.logged.some((entry) => entry.includes("uncommitted")), false);
});

test("a start branch is never read through the slug's aliases: the retry after a failed add takes the queued branch", async (t) => {
  const env = homeEnv(t, "start-no-alias");
  const checkout = initGitRepo(makeDir(t, "start-no-alias-repo"));
  git(["-C", checkout, "branch", "worktree-bar"]);
  git(["-C", checkout, "branch", "fix/baz"]);
  const job = jobOf({ branch: "worktree-bar" }, "baz");
  let failedOnce = false;
  const flaky = async (options) => {
    if (!failedOnce && options.args[0] === "worktree" && options.args[1] === "add") {
      failedOnce = true;
      return { ok: false, stdout: "", stderr: "fatal: injected failure" };
    }
    return await runGitAsync(options);
  };

  const first = await prepareJobWorktree({ job, checkout, baseBranch: "main", env, gitImpl: flaky, openHolds: async () => [] });
  const retry = await prepareJobWorktree({ job, checkout, baseBranch: "main", env, openHolds: async () => [] });

  assert.equal(first.ok, false);
  assert.equal(retry.ok, true, retry.message);
  assert.equal(retry.branch, "worktree-bar");
  assert.equal(headBranch(jobWorktreePath(FIXED_PROJECT_ID, "baz", env)), "worktree-bar");
});

test("a worktree the job entered is marked adopted in its state, and one the runtime created for a start branch is not", async (t) => {
  const env = homeEnv(t, "start-adopted-mark");
  const checkout = initGitRepo(makeDir(t, "start-adopted-mark-repo"));
  const held = linkedWorktree(t, checkout, { name: "start-adopted-mark", branch: "feat/held" });
  branchWithCommit(checkout, "feat/x");

  await prepare(env, checkout, { job: jobOf({ worktree: held }) });
  await prepare(env, checkout, { job: jobOf({ branch: "feat/x" }, "created-run") });

  const adopted = readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env });
  assert.equal(adopted.adoptedWorktree, adopted.worktree);
  assert.ok(samePath(adopted.worktree, held));
  assert.equal("adoptedWorktree" in readRunState({ projectId: FIXED_PROJECT_ID, slug: "created-run", env }), false);
});

// The closed job a release reads: the start job with its checkout and a recorded pull request.
function closedJob(job, checkout) {
  return { ...job, project: "alpha", project_path: checkout, pr_url: "https://github.com/o/r/pull/1" };
}

// A published checkout with a pushed linked worktree outside the home, and the job queued to start in it, already placed.
async function adoptedRun(t, name) {
  const env = homeEnv(t, name);
  const { checkout } = publishedCheckout(t, name);
  const path = linkedWorktree(t, checkout, { name, branch: "feat/mine" });
  git(["-C", path, "push", "-q", "-u", "origin", "feat/mine"]);
  const job = jobOf({ worktree: path });
  const placed = await prepare(env, checkout, { job });
  assert.equal(placed.ok, true, placed.message);
  return { env, checkout, path, job };
}

test("a release never removes the worktree the job adopted, clean, pushed and with a pull request, even forced", async (t) => {
  const { env, checkout, path, job } = await adoptedRun(t, "release-adopted");

  const plain = await releaseJobWorktree({ job: closedJob(job, checkout), env });
  assert.deepEqual({ ...plain, path: undefined }, { path: undefined, status: "kept", reason: ADOPTED_WORKTREE_REASON });
  assert.ok(samePath(plain.path, path));

  makeDirty(path);
  const forced = await releaseJobWorktree({ job: closedJob(job, checkout), env, force: true });
  assert.equal(forced.status, "kept");
  assert.equal(existsSync(join(path, "uncommitted.txt")), true, "a forced release dropped the adopted worktree's files");
});

test("a worktree the runtime created stays under D-27: a start branch's own, and an adopted one recreated at the home target", async (t) => {
  const { env, checkout, path, job } = await adoptedRun(t, "release-created");
  git(["-C", checkout, "worktree", "remove", path]);
  const recreated = await prepare(env, checkout, { job });
  assert.equal(recreated.ok, true, recreated.message);
  assert.equal(recreated.path, jobWorktreePath(FIXED_PROJECT_ID, SLUG, env));
  const released = await releaseJobWorktree({ job: closedJob(job, checkout), env });
  assert.equal(released.status, "removed", JSON.stringify(released));

  git(["-C", checkout, "branch", "feat/own", "main"]);
  const own = jobOf({ branch: "feat/own" }, "own-run");
  const created = await prepare(env, checkout, { job: own });
  assert.equal(created.ok, true, created.message);
  const ownReleased = await releaseJobWorktree({ job: closedJob(own, checkout), env });
  assert.equal(ownReleased.status, "removed", JSON.stringify(ownReleased));
});

test("an agent can never set the adopted mark through the run fields", (t) => {
  const env = homeEnv(t, "adopted-refused");
  const refused = recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { adoptedWorktree: "/x" }, env });
  assert.equal(refused.status, "kept");
  assert.match(refused.reason, /unknown field `adoptedWorktree`/);
});
