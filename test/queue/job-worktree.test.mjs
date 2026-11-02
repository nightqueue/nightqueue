import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobWorktreePath, runDir } from "../../src/config/paths.mjs";
import { runGitAsync } from "../../src/host/git.mjs";
import { publishedBranchName } from "../../src/queue/branch-name.mjs";
import { jobBranchName, prepareJobWorktree, WORKTREE_FAILED, worktreeSlotFree } from "../../src/queue/job-worktree.mjs";
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

test("a directory at the job's path git does not register is refused as stray, naming the command that frees it, and nothing is deleted", async (t) => {
  const env = homeEnv(t, "job-worktree-occupied");
  const checkout = initGitRepo(makeDir(t, "job-worktree-occupied-repo"));
  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  mkdirSync(target, { recursive: true });

  const prepared = await prepare(env, checkout);

  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /stray directory/);
  assert.ok(prepared.message.includes(`\`rmdir '${target}'\``), prepared.message);
  assert.doesNotMatch(prepared.message, /doctor|rm -rf/);
  assert.equal(existsSync(target), true);
});

test("a stray directory holding files gets a move that overwrites nothing, past a name already taken, and its files stay", async (t) => {
  const env = homeEnv(t, "job-worktree-stray-files");
  const checkout = initGitRepo(makeDir(t, "job-worktree-stray-files-repo"));
  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "notes.txt"), "the operator's own notes\n");

  const first = await prepare(env, checkout);

  assert.equal(first.code, WORKTREE_FAILED);
  assert.ok(first.message.includes(`\`mv -n '${target}' '${target}.stray'\``), first.message);
  assert.doesNotMatch(first.message, /rm -rf/);
  assert.equal(existsSync(join(target, "notes.txt")), true);

  mkdirSync(`${target}.stray`);
  const second = await prepare(env, checkout);

  assert.ok(second.message.includes(`\`mv -n '${target}' '${target}.stray-2'\``), second.message);
});

test("a file at the job's path, which cannot be read as a directory, gets the move and never `rmdir`", async (t) => {
  const env = homeEnv(t, "job-worktree-stray-file");
  const checkout = initGitRepo(makeDir(t, "job-worktree-stray-file-repo"));
  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, "a file\n");

  const prepared = await prepare(env, checkout);

  assert.ok(prepared.message.includes(`\`mv -n '${target}' '${target}.stray'\``), prepared.message);
});

test("git failing to list the worktrees never calls the job's path stray", async (t) => {
  const env = homeEnv(t, "job-worktree-list-failed");
  const checkout = initGitRepo(makeDir(t, "job-worktree-list-failed-repo"));
  mkdirSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env), { recursive: true });
  const { gitImpl } = recordingGit(({ args }) => (args[0] === "worktree" && args[1] === "list" ? { ok: false, stdout: "", stderr: "fatal: injected failure" } : null));

  const prepared = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /git cannot list the worktrees .*injected failure.*retry/);
  assert.doesNotMatch(prepared.message, /rm -rf|stray/);
});

test("a `worktree-<slug>` branch the state does not name is never taken over: the run moves to the next free name, recorded, with one log line", async (t) => {
  const env = homeEnv(t, "job-worktree-foreign");
  const checkout = initGitRepo(makeDir(t, "job-worktree-foreign-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);
  git(["-C", checkout, "branch", `worktree-${SLUG}-2`]);
  const left = sha(checkout, `worktree-${SLUG}`);

  const prepared = await prepare(env, checkout);

  const moved = `worktree-${SLUG}-3`;
  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  assert.deepEqual({ ok: prepared.ok, path: prepared.path, branch: prepared.branch, reused: prepared.reused }, { ok: true, path: target, branch: moved, reused: false }, prepared.message);
  assert.deepEqual(recordedPlace(env), { branch: moved, worktree: target });
  assert.equal(sha(checkout, `worktree-${SLUG}`), left, "the branch left behind was touched");
  assert.deepEqual(prepared.logged.filter((line) => line.includes("is taken")), [`the branch \`worktree-${SLUG}\` is taken (\`worktree-${SLUG}\`) and the state of this run does not name it: the run takes \`${moved}\``]);
});

// A hold of another open job over a branch, the shape `openJobHolds` answers.
function holdOf(branch, { jobId = 99, slug = "another-run" } = {}) {
  return { jobId, projectId: FIXED_PROJECT_ID, slug, type: null, branch, worktree: null };
}

// Prepares the test job with the holds of the other open jobs given.
async function prepareWithHolds(env, checkout, holds) {
  const logged = [];
  const result = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, log: (line) => logged.push(line), openHolds: async () => holds });
  return { ...result, logged };
}

