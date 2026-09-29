import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobWorktreePath, runDir } from "../../src/config/paths.mjs";
import { runGitAsync } from "../../src/host/git.mjs";
import { jobBranchName, prepareJobWorktree, WORKTREE_FAILED } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { addWorktree, git, gitVars, localBranches, publishedCheckout, registeredWorktrees } from "../../test-support/worktrees.mjs";

const SLUG = "fix-the-worker";

// A job bound to its run, the shape the runner hands the preparer.
function jobOf(slug = SLUG) {
  return { id: 7, project_id: FIXED_PROJECT_ID, slug };
}

// An isolated home whose git never reads the configuration of the machine.
function homeEnv(t, name) {
  return { ...makeHome(t, name), ...gitVars() };
}

// Runs the preparer the way the runner does, collecting what it logs.
async function prepare(env, checkout, { job = jobOf(), baseBranch = "main" } = {}) {
  const logged = [];
  const result = await prepareJobWorktree({ job, checkout, baseBranch, env, log: (line) => logged.push(line) });
  return { ...result, logged };
}

// The commit a ref names in a repository.
function sha(repo, ref = "HEAD") {
  return git(["-C", repo, "rev-parse", ref]).trim();
}

// Tells whether git registers a worktree at that path in the checkout.
function isRegistered(checkout, path) {
  return registeredWorktrees(checkout).some((listed) => realpathSync(listed) === realpathSync(path));
}

test("a fresh job gets its own worktree under the home, branched without tracking from the fetched origin default branch, recorded in its state", async (t) => {
  const env = homeEnv(t, "job-worktree-fresh");
  const { checkout } = publishedCheckout(t, "job-worktree-fresh");
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "local only"]);

  const prepared = await prepare(env, checkout);

  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  assert.deepEqual({ ...prepared, logged: undefined }, { ok: true, path: target, branch: `worktree-${SLUG}`, reused: false, legacy: false, logged: undefined });
  assert.ok(isRegistered(checkout, target));
  assert.equal(sha(target), sha(checkout, "origin/main"), "the worktree did not start from origin/main");
  assert.notEqual(sha(target), sha(checkout), "the worktree started from the local HEAD although origin answered");
  const upstream = spawnSync("git", ["-C", target, "rev-parse", "--abbrev-ref", "@{u}"], { env, encoding: "utf8" });
  assert.notEqual(upstream.status, 0, `the job branch tracks ${upstream.stdout}`);
  const state = readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env });
  assert.deepEqual({ branch: state.branch, worktree: state.worktree }, { branch: `worktree-${SLUG}`, worktree: target });
  assert.deepEqual(prepared.logged, []);
});

test("with no remote the worktree starts from the checkout's HEAD, and the failed fetch is only logged", async (t) => {
  const env = homeEnv(t, "job-worktree-no-remote");
  const checkout = initGitRepo(makeDir(t, "job-worktree-no-remote-repo"));

  const prepared = await prepare(env, checkout);

  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(sha(prepared.path), sha(checkout));
  assert.equal(prepared.logged.length, 1);
  assert.match(prepared.logged[0], /^git fetch origin main failed/);
});

test("a job whose home worktree is registered reuses it where it is and writes nothing", async (t) => {
  const env = homeEnv(t, "job-worktree-reuse");
  const checkout = initGitRepo(makeDir(t, "job-worktree-reuse-repo"));
  const first = await prepare(env, checkout);
  const before = readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).updatedAt;

  const again = await prepare(env, checkout);

  assert.deepEqual({ ok: again.ok, path: again.path, branch: again.branch, reused: again.reused, legacy: again.legacy }, { ok: true, path: first.path, branch: first.branch, reused: true, legacy: false });
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).updatedAt, before, "a reuse wrote the state again");
});

test("a job whose state names a legacy `.claude/worktrees/` worktree keeps running in it, flagged legacy", async (t) => {
  const env = homeEnv(t, "job-worktree-legacy");
  const { checkout } = publishedCheckout(t, "job-worktree-legacy");
  const legacy = addWorktree(checkout, "fix+legacy-run", { push: false });
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: legacy.branch, worktree: legacy.path }, env });

  const prepared = await prepare(env, checkout);

  assert.deepEqual({ ok: prepared.ok, path: prepared.path, branch: prepared.branch, reused: prepared.reused, legacy: prepared.legacy }, { ok: true, path: legacy.path, branch: legacy.branch, reused: true, legacy: true });
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false, "a second worktree was created under the home");
});

