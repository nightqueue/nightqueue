import assert from "node:assert/strict";
import { existsSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { jobWorktreePath } from "../../src/config/paths.mjs";
import { runGitAsync } from "../../src/host/git.mjs";
import { prepareJobWorktree, WORKTREE_FAILED } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { git, gitVars, localBranches, registeredWorktrees } from "../../test-support/worktrees.mjs";

const SLUG = "start-the-work";

// A fresh home and repository for one placement, with `feat/x` carrying one commit of its own unless asked otherwise.
function fixture(t, name, { featBranch = true } = {}) {
  const place = { env: { ...makeHome(t, name), ...gitVars() }, checkout: initGitRepo(makeDir(t, `${name}-repo`)) };
  if (!featBranch) return place;
  git(["-C", place.checkout, "checkout", "-q", "-b", "feat/x"]);
  git(["-C", place.checkout, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "work on feat/x"]);
  git(["-C", place.checkout, "checkout", "-q", "main"]);
  return place;
}

// The placement of a job queued on a start branch, with the holds of the other open jobs given and its log lines answered.
async function prepare({ env, checkout }, { startBranch = null, holds = [], gitImpl = runGitAsync } = {}) {
  const job = { id: 7, project_id: FIXED_PROJECT_ID, slug: SLUG, start_branch: startBranch, start_worktree: null };
  const logged = [];
  const placed = await prepareJobWorktree({ job, checkout, baseBranch: "main", env, gitImpl, log: (line) => logged.push(line), openHolds: async () => holds });
  return { ...placed, logged };
}

// The hold of job 1 on a branch, and on a worktree when one is given.
function holdOfJobOne(branch, worktree = null) {
  return { jobId: 1, projectId: FIXED_PROJECT_ID, slug: "other-run", type: null, branch, worktree };
}

// The state's branch of the run.
function recordedBranch(env) {
  return readRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env })?.branch ?? null;
}

// The ref git lists a worktree on, from `git worktree list --porcelain`.
function listedRef(checkout, path) {
  const blocks = git(["-C", checkout, "worktree", "list", "--porcelain"]).split("\n\n");
  const block = blocks.find((text) => text.startsWith(`worktree ${realpathSync(path)}\n`));
  return /^branch (.+)$/m.exec(block ?? "")?.[1] ?? null;
}

// The commit a ref names in a repository.
function sha(repo, ref = "HEAD") {
  return git(["-C", repo, "rev-parse", ref]).trim();
}

// A linked worktree on `feat/x` outside the home, answering its path.
function linkedOnFeat(t, place, name) {
  const path = join(makeDir(t, `${name}-linked`), "wt");
  git(["-C", place.checkout, "worktree", "add", "-q", path, "feat/x"]);
  return path;
}

test("a start branch that is the default branch under another case is refused, naming it, with no git call past the list", async (t) => {
  const place = fixture(t, "case-main");
  const before = sha(place.checkout, "main");
  const calls = [];
  const gitImpl = (call) => {
    calls.push(call.args.slice(0, 2).join(" "));
    return runGitAsync(call);
  };

  const refused = await prepare(place, { startBranch: "MAIN", gitImpl });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.equal(refused.message, "`MAIN` is the default branch (`main`, under another case); a job never works on it");
  assert.deepEqual(calls, ["worktree list"]);
  assert.deepEqual(registeredWorktrees(place.checkout), []);
  assert.equal(existsSync(jobWorktreePath(FIXED_PROJECT_ID, SLUG, place.env)), false);
  assert.equal(sha(place.checkout, "main"), before);
});

test("a start branch that is the main checkout's under another case is refused, naming it", async (t) => {
  const place = fixture(t, "case-develop");
  git(["-C", place.checkout, "checkout", "-q", "-b", "develop"]);

  const refused = await prepare(place, { startBranch: "DEVELOP" });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.equal(refused.message, "`DEVELOP` is the main checkout's branch (`develop`, under another case); a job never works on it");
});

test("the exact spelling of a protected branch keeps its refusal byte for byte", async (t) => {
  const place = fixture(t, "case-exact");

  assert.equal((await prepare(place, { startBranch: "main" })).message, "`main` is the default branch; a job never works on it");

  git(["-C", place.checkout, "checkout", "-q", "-b", "develop"]);
  assert.equal((await prepare(place, { startBranch: "develop" })).message, "`develop` is the main checkout's branch; a job never works on it");
});

test("a branch another open job holds with its worktree is refused under another case, and no second worktree takes it", async (t) => {
  const place = fixture(t, "case-held-worktree");
  const path = linkedOnFeat(t, place, "case-held-worktree");

  const refused = await prepare(place, { startBranch: "FEAT/X", holds: [holdOfJobOne("feat/x", path)] });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /J-1\b/);
  assert.equal(registeredWorktrees(place.checkout).length, 1);
  assert.equal(recordedBranch(place.env), null);
});