test("a taken branch name another open job holds gates naming that job, and creates nothing", async (t) => {
  const env = homeEnv(t, "job-worktree-held-name");
  const checkout = initGitRepo(makeDir(t, "job-worktree-held-name-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);

  const prepared = await prepareWithHolds(env, checkout, [holdOf(`worktree-${SLUG}`)]);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /J-99/);
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false);
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}-2`), false);
});

test("a later name another open job holds is skipped, never a gate", async (t) => {
  const env = homeEnv(t, "job-worktree-held-rung");
  const checkout = initGitRepo(makeDir(t, "job-worktree-held-rung-repo"));
  git(["-C", checkout, "branch", FIX_BRANCH]);

  const prepared = await prepareWithHolds(env, checkout, [holdOf(`worktree-${SLUG}-2`, { slug: `${SLUG}-2` })]);

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch }, { ok: true, branch: `worktree-${SLUG}-3` }, prepared.message);
});

test("an unreadable queue gates a job whose branch name is taken, and creates nothing", async (t) => {
  const env = homeEnv(t, "job-worktree-held-unreadable");
  const checkout = initGitRepo(makeDir(t, "job-worktree-held-unreadable-repo"));
  git(["-C", checkout, "branch", FIX_BRANCH]);

  const prepared = await prepareWithHolds(env, checkout, null);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /the queue could not be read/);
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}-2`), false);
});

test("a rival claiming the next free name first gates the job naming it, and creates nothing", async (t) => {
  const env = homeEnv(t, "job-worktree-rung-race");
  const checkout = initGitRepo(makeDir(t, "job-worktree-rung-race-repo"));
  git(["-C", checkout, "branch", FIX_BRANCH]);
  let reads = 0;
  const openHolds = async () => {
    reads += 1;
    return reads === 1 ? [] : [holdOf(`worktree-${SLUG}-2`)];
  };

  const prepared = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, openHolds });

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /J-99/);
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}-2`), false);
});

test("every name of the ladder taken gates naming the range, with no rename or delete instruction", async (t) => {
  const env = homeEnv(t, "job-worktree-ladder-full");
  const checkout = initGitRepo(makeDir(t, "job-worktree-ladder-full-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);
  const { gitImpl } = recordingGit(({ args }) => (args[0] === "rev-parse" && args[2] === "--quiet" && String(args[3]).startsWith(`refs/heads/worktree-${SLUG}-`) ? { ok: true, stdout: "", stderr: "" } : null));

  const prepared = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.ok(prepared.message.includes(`worktree-${SLUG}-99`), prepared.message);
  assert.doesNotMatch(prepared.message, /rename|delete|doctor/);
});

test("a laddered run is reused, recreated and published under its own rung, never under the old branch's name", async (t) => {
  const env = homeEnv(t, "job-worktree-rung-life");
  const checkout = initGitRepo(makeDir(t, "job-worktree-rung-life-repo"));
  git(["-C", checkout, "branch", FIX_BRANCH]);
  const rung = `worktree-${SLUG}-2`;

  const first = await prepare(env, checkout);
  assert.equal(first.branch, rung, first.message);
  assert.equal(publishedBranchName(first.branch, { slug: SLUG, commitType: "fix" }), `${FIX_BRANCH}-2`);

  const again = await prepare(env, checkout);
  assert.deepEqual({ ok: again.ok, branch: again.branch, reused: again.reused }, { ok: true, branch: rung, reused: true }, again.message);

  git(["-C", checkout, "worktree", "remove", first.path]);
  const recreated = await prepare(env, checkout);
  assert.deepEqual({ ok: recreated.ok, branch: recreated.branch, reused: recreated.reused }, { ok: true, branch: rung, reused: false }, recreated.message);
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

test("a registered worktree at the job's path on another branch is adopted: the state follows the branch it holds, with one log line", async (t) => {
  const env = homeEnv(t, "job-worktree-other-branch");
  const checkout = initGitRepo(makeDir(t, "job-worktree-other-branch-repo"));
  const first = await prepare(env, checkout);
  git(["-C", first.path, "checkout", "-q", "-b", "somebody-else"]);

  const again = await prepare(env, checkout);

  assert.deepEqual({ ok: again.ok, path: again.path, branch: again.branch, reused: again.reused, legacy: again.legacy }, { ok: true, path: first.path, branch: "somebody-else", reused: true, legacy: false }, again.message);
  assert.deepEqual(recordedPlace(env), { branch: "somebody-else", worktree: first.path });
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).adoptedWorktree, undefined, "the runtime's own worktree was marked as never removable");
  assert.deepEqual(again.logged, [`the run's branch is \`somebody-else\` (state named \`${first.branch}\`); the state now follows git`]);
});