test("a recorded worktree whose directory is gone is recreated under the home from its recorded branch, keeping its commits", async (t) => {
  const env = homeEnv(t, "job-worktree-recreate");
  const { checkout } = publishedCheckout(t, "job-worktree-recreate");
  const legacy = addWorktree(checkout, "fix+gone-run", { push: false });
  const work = sha(legacy.path);
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: legacy.branch, worktree: legacy.path }, env });
  rmSync(legacy.path, { recursive: true, force: true });

  const prepared = await prepare(env, checkout);

  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  assert.deepEqual({ ok: prepared.ok, path: prepared.path, branch: prepared.branch, reused: prepared.reused, legacy: prepared.legacy }, { ok: true, path: target, branch: legacy.branch, reused: false, legacy: false });
  assert.equal(sha(target), work, "the recreated worktree lost the commits of its branch");
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).worktree, target);
});

test("a directory already at the job's path that is not its registered worktree gates the job, and nothing is deleted", async (t) => {
  const env = homeEnv(t, "job-worktree-occupied");
  const checkout = initGitRepo(makeDir(t, "job-worktree-occupied-repo"));
  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  mkdirSync(target, { recursive: true });

  const prepared = await prepare(env, checkout);

  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.ok(prepared.message.includes(target), prepared.message);
  assert.equal(existsSync(target), true);
});

test("a `worktree-<slug>` branch the state does not name is never taken over", async (t) => {
  const env = homeEnv(t, "job-worktree-foreign");
  const checkout = initGitRepo(makeDir(t, "job-worktree-foreign-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);

  const prepared = await prepare(env, checkout);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, new RegExp(`\`worktree-${SLUG}\` already exists`));
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false);
});

test("a job with no slug gates: the runtime cannot place its worktree, and never hands the job back to the agent", async (t) => {
  const env = homeEnv(t, "job-worktree-no-slug");
  const checkout = initGitRepo(makeDir(t, "job-worktree-no-slug-repo"));

  const prepared = await prepare(env, checkout, { job: jobOf(null) });

  assert.deepEqual(prepared, { ok: false, code: WORKTREE_FAILED, message: "the run has no slug, so the runtime cannot place its worktree", logged: [] });
});

// A git runner that records every call and lets a test answer some of them itself.
function recordingGit(intercept = () => null) {
  const calls = [];
  const gitImpl = async (call) => {
    calls.push(call);
    return (await intercept(call)) ?? (await runGitAsync(call));
  };
  return { calls, gitImpl };
}

// A checkout that is itself a linked worktree of a bare repository, so its `.git` is a file.
function gitfileCheckout(t, name) {
  const src = initGitRepo(makeDir(t, `${name}-src`));
  const project = makeDir(t, `${name}-project`);
  git(["clone", "--bare", "-q", src, join(project, ".bare")]);
  git(["-C", join(project, ".bare"), "worktree", "add", "-q", "../main", "main"]);
  return realpathSync(join(project, "main"));
}