test("a branch another open job holds with no worktree is refused under another case", async (t) => {
  const place = fixture(t, "case-held-branch");

  const refused = await prepare(place, { startBranch: "FEAT/X", holds: [holdOfJobOne("feat/x")] });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /J-1\b/);
  assert.deepEqual(registeredWorktrees(place.checkout), []);
});

test("an unheld linked worktree on the branch under another case is where the job starts, under git's spelling, with no second worktree", async (t) => {
  const place = fixture(t, "case-entry");
  const path = linkedOnFeat(t, place, "case-entry");

  const placed = await prepare(place, { startBranch: "FEAT/X" });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(realpathSync(placed.path), realpathSync(path));
  assert.equal(placed.branch, "feat/x");
  assert.equal(recordedBranch(place.env), "feat/x");
  assert.equal(registeredWorktrees(place.checkout).length, 1);
});

test("a registration whose directory is gone stops no re-add under another case: it is pruned and the job is placed", async (t) => {
  const place = fixture(t, "case-prunable");
  const path = linkedOnFeat(t, place, "case-prunable");
  rmSync(dirname(path), { recursive: true, force: true });

  const placed = await prepare(place, { startBranch: "FEAT/X" });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(listedRef(place.checkout, placed.path), "refs/heads/feat/x");
  assert.equal(registeredWorktrees(place.checkout).length, 1);
});

test("a rung another open job holds under another case is skipped", async (t) => {
  const place = fixture(t, "case-rung");
  git(["-C", place.checkout, "branch", `worktree-${SLUG}`]);

  const placed = await prepare(place, { holds: [holdOfJobOne(`WORKTREE-${SLUG.toUpperCase()}-2`)] });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.branch, `worktree-${SLUG}-3`);
});

test("a lone job queued on another spelling works under the name git lists, and packed refs keep its history", async (t) => {
  const place = fixture(t, "case-spelling");
  const before = sha(place.checkout, "feat/x");

  const placed = await prepare(place, { startBranch: "FEAT/X" });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(listedRef(place.checkout, placed.path), "refs/heads/feat/x");
  assert.equal(placed.branch, "feat/x");
  assert.equal(recordedBranch(place.env), "feat/x");
  assert.deepEqual(placed.logged.filter((line) => line.includes("`FEAT/X`") && line.includes("`feat/x`")), ["the job was queued on `FEAT/X` and git names that branch `feat/x`: the run takes `feat/x`"]);

  git(["-C", place.checkout, "pack-refs", "--all"]);
  assert.equal(sha(placed.path), before, "the packed ref left the worktree on an unborn HEAD");
  git(["-C", placed.path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "the run's commit"]);
  assert.equal(sha(place.checkout, "feat/x"), sha(placed.path));
  assert.equal(sha(placed.path, "HEAD~1"), before, "the run's commit started an unrelated history");
});

test("a job placed again under its queued spelling reads no drift", async (t) => {
  const place = fixture(t, "case-no-drift");
  assert.equal((await prepare(place, { startBranch: "FEAT/X" })).ok, true);

  const again = await prepare(place, { startBranch: "FEAT/X" });

  assert.equal(again.ok, true, again.message);
  assert.deepEqual(again.logged.filter((line) => line.includes("now holds")), []);
});

test("a for-each-ref git cannot answer places the job as asked, and says so in its log", async (t) => {
  const place = fixture(t, "case-list-fails");
  const gitImpl = (call) => (call.args[0] === "for-each-ref" ? Promise.resolve({ ok: false, stdout: "", stderr: "fatal: odd", exitCode: 128 }) : runGitAsync(call));

  const placed = await prepare(place, { startBranch: "feat/x", gitImpl });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.branch, "feat/x");
  assert.deepEqual(placed.logged.filter((line) => line.includes("for-each-ref")), ["git for-each-ref failed (fatal: odd); the branch is taken as queued, `feat/x`"]);
});

test("a repository holding both spellings starts on the one asked", async (t) => {
  const place = fixture(t, "case-both");
  const gitImpl = (call) => (call.args[0] === "for-each-ref" ? Promise.resolve({ ok: true, stdout: "refs/heads/FEAT/X\nrefs/heads/feat/x\n", stderr: "", exitCode: 0 }) : runGitAsync(call));

  const placed = await prepare(place, { startBranch: "feat/x", gitImpl });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.branch, "feat/x");
  assert.deepEqual(placed.logged.filter((line) => line.includes("git names that branch")), []);
});

// Answers git's branch listing with the names given; every other call is the real git.
function listing(names) {
  const stdout = `${names.map((name) => `refs/heads/${name}`).join("\n")}\n`;
  return (call) => (call.args[0] === "for-each-ref" ? Promise.resolve({ ok: true, stdout, stderr: "", exitCode: 0 }) : runGitAsync(call));
}