test("a registered worktree at the job's path on a branch another open job holds is refused naming that job, and the state does not move", async (t) => {
  const env = homeEnv(t, "job-worktree-adopt-held");
  const checkout = initGitRepo(makeDir(t, "job-worktree-adopt-held-repo"));
  const first = await prepare(env, checkout);
  git(["-C", first.path, "checkout", "-q", "-b", "somebody-else"]);

  const again = await prepareWithHolds(env, checkout, [holdOf("somebody-else")]);

  assert.equal(again.code, WORKTREE_FAILED);
  assert.match(again.message, /J-99/);
  assert.deepEqual(recordedPlace(env), { branch: first.branch, worktree: first.path });
});

test("a rival holding the branch by the time of the claim gates the adoption naming it, and the state does not move", async (t) => {
  const env = homeEnv(t, "job-worktree-adopt-race");
  const checkout = initGitRepo(makeDir(t, "job-worktree-adopt-race-repo"));
  const first = await prepare(env, checkout);
  git(["-C", first.path, "checkout", "-q", "-b", "somebody-else"]);
  let reads = 0;
  const openHolds = async () => {
    reads += 1;
    return reads <= 2 ? [] : [holdOf("somebody-else")];
  };

  const again = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, openHolds });

  assert.equal(again.code, WORKTREE_FAILED);
  assert.match(again.message, /J-99/);
  assert.deepEqual(recordedPlace(env), { branch: first.branch, worktree: first.path });
});

test("a registered worktree at the job's path on the default branch is refused, and the state does not move", async (t) => {
  const env = homeEnv(t, "job-worktree-adopt-base");
  const checkout = initGitRepo(makeDir(t, "job-worktree-adopt-base-repo"));
  const first = await prepare(env, checkout);
  git(["-C", checkout, "checkout", "-q", "-b", "elsewhere"]);
  git(["-C", first.path, "checkout", "-q", "main"]);

  const again = await prepare(env, checkout);

  assert.equal(again.code, WORKTREE_FAILED);
  assert.match(again.message, /`main` is the default branch/);
  assert.deepEqual(recordedPlace(env), { branch: first.branch, worktree: first.path });
});

test("a registered worktree at the job's path on a detached HEAD is adopted on the next free name of its branch", async (t) => {
  const env = homeEnv(t, "job-worktree-adopt-detached");
  const checkout = initGitRepo(makeDir(t, "job-worktree-adopt-detached-repo"));
  const first = await prepare(env, checkout);
  git(["-C", first.path, "checkout", "-q", "--detach"]);

  const again = await prepare(env, checkout);

  assert.equal(again.ok, true, again.message);
  assert.equal(again.path, first.path);
  assert.equal(again.branch, `${first.branch}-2`);
  assert.deepEqual(recordedPlace(env), { branch: `${first.branch}-2`, worktree: first.path });
});

test("a registered worktree on a detached HEAD at the job's path with no record of its own takes the job's branch", async (t) => {
  const env = homeEnv(t, "job-worktree-adopt-detached-new");
  const checkout = initGitRepo(makeDir(t, "job-worktree-adopt-detached-new-repo"));
  const target = jobWorktreePath(FIXED_PROJECT_ID, SLUG, env);
  git(["-C", checkout, "worktree", "add", "-q", "--detach", target, "main"]);

  const prepared = await prepare(env, checkout);

  assert.equal(prepared.ok, true, prepared.message);
  assert.equal(prepared.branch, `worktree-${SLUG}`);
  assert.deepEqual(recordedPlace(env), { branch: `worktree-${SLUG}`, worktree: target });
  assert.equal(git(["-C", target, "symbolic-ref", "--short", "HEAD"]).trim(), `worktree-${SLUG}`);
});