test("a state that refuses the record creates nothing, and the retry creates the worktree once the cause is gone", async (t) => {
  const env = homeEnv(t, "job-worktree-refused");
  const checkout = initGitRepo(makeDir(t, "job-worktree-refused-repo"));
  const stateFile = join(runDir(FIXED_PROJECT_ID, SLUG, env), "state.json");
  mkdirSync(stateFile, { recursive: true });
  const { calls, gitImpl } = recordingGit();

  const refused = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /was not created: the state of the run could not record it/);
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false);
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}`), false, "a branch was created before the record");
  assert.equal(calls.some(({ args }) => ["add", "fetch", "prune", "remove"].includes(args[1]) || args[0] === "fetch"), false, JSON.stringify(calls.map(({ args }) => args)));
  rmSync(stateFile, { recursive: true, force: true });

  const retried = await prepare(env, checkout);

  assert.equal(retried.ok, true, retried.message);
});

test("a failed add that left its branch behind records only the branch, and the retry recreates the worktree from it", async (t) => {
  const env = homeEnv(t, "job-worktree-add-failed");
  const checkout = initGitRepo(makeDir(t, "job-worktree-add-failed-repo"));
  const foreign = join(checkout, ".claude", "worktrees", "other");
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { worktree: foreign }, env });
  const { gitImpl } = recordingGit(({ args }) => {
    if (args[0] !== "worktree" || args[1] !== "add") return null;
    git(["-C", checkout, "branch", `worktree-${SLUG}`]);
    return { ok: false, stdout: "", stderr: "fatal: injected failure" };
  });

  const failedAdd = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.equal(failedAdd.code, WORKTREE_FAILED);
  assert.match(failedAdd.message, /injected failure/);
  const state = readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env });
  assert.deepEqual({ branch: state.branch, worktree: state.worktree }, { branch: `worktree-${SLUG}`, worktree: foreign });
  assert.notEqual(state.worktree, jobWorktreePath(FIXED_PROJECT_ID, SLUG, env), "the state names a worktree git never created");

  const retried = await prepare(env, checkout);

  assert.deepEqual({ ok: retried.ok, branch: retried.branch, reused: retried.reused }, { ok: true, branch: `worktree-${SLUG}`, reused: false });
});

test("a registered worktree at the recorded path but on another branch is not reused", async (t) => {
  const env = homeEnv(t, "job-worktree-other-branch");
  const checkout = initGitRepo(makeDir(t, "job-worktree-other-branch-repo"));
  const first = await prepare(env, checkout);
  git(["-C", first.path, "checkout", "-q", "-b", "somebody-else"]);

  const again = await prepare(env, checkout);

  assert.equal(again.code, WORKTREE_FAILED);
  assert.ok(again.message.includes(first.path), again.message);
});

test("a recorded worktree git can no longer use after the checkout moved gates the job with the doctor hint", async (t) => {
  const env = homeEnv(t, "job-worktree-moved");
  const checkout = initGitRepo(makeDir(t, "job-worktree-moved-repo"));
  assert.equal((await prepare(env, checkout)).ok, true);
  const moved = join(makeDir(t, "job-worktree-moved-new"), "checkout");
  renameSync(checkout, moved);

  const again = await prepare(env, moved);

  assert.equal(again.code, WORKTREE_FAILED);
  assert.match(again.message, /registered but git cannot use it .*nightqueue doctor --fix/);
});

test("a checkout that is a linked worktree of a bare repository gets its worktree created, then reused", async (t) => {
  const env = homeEnv(t, "job-worktree-gitfile");
  const checkout = gitfileCheckout(t, "job-worktree-gitfile");

  const created = await prepare(env, checkout);
  const reused = await prepare(env, checkout);

  assert.equal(created.ok, true, created.message);
  assert.deepEqual({ ok: reused.ok, path: reused.path, reused: reused.reused }, { ok: true, path: created.path, reused: true });
});

test("the fetch runs ssh in batch mode unless the operator set their own ssh command", async (t) => {
  const fetchEnvOf = async (name, extra = {}) => {
    const checkout = initGitRepo(makeDir(t, `${name}-repo`));
    const { calls, gitImpl } = recordingGit(({ args }) => (args[0] === "fetch" ? { ok: false, stdout: "", stderr: "offline" } : null));
    await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env: { ...homeEnv(t, name), ...extra }, gitImpl });
    return calls.find(({ args }) => args[0] === "fetch").env;
  };

  const batch = await fetchEnvOf("job-worktree-ssh-batch");
  const own = await fetchEnvOf("job-worktree-ssh-own", { GIT_SSH_COMMAND: "ssh -i key" });

  assert.equal(batch.GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
  assert.equal(batch.GIT_TERMINAL_PROMPT, "0");
  assert.equal(own.GIT_SSH_COMMAND, "ssh -i key");
});

test("recreating from a recorded branch no worktree holds never prunes the checkout's worktrees", async (t) => {
  const env = homeEnv(t, "job-worktree-no-prune");
  const checkout = initGitRepo(makeDir(t, "job-worktree-no-prune-repo"));
  git(["-C", checkout, "branch", "worktree-kept"]);
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: "worktree-kept" }, env });
  const { calls, gitImpl } = recordingGit();

  const prepared = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch }, { ok: true, branch: "worktree-kept" });
  assert.equal(calls.some(({ args }) => args[0] === "worktree" && args[1] === "prune"), false);
});

test("the job branch of a slug holding `+` never carries it", () => {
  assert.equal(jobBranchName("a+b"), "worktree-a-b");
  assert.equal(jobBranchName("fix-the-worker"), "worktree-fix-the-worker");
});