// Makes `FEAT/X` a ref git resolves on any filesystem: a branch of its own when case is kept, the same file as `feat/x` when it folds.
function addUpperSpelling(place) {
  git(["-C", place.checkout, "update-ref", "refs/heads/FEAT/X", sha(place.checkout, "feat/x")]);
}

// A linked worktree on `FEAT/X` outside the home, answering its path.
function linkedOnUpper(t, place, name) {
  const path = join(makeDir(t, `${name}-upper`), "wt");
  git(["-C", place.checkout, "worktree", "add", "-q", path, "FEAT/X"]);
  return path;
}

const BOTH_SPELLINGS = ["FEAT/X", "feat/x"];

test("a job queued on a spelling git lists with no worktree starts there, not in the worktree of the other spelling", async (t) => {
  const place = fixture(t, "case-exact-no-entry");
  const other = linkedOnFeat(t, place, "case-exact-no-entry");
  addUpperSpelling(place);

  const placed = await prepare(place, { startBranch: "FEAT/X", gitImpl: listing(BOTH_SPELLINGS) });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.branch, "FEAT/X");
  assert.equal(recordedBranch(place.env), "FEAT/X");
  assert.notEqual(realpathSync(placed.path), realpathSync(other));
  assert.equal(listedRef(place.checkout, placed.path), "refs/heads/FEAT/X");
  assert.equal(listedRef(place.checkout, other), "refs/heads/feat/x");
});

for (const asked of BOTH_SPELLINGS) {
  test(`with a worktree on each spelling, a job queued on ${asked} starts in the one holding it byte for byte`, async (t) => {
    const name = `case-exact-entry-${asked === "feat/x" ? "lower" : "upper"}`;
    const place = fixture(t, name);
    const lower = linkedOnFeat(t, place, name);
    addUpperSpelling(place);
    const upper = linkedOnUpper(t, place, name);

    const placed = await prepare(place, { startBranch: asked });

    assert.equal(placed.ok, true, placed.message);
    assert.equal(placed.branch, asked);
    assert.equal(realpathSync(placed.path), realpathSync(asked === "feat/x" ? lower : upper));
    assert.equal(registeredWorktrees(place.checkout).length, 2);
  });
}

test("with both spellings listed, a branch another open job holds under the other one is still refused, naming the owner", async (t) => {
  const place = fixture(t, "case-both-held");
  const path = linkedOnFeat(t, place, "case-both-held");
  addUpperSpelling(place);

  const refused = await prepare(place, { startBranch: "FEAT/X", holds: [holdOfJobOne("feat/x", path)], gitImpl: listing(BOTH_SPELLINGS) });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.match(refused.message, /J-1\b/);
  assert.equal(registeredWorktrees(place.checkout).length, 1);
  assert.equal(recordedBranch(place.env), null);
});

test("a worktree on a spelling git does not list still holds the branch, and no second worktree takes it", async (t) => {
  const place = fixture(t, "case-unlisted-entry");
  addUpperSpelling(place);
  const path = linkedOnUpper(t, place, "case-unlisted-entry");

  const placed = await prepare(place, { startBranch: "feat/x", gitImpl: listing(["feat/x"]) });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(realpathSync(placed.path), realpathSync(path));
  assert.equal(registeredWorktrees(place.checkout).length, 1);
});

test("a for-each-ref git cannot answer leaves the job in the worktree of the other spelling, and says so in its log", async (t) => {
  const place = fixture(t, "case-entry-list-fails");
  const path = linkedOnFeat(t, place, "case-entry-list-fails");
  const gitImpl = (call) => (call.args[0] === "for-each-ref" ? Promise.resolve({ ok: false, stdout: "", stderr: "fatal: odd", exitCode: 128 }) : runGitAsync(call));

  const placed = await prepare(place, { startBranch: "FEAT/X", gitImpl });

  assert.equal(placed.ok, true, placed.message);
  assert.equal(realpathSync(placed.path), realpathSync(path));
  assert.equal(placed.branch, "feat/x");
  assert.deepEqual(placed.logged.filter((line) => line.includes("for-each-ref")), [`git for-each-ref failed (fatal: odd); the worktree ${placed.path} is taken as the one holding \`FEAT/X\``]);
});

test("a branch that exists under no spelling, nor on origin, is refused naming what was asked", async (t) => {
  const place = fixture(t, "case-nowhere", { featBranch: false });

  const refused = await prepare(place, { startBranch: "FEAT/Y" });

  assert.equal(refused.code, WORKTREE_FAILED);
  assert.ok(refused.message.startsWith("the branch `FEAT/Y` does not exist"), refused.message);
  assert.deepEqual(localBranches(place.checkout), ["main"]);
});