test("a recorded worktree git can no longer use after the checkout moved is repaired by itself and reused, its commits intact", async (t) => {
  const env = homeEnv(t, "job-worktree-moved");
  const checkout = initGitRepo(makeDir(t, "job-worktree-moved-repo"));
  const first = await prepare(env, checkout);
  const work = sha(first.path);
  const moved = join(makeDir(t, "job-worktree-moved-new"), "checkout");
  renameSync(checkout, moved);

  const again = await prepare(env, moved);

  assert.deepEqual({ ok: again.ok, path: again.path, branch: again.branch, reused: again.reused }, { ok: true, path: first.path, branch: first.branch, reused: true }, again.message);
  assert.equal(sha(again.path), work);
  assert.ok(again.logged.some((line) => line.includes("`git worktree repair` fixed it")), again.logged.join("\n"));
});

test("a recorded worktree a repair cannot fix gates saying so, with no doctor or delete instruction", async (t) => {
  const env = homeEnv(t, "job-worktree-repair-failed");
  const checkout = initGitRepo(makeDir(t, "job-worktree-repair-failed-repo"));
  const first = await prepare(env, checkout);
  const { calls, gitImpl } = recordingGit(({ args, cwd }) => (args[1] === "--git-common-dir" && realpathSync(cwd) === realpathSync(first.path) ? { ok: false, stdout: "", stderr: "fatal: not a git repository" } : null));

  const again = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.equal(again.code, WORKTREE_FAILED);
  assert.match(again.message, /not a git repository; `git worktree repair` did not fix it/);
  assert.doesNotMatch(again.message, /doctor|delete|rename/);
  assert.equal(calls.filter(({ args }) => args[1] === "repair").length, 1);
});

test("a recorded worktree linked to another repository is never repaired, and gates naming why", async (t) => {
  const env = homeEnv(t, "job-worktree-foreign-link");
  const checkout = initGitRepo(makeDir(t, "job-worktree-foreign-link-repo"));
  const first = await prepare(env, checkout);
  const { calls, gitImpl } = recordingGit(({ args, cwd }) => (args[1] === "--git-common-dir" && realpathSync(cwd) === realpathSync(first.path) ? { ok: true, stdout: "/somewhere/else/.git\n", stderr: "" } : null));

  const again = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.equal(again.code, WORKTREE_FAILED);
  assert.match(again.message, /it links to another repository/);
  assert.doesNotMatch(again.message, /doctor|delete|rename/);
  assert.equal(calls.some(({ args }) => args[1] === "repair"), false);
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

const FIX_BRANCH = `fix/${SLUG}`;

// Prepares a job's worktree, commits in it and renames its branch the way `run pr` does, leaving the state on the old name.
async function renamedRun(env, checkout) {
  const first = await prepare(env, checkout);
  git(["-C", first.path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "fix: the job's work"]);
  git(["-C", first.path, "branch", "-m", first.branch, FIX_BRANCH]);
  return { path: first.path, work: sha(first.path) };
}

// The branch and worktree the state of the test run names.
function recordedPlace(env) {
  const state = readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env });
  return { branch: state.branch, worktree: state.worktree };
}

test("a worktree whose branch `run pr` renamed after the state was written is reused in place, and the state follows git", async (t) => {
  const env = homeEnv(t, "job-worktree-renamed");
  const checkout = initGitRepo(makeDir(t, "job-worktree-renamed-repo"));
  const run = await renamedRun(env, checkout);

  const again = await prepare(env, checkout);

  assert.deepEqual({ ok: again.ok, path: again.path, branch: again.branch, reused: again.reused }, { ok: true, path: run.path, branch: FIX_BRANCH, reused: true }, again.message);
  assert.deepEqual(recordedPlace(env), { branch: FIX_BRANCH, worktree: run.path });
  assert.ok(again.logged.some((line) => line.includes("the state now follows git")), again.logged.join("\n"));
});

test("a renamed run whose worktree was deleted is recreated on the renamed branch with its commit, never from the base", async (t) => {
  const env = homeEnv(t, "job-worktree-renamed-gone");
  const { checkout } = publishedCheckout(t, "job-worktree-renamed-gone");
  const run = await renamedRun(env, checkout);
  git(["-C", checkout, "worktree", "remove", run.path]);

  const prepared = await prepare(env, checkout);

  assert.deepEqual({ ok: prepared.ok, path: prepared.path, branch: prepared.branch, reused: prepared.reused }, { ok: true, path: run.path, branch: FIX_BRANCH, reused: false }, prepared.message);
  assert.equal(sha(prepared.path), run.work, "the recreated worktree lost the job's commit");
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}`), false, "a fresh branch was created beside the published one");
  assert.deepEqual(recordedPlace(env), { branch: FIX_BRANCH, worktree: run.path });
});

test("a renamed run whose worktree and local branch are gone is recreated from the branch on origin, never from the base", async (t) => {
  const env = homeEnv(t, "job-worktree-renamed-origin");
  const { checkout } = publishedCheckout(t, "job-worktree-renamed-origin");
  const run = await renamedRun(env, checkout);
  git(["-C", run.path, "push", "-q", "origin", FIX_BRANCH]);
  git(["-C", checkout, "worktree", "remove", run.path]);
  git(["-C", checkout, "branch", "-D", "-q", FIX_BRANCH]);
  git(["-C", checkout, "update-ref", "-d", `refs/remotes/origin/${FIX_BRANCH}`]);

  const prepared = await prepare(env, checkout);

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch, reused: prepared.reused }, { ok: true, branch: FIX_BRANCH, reused: false }, prepared.message);
  assert.equal(sha(prepared.path), run.work, "the worktree did not start from the published branch");
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}`), false);
  const upstream = spawnSync("git", ["-C", prepared.path, "rev-parse", "--abbrev-ref", "@{u}"], { env, encoding: "utf8" });
  assert.notEqual(upstream.status, 0, `the recreated branch tracks ${upstream.stdout}`);
});

// Creates a branch one commit past main, committed at the given epoch second, leaving the checkout where it was.
function branchCommittedAt(checkout, { branch, at }) {
  const tree = git(["-C", checkout, "rev-parse", "main^{tree}"]).trim();
  const date = `${at} +0000`;
  const commit = execFileSync("git", ["-C", checkout, "commit-tree", tree, "-p", "main", "-m", `work on ${branch}`], { encoding: "utf8", env: { ...process.env, ...gitVars(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
  git(["-C", checkout, "branch", branch, commit]);
  return commit;
}

test("a recorded branch gone under several existing names takes the newest and leaves the others untouched, logging the pick", async (t) => {
  const env = homeEnv(t, "job-worktree-ambiguous");
  const checkout = initGitRepo(makeDir(t, "job-worktree-ambiguous-repo"));
  const older = branchCommittedAt(checkout, { branch: `feat/${SLUG}`, at: 1000000000 });
  const newer = branchCommittedAt(checkout, { branch: FIX_BRANCH, at: 2000000000 });
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: `worktree-${SLUG}` }, env });

  const prepared = await prepare(env, checkout);

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch, reused: prepared.reused }, { ok: true, branch: FIX_BRANCH, reused: false }, prepared.message);
  assert.equal(sha(prepared.path), newer);
  assert.equal(sha(checkout, `feat/${SLUG}`), older, "the name left behind was touched");
  assert.deepEqual(prepared.logged, [`the run's branch exists under several names (\`feat/${SLUG}\`, \`${FIX_BRANCH}\`): the run takes \`${FIX_BRANCH}\` and leaves the others untouched`]);
  assert.deepEqual(recordedPlace(env), { branch: FIX_BRANCH, worktree: prepared.path });
});

test("a recorded name that exists beside its other names wins over a newer one", async (t) => {
  const env = homeEnv(t, "job-worktree-recorded-wins");
  const checkout = initGitRepo(makeDir(t, "job-worktree-recorded-wins-repo"));
  branchCommittedAt(checkout, { branch: `worktree-${SLUG}`, at: 1000000000 });
  branchCommittedAt(checkout, { branch: FIX_BRANCH, at: 2000000000 });
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: `worktree-${SLUG}` }, env });

  const prepared = await prepare(env, checkout);

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch }, { ok: true, branch: `worktree-${SLUG}` }, prepared.message);
});

test("git failing to order the names still places the job on the first of them, logging why", async (t) => {
  const env = homeEnv(t, "job-worktree-ambiguous-unordered");
  const checkout = initGitRepo(makeDir(t, "job-worktree-ambiguous-unordered-repo"));
  branchCommittedAt(checkout, { branch: FIX_BRANCH, at: 1000000000 });
  branchCommittedAt(checkout, { branch: `feat/${SLUG}`, at: 1000000000 });
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: `worktree-${SLUG}` }, env });
  const { gitImpl } = recordingGit(({ args }) => (args[0] === "for-each-ref" ? { ok: false, stdout: "", stderr: "fatal: injected failure" } : null));
  const logged = [];

  const prepared = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl, log: (line) => logged.push(line) });

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch }, { ok: true, branch: `feat/${SLUG}` }, prepared.message);
  assert.ok(logged.some((line) => line.includes("injected failure")), logged.join("\n"));
});

test("a recorded branch published on origin under several names takes the newest there", async (t) => {
  const env = homeEnv(t, "job-worktree-ambiguous-origin");
  const { checkout } = publishedCheckout(t, "job-worktree-ambiguous-origin");
  branchCommittedAt(checkout, { branch: `feat/${SLUG}`, at: 1000000000 });
  const newer = branchCommittedAt(checkout, { branch: FIX_BRANCH, at: 2000000000 });
  git(["-C", checkout, "push", "-q", "origin", `feat/${SLUG}`, FIX_BRANCH]);
  git(["-C", checkout, "branch", "-q", "-D", `feat/${SLUG}`, FIX_BRANCH]);
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: `worktree-${SLUG}` }, env });

  const prepared = await prepare(env, checkout);

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch }, { ok: true, branch: FIX_BRANCH }, prepared.message);
  assert.equal(sha(prepared.path), newer);
});

test("a failed add on the renamed branch records only what git holds", async (t) => {
  const env = homeEnv(t, "job-worktree-renamed-add-failed");
  const checkout = initGitRepo(makeDir(t, "job-worktree-renamed-add-failed-repo"));
  const run = await renamedRun(env, checkout);
  git(["-C", checkout, "worktree", "remove", run.path]);
  const { gitImpl } = recordingGit(async (call) => {
    if (call.args[0] !== "worktree" || call.args[1] !== "add") return null;
    await runGitAsync(call);
    return { ok: false, stdout: "", stderr: "fatal: injected failure" };
  });

  const failedAdd = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl });

  assert.match(failedAdd.message, /injected failure/);
  assert.deepEqual(recordedPlace(env), { branch: FIX_BRANCH, worktree: run.path });
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}`), false);
});

test("a job with no recorded branch whose published name exists locally moves to the next free name, and its slot is not free", async (t) => {
  const env = homeEnv(t, "job-worktree-unrecorded-alias");
  const checkout = initGitRepo(makeDir(t, "job-worktree-unrecorded-alias-repo"));
  git(["-C", checkout, "branch", FIX_BRANCH]);

  const prepared = await prepare(env, checkout);

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch }, { ok: true, branch: `worktree-${SLUG}-2` }, prepared.message);
  assert.ok(prepared.logged.some((line) => line.includes(`\`${FIX_BRANCH}\``)), prepared.logged.join("\n"));
  assert.equal(localBranches(checkout).includes(`worktree-${SLUG}`), false);
  assert.equal(await worktreeSlotFree({ projectId: FIXED_PROJECT_ID, slug: SLUG, checkout, env }), false);
  assert.equal(await worktreeSlotFree({ projectId: FIXED_PROJECT_ID, slug: "another-run", checkout, env }), true);
});

// Asks for a slot through the given git runner, answering whether it is free and what was logged.
async function slotWithGit(t, name, gitImpl) {
  const env = homeEnv(t, name);
  const checkout = initGitRepo(makeDir(t, `${name}-repo`));
  const logged = [];
  const free = await worktreeSlotFree({ projectId: FIXED_PROJECT_ID, slug: SLUG, checkout, env, gitImpl, log: (line) => logged.push(line) });
  return { free, logged };
}

test("a slot whose git runner throws is not free, and the failure is logged", async (t) => {
  const slot = await slotWithGit(t, "job-worktree-slot-throws", async () => {
    throw new Error("spawn exploded");
  });

  assert.equal(slot.free, false);
  assert.equal(slot.logged.length, 1, slot.logged.join("\n"));
  assert.match(slot.logged[0], /spawn exploded/);
});

test("a slot whose git answers a failure is not free, though every ref would read as absent", async (t) => {
  const slot = await slotWithGit(t, "job-worktree-slot-broken-git", async () => ({ ok: false, stdout: "", stderr: "fatal: bad config line 1\nsecond line" }));

  assert.equal(slot.free, false);
  assert.equal(slot.logged.length, 1, slot.logged.join("\n"));
  assert.match(slot.logged[0], /\(fatal: bad config line 1\); retry\)$/);
});

// The real git, except that the lookup of each named ref answers a failure with no exit code, once, as a timed-out read does.
function failingLookups(...refs) {
  const left = [...refs];
  const { calls, gitImpl } = recordingGit(({ args }) => {
    const at = args[0] === "rev-parse" && args[1] === "--verify" ? left.indexOf(args[3]) : -1;
    if (at < 0) return null;
    left.splice(at, 1);
    return { ok: false, stdout: "", stderr: "fatal: timed out waiting for git", missing: false, exitCode: null };
  });
  return { calls, gitImpl };
}

// Prepares a job through a git runner, collecting what it logs.
async function prepareWith(env, checkout, gitImpl) {
  const logged = [];
  const result = await prepareJobWorktree({ job: jobOf(), checkout, baseBranch: "main", env, gitImpl, log: (line) => logged.push(line) });
  return { ...result, logged };
}

test("a slot whose branch exists is not free when that one lookup goes unanswered, with one log line", async (t) => {
  const env = homeEnv(t, "job-worktree-slot-lookup");
  const checkout = initGitRepo(makeDir(t, "job-worktree-slot-lookup-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);
  const { gitImpl } = failingLookups(`refs/heads/worktree-${SLUG}`);
  const logged = [];

  const free = await worktreeSlotFree({ projectId: FIXED_PROJECT_ID, slug: SLUG, checkout, env, gitImpl, log: (line) => logged.push(line) });

  assert.equal(free, false);
  assert.equal(logged.length, 1, logged.join("\n"));
});

test("a fresh job whose alias lookup goes unanswered gates on that read: no git add, no fresh branch, and a state naming no branch", async (t) => {
  const env = homeEnv(t, "job-worktree-fresh-lookup");
  const checkout = initGitRepo(makeDir(t, "job-worktree-fresh-lookup-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);
  const { calls, gitImpl } = failingLookups(`refs/heads/worktree-${SLUG}`);

  const prepared = await prepareWith(env, checkout, gitImpl);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /git could not read refs\/heads\/worktree-fix-the-worker .*timed out.*retry/);
  assert.doesNotMatch(prepared.message, /git worktree add/);
  assert.equal(calls.some(({ args }) => args[0] === "worktree" && args[1] === "add"), false);
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env })?.branch ?? null, null);
});

test("a recorded branch whose lookup goes unanswered gates, keeps the record and never abandons the work for a fresh branch", async (t) => {
  const env = homeEnv(t, "job-worktree-recorded-lookup");
  const checkout = initGitRepo(makeDir(t, "job-worktree-recorded-lookup-repo"));
  git(["-C", checkout, "branch", "worktree-recorded-work"]);
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: "worktree-recorded-work" }, env });
  const before = localBranches(checkout);
  const { gitImpl } = failingLookups("refs/heads/worktree-recorded-work");

  const prepared = await prepareWith(env, checkout, gitImpl);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /git could not read refs\/heads\/worktree-recorded-work/);
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).branch, "worktree-recorded-work");
  assert.deepEqual(localBranches(checkout), before);
});

test("a recorded branch whose lookup on origin goes unanswered gates and never falls through to a fresh branch", async (t) => {
  const env = homeEnv(t, "job-worktree-origin-lookup");
  const { checkout } = publishedCheckout(t, "job-worktree-origin-lookup");
  recordRunFields({ projectId: FIXED_PROJECT_ID, slug: SLUG, fields: { branch: "worktree-recorded-work" }, env });
  const before = localBranches(checkout);
  const { gitImpl } = failingLookups("refs/remotes/origin/worktree-recorded-work");

  const prepared = await prepareWith(env, checkout, gitImpl);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /git could not read refs\/remotes\/origin\/worktree-recorded-work/);
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).branch, "worktree-recorded-work");
  assert.deepEqual(localBranches(checkout), before);
});

test("a base lookup that goes unanswered gates, never starts from HEAD, creates nothing and leaves a state naming no branch", async (t) => {
  const env = homeEnv(t, "job-worktree-base-lookup");
  const { checkout } = publishedCheckout(t, "job-worktree-base-lookup");
  const before = localBranches(checkout);
  const { calls, gitImpl } = failingLookups("refs/remotes/origin/main");

  const prepared = await prepareWith(env, checkout, gitImpl);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /git could not read refs\/remotes\/origin\/main/);
  assert.doesNotMatch(prepared.message, /git worktree add/);
  assert.equal(calls.some(({ args }) => args[0] === "worktree" && args[1] === "add"), false);
  assert.deepEqual(localBranches(checkout), before);
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).branch ?? null, null);
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, env)), false);
});

test("one rung whose lookup goes unanswered is skipped and logged, and the run takes the next free name", async (t) => {
  const env = homeEnv(t, "job-worktree-rung-lookup");
  const checkout = initGitRepo(makeDir(t, "job-worktree-rung-lookup-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);
  git(["-C", checkout, "branch", `worktree-${SLUG}-2`]);
  const { gitImpl } = failingLookups(`refs/heads/worktree-${SLUG}-2`);

  const prepared = await prepareWith(env, checkout, gitImpl);

  assert.deepEqual({ ok: prepared.ok, branch: prepared.branch }, { ok: true, branch: `worktree-${SLUG}-3` }, prepared.message);
  assert.ok(prepared.logged.some((line) => line.includes(`\`worktree-${SLUG}-2\` is skipped`)), prepared.logged.join("\n"));
});

test("two rungs whose lookups go unanswered stop the walk with a refusal, not 98 more reads", async (t) => {
  const env = homeEnv(t, "job-worktree-rungs-dead");
  const checkout = initGitRepo(makeDir(t, "job-worktree-rungs-dead-repo"));
  git(["-C", checkout, "branch", `worktree-${SLUG}`]);
  const { calls, gitImpl } = failingLookups(`refs/heads/worktree-${SLUG}-2`, `refs/heads/worktree-${SLUG}-3`);

  const prepared = await prepareWith(env, checkout, gitImpl);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /git could not read refs\/heads\/worktree-fix-the-worker-3/);
  assert.equal(calls.some(({ args }) => args[3] === `refs/heads/worktree-${SLUG}-4`), false, "the walk went on past the second unreadable rung");
});

test("a failed add whose read-back goes unanswered keeps the add's own message and the prior record", async (t) => {
  const env = homeEnv(t, "job-worktree-readback");
  const checkout = initGitRepo(makeDir(t, "job-worktree-readback-repo"));
  let added = false;
  const { gitImpl } = recordingGit(({ args }) => {
    if (args[0] === "worktree" && args[1] === "add") {
      added = true;
      return { ok: false, stdout: "", stderr: "fatal: injected add failure", missing: false, exitCode: 128 };
    }
    return added && args[0] === "rev-parse" ? { ok: false, stdout: "", stderr: "fatal: timed out", missing: false, exitCode: null } : null;
  });

  const prepared = await prepareWith(env, checkout, gitImpl);

  assert.equal(prepared.code, WORKTREE_FAILED);
  assert.match(prepared.message, /git worktree add failed: fatal: injected add failure/);
  assert.equal(readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env }).branch ?? null, null);
});

test("a slot in a directory that is not a git repository is not free, with the real git and no log function", async (t) => {
  const env = homeEnv(t, "job-worktree-slot-no-repo");
  const checkout = makeDir(t, "job-worktree-slot-no-repo-dir");

  assert.equal(await worktreeSlotFree({ projectId: FIXED_PROJECT_ID, slug: SLUG, checkout, env }), false);
});

test("a free slot logs nothing", async (t) => {
  const env = homeEnv(t, "job-worktree-slot-free");
  const checkout = initGitRepo(makeDir(t, "job-worktree-slot-free-repo"));
  const logged = [];

  assert.equal(await worktreeSlotFree({ projectId: FIXED_PROJECT_ID, slug: SLUG, checkout, env, log: (line) => logged.push(line) }), true);
  assert.deepEqual(logged, []);
});

test("a registered worktree at the job's path on a published branch no open job holds is adopted", async (t) => {
  const env = homeEnv(t, "job-worktree-foreign-published");
  const checkout = initGitRepo(makeDir(t, "job-worktree-foreign-published-repo"));
  const first = await prepare(env, checkout);
  git(["-C", first.path, "checkout", "-q", "-b", "feat/other-slug"]);

  const again = await prepare(env, checkout);

  assert.deepEqual({ ok: again.ok, path: again.path, branch: again.branch }, { ok: true, path: first.path, branch: "feat/other-slug" }, again.message);
  assert.deepEqual(recordedPlace(env), { branch: "feat/other-slug", worktree: first.path });
});

test("the job branch of a slug holding `+` never carries it", () => {
  assert.equal(jobBranchName("a+b"), "worktree-a-b");
  assert.equal(jobBranchName("fix-the-worker"), "worktree-fix-the-worker");
});
