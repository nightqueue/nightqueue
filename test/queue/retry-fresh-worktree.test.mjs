import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { jobWorktreePath, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { cancelJobAndWorktree } from "../../src/queue/cancel.mjs";
import { prepareJobWorktree } from "../../src/queue/job-worktree.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordAdoptedWorktree, recordPhaseDone, recordPipeline, recordRunFields } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { ADOPTED_WORKTREE_REASON, releaseJobWorktree } from "../../src/queue/worktree.mjs";
import { openStore } from "../../src/store/open.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, recordedDone, SLUG } from "../../test-support/streams.mjs";
import { git, gitVars, localBranches, makeDirty, publishedCheckout, registeredWorktrees } from "../../test-support/worktrees.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const BRANCH = `worktree-${SLUG}`;

// A gated job of a real checkout, placed by the runtime on its own worktree, with one commit its branch never pushed.
async function placedGateJob(t, name, attempts = []) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'gate', slug = ?, notice_md = 'why it stopped', finished_at = datetime('now') WHERE id = ?").run(SLUG, id);
  const placed = await prepareJobWorktree({ job: { id, project_id: projectId, slug: SLUG }, checkout, baseBranch: "main", env });
  assert.equal(placed.ok, true, placed.message);
  git(["-C", placed.path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "wip(fix-the-worker): terminated at qa"]);
  const path = readRunState({ projectId, slug: SLUG, env }).worktree;
  return { env, id, projectId, checkout, planPath, path, commit: git(["-C", path, "rev-parse", "HEAD"]).trim() };
}

// The run directory of the job's first attempt.
function runDirOf(run) {
  return runDir(run.projectId, SLUG, run.env);
}

// Tells whether git still registers the worktree of the run.
function isRegistered(run) {
  return registeredWorktrees(run.checkout).some((path) => realpathSync(path) === realpathSync(run.path));
}

// Asserts that a refused retry left the row, the run directory and the worktree exactly as they were.
function assertUntouched(run, { row, state }) {
  assert.deepEqual(getJob(run.id, run.env), row, "a refused retry wrote to the job");
  assert.equal(readFileSync(join(runDirOf(run), "state.json"), "utf8"), state, "a refused retry changed the run directory");
  assert.equal(isRegistered(run), true, "a refused retry removed the worktree");
}

// What the row and the run directory hold before a retry is tried.
function snapshot(run) {
  return { row: getJob(run.id, run.env), state: readFileSync(join(runDirOf(run), "state.json"), "utf8") };
}

// An attempt that takes the slug given and records, from inside its session, the done outcome with its pull request: the stream's text alone decides nothing.
function doneAttempt(projectId, slug) {
  const stateUrl = new URL("../../src/queue/run-state.mjs", import.meta.url).href;
  const { prUrl, notice } = recordedDone().outcome;
  const script = `import(${JSON.stringify(stateUrl)}).then(async ({ recordOutcome, recordPrUrl }) => { const scope = { projectId: ${JSON.stringify(projectId)}, slug: ${JSON.stringify(slug)}, env: process.env }; recordOutcome({ ...scope, status: "done", notice: ${JSON.stringify(notice)} }); recordPrUrl({ ...scope, prUrl: ${JSON.stringify(prUrl)} }); });`;
  return { exec: ["-e", script], stdout: doneStream({ slug }), exitCode: 0 };
}

test("--fresh on a clean worktree whose branch was never pushed removes it, keeps the branch with its commit, names it, and the next claim takes a new slot", async (t) => {
  const run = await placedGateJob(t, "fresh-clean", []);

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.deepEqual(answer.worktree, { path: run.path, status: "removed" });
  assert.equal(answer.keptBranch, BRANCH);
  assert.equal(answer.runDir.status, "removed");
  assert.equal(answer.job.slug, null);
  assert.equal(existsSync(run.path), false, "the worktree stayed");
  assert.equal(git(["-C", run.checkout, "rev-parse", BRANCH]).trim(), run.commit, "the kept branch lost its commit");

  writeFileSync(run.planPath, JSON.stringify({ attempts: [doneAttempt(run.projectId, `${SLUG}-2`)] }));
  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.equal(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
  const newSlot = jobWorktreePath(run.projectId, `${SLUG}-2`, run.env);
  assert.equal(fakeCalls(run.planPath)[0].cwd, join(realpathSync(dirname(newSlot)), basename(newSlot)));
  assert.ok(localBranches(run.checkout).includes(`${BRANCH}-2`), "the new attempt has no branch of its own");
  assert.equal(git(["-C", run.checkout, "rev-parse", BRANCH]).trim(), run.commit, "the new attempt moved the kept branch");
});

test("--fresh on a dirty worktree refuses with the exact text and leaves the row, the run directory and the worktree as they were", async (t) => {
  const run = await placedGateJob(t, "fresh-dirty");
  makeDirty(run.path);
  const before = snapshot(run);

  await assert.rejects(applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }), {
    name: "UserError",
    message: `the worktree has uncommitted changes at ${run.path}; commit or stash them, or retry without --fresh`,
  });

  assertUntouched(run, before);
  assert.equal(existsSync(join(run.path, "uncommitted.txt")), true);
});

test("a run under another pipeline version with a dirty worktree refuses both retries, and committing opens the fresh one", async (t) => {
  const run = await placedGateJob(t, "fresh-version-dirty");
  const target = { projectId: run.projectId, slug: SLUG, env: run.env };
  assert.equal(recordPipeline({ ...target, pipeline: { name: "resolve", version: "0.0.0-older" } }).status, "written");
  assert.equal(recordPhaseDone({ ...target, phase: "triage" }).status, "written");
  makeDirty(run.path);
  const before = snapshot(run);

  await assert.rejects(applyRetry({ id: run.id, note: "go on", env: run.env }), { name: "UserError", message: /^this run started under resolve@0\.0\.0-older; retry with --fresh/ });
  await assert.rejects(applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }), { name: "UserError", message: /uncommitted changes/ });
  assertUntouched(run, before);

  git(["-C", run.path, "add", "-A"]);
  git(["-C", run.path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "wip: keep it"]);
  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });
  assert.equal(answer.job.status, "pending");
  assert.equal(answer.worktree.status, "removed");
  assert.equal(answer.keptBranch, BRANCH);
});

test("--fresh on a worktree another reason keeps refuses naming it and writes nothing", async (t) => {
  const run = await placedGateJob(t, "fresh-locked");
  git(["-C", run.checkout, "worktree", "lock", "--reason", "kept on purpose", run.path]);
  const before = snapshot(run);

  await assert.rejects(applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }), {
    name: "UserError",
    message: `the worktree at ${run.path} could not be released (it is locked (kept on purpose)); retry without --fresh`,
  });

  assertUntouched(run, before);
});

test("--fresh on a running job gets the running refusal and touches nothing", async (t) => {
  const run = await placedGateJob(t, "fresh-running");
  makeDirty(run.path);
  openDb(run.env).prepare("UPDATE jobs SET status = 'running', worker = 'host:1' WHERE id = ?").run(run.id);
  const before = snapshot(run);

  await assert.rejects(applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }), /is running with a live lease/);

  assertUntouched(run, before);
});

test("a --fresh the store refuses after the read-only check never removes the clean worktree", async (t) => {
  const run = await placedGateJob(t, "fresh-no-note");
  const before = snapshot(run);

  await assert.rejects(applyRetry({ id: run.id, fresh: true, env: run.env }), /waiting for a decision/);

  assertUntouched(run, before);
});

test("--fresh of a job on an adopted worktree leaves that worktree alone, dirty or not, and goes on", async (t) => {
  const run = await placedGateJob(t, "fresh-adopted");
  makeDirty(run.path);
  recordAdoptedWorktree({ projectId: run.projectId, slug: SLUG, branch: BRANCH, worktree: run.path, env: run.env });

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.deepEqual(answer.worktree, { path: run.path, status: "kept", reason: ADOPTED_WORKTREE_REASON });
  assert.equal(existsSync(join(run.path, "uncommitted.txt")), true);
  assert.equal(existsSync(runDirOf(run)), false);
  assert.equal(answer.job.status, "pending");
});

test("--fresh of a job whose worktree directory is already gone has nothing to release and still names the branch", async (t) => {
  const run = await placedGateJob(t, "fresh-gone");
  rmSync(run.path, { recursive: true, force: true });
  git(["-C", run.checkout, "worktree", "prune"]);

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.equal(answer.worktree, null);
  assert.equal(answer.keptBranch, BRANCH);
  assert.equal(answer.job.status, "pending");
  assert.ok(localBranches(run.checkout).includes(BRANCH));
});

test("a retry of a job whose gate cancel removed the worktree places it again on the kept branch with its commit", async (t) => {
  const run = await placedGateJob(t, "cancel-then-retry");
  const cancelled = await cancelJobAndWorktree({ store: openStore(run.env), id: run.id, env: run.env });
  assert.deepEqual(cancelled.worktree, { path: run.path, status: "removed" });

  const answer = await applyRetry({ id: run.id, env: run.env });
  assert.equal(answer.job.status, "pending");
  assert.equal(answer.job.slug, SLUG);

  const placed = await prepareJobWorktree({ job: { id: run.id, project_id: run.projectId, slug: SLUG }, checkout: run.checkout, baseBranch: "main", env: run.env });
  assert.equal(placed.ok, true, placed.message);
  assert.equal(realpathSync(placed.path), realpathSync(run.path));
  assert.equal(git(["-C", placed.path, "rev-parse", "HEAD"]).trim(), run.commit, "the retry did not land on the kept commit");
});

test("a retry without --fresh keeps the worktree, dirty or not, and names nothing as left behind", async (t) => {
  const run = await placedGateJob(t, "not-fresh");
  makeDirty(run.path);

  const answer = await applyRetry({ id: run.id, note: "go on", env: run.env });

  assert.equal(answer.worktree, null);
  assert.equal(answer.keptBranch, null);
  assert.equal(existsSync(join(run.path, "uncommitted.txt")), true);
  assert.equal(existsSync(runDirOf(run)), true);
});

// Commits on a detached HEAD of the run's worktree, so no branch names the commit, answering it.
function detachAndCommit(run) {
  git(["-C", run.path, "checkout", "-q", "--detach"]);
  git(["-C", run.path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "work on a detached HEAD"]);
  return git(["-C", run.path, "rev-parse", "HEAD"]).trim();
}

// Tells whether a branch, tag or reflog of the checkout still reaches the commit.
function reachable(run, commit) {
  return git(["-C", run.checkout, "rev-list", "--all", "--reflog"]).split("\n").includes(commit);
}

test("--fresh on a clean detached HEAD with a commit on no branch refuses, naming it, and writes nothing", async (t) => {
  const run = await placedGateJob(t, "fresh-detached");
  const work = detachAndCommit(run);
  const before = snapshot(run);

  await assert.rejects(applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }), {
    name: "UserError",
    message: `the worktree at ${run.path} could not be released (its detached HEAD has 1 commit(s) on no branch); retry without --fresh and the run puts its own branch on that HEAD and goes on there, or put a branch on it yourself (git -C '${run.path}' switch -c <name>) and retry --fresh, which keeps that branch`,
  });

  assertUntouched(run, before);
  assert.equal(reachable(run, work), true);
  assert.equal(git(["-C", run.path, "rev-parse", "HEAD"]).trim(), work);
});

test("--fresh on a clean detached HEAD with no commit of its own removes the worktree", async (t) => {
  const run = await placedGateJob(t, "fresh-detached-empty");
  git(["-C", run.path, "checkout", "-q", "--detach"]);

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.deepEqual(answer.worktree, { path: run.path, status: "removed" });
  assert.equal(answer.keptBranch, BRANCH);
  assert.equal(answer.runDir.status, "removed");
});

test("a detached HEAD whose commit a tag holds has nothing to lose, so --fresh removes the worktree", async (t) => {
  const run = await placedGateJob(t, "fresh-detached-tagged");
  const work = detachAndCommit(run);
  git(["-C", run.path, "tag", "keep-it"]);

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.equal(answer.worktree.status, "removed", "a commit a tag holds has nothing to lose");
  assert.equal(reachable(run, work), true);
});

test("--fresh in the middle of a rebase, whose HEAD reads as detached, keeps the rewritten commit", async (t) => {
  const run = await placedGateJob(t, "fresh-mid-rebase");
  writeFileSync(join(run.path, "branch-work.txt"), "work\n");
  git(["-C", run.path, "add", "branch-work.txt"]);
  git(["-C", run.path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "work on the branch"]);
  git(["-C", run.checkout, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "main moved"]);
  const stopped = spawnSync("git", ["-C", run.path, "-c", "commit.gpgsign=false", "rebase", "--exec", "false", "main"], { env: run.env, encoding: "utf8" });
  assert.notEqual(stopped.status, 0, "the rebase did not stop");
  const rewritten = git(["-C", run.path, "rev-parse", "HEAD"]).trim();

  await assert.rejects(applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env }), /could not be released \(its detached HEAD has \d+ commit\(s\) on no branch\)/);

  assert.equal(existsSync(run.path), true);
  assert.equal(git(["-C", run.path, "rev-parse", "HEAD"]).trim(), rewritten);
});

test("a gate cancel on a clean detached HEAD with a commit on no branch keeps the worktree and cancels", async (t) => {
  const run = await placedGateJob(t, "cancel-detached");
  const work = detachAndCommit(run);

  const cancelled = await cancelJobAndWorktree({ store: openStore(run.env), id: run.id, env: run.env });

  assert.deepEqual(cancelled.worktree, { path: run.path, status: "kept", reason: "its detached HEAD has 1 commit(s) on no branch" });
  assert.equal(getJob(run.id, run.env).status, "cancelled");
  assert.equal(reachable(run, work), true);
});

test("a gate cancel on a clean detached HEAD with no commit of its own removes the worktree", async (t) => {
  const run = await placedGateJob(t, "cancel-detached-empty");
  git(["-C", run.path, "checkout", "-q", "--detach"]);

  const cancelled = await cancelJobAndWorktree({ store: openStore(run.env), id: run.id, env: run.env });

  assert.deepEqual(cancelled.worktree, { path: run.path, status: "removed" });
});

test("a done job with a recorded pull request keeps a detached HEAD with a commit on no branch", async (t) => {
  const run = await placedGateJob(t, "done-detached");
  const work = detachAndCommit(run);
  openDb(run.env).prepare("UPDATE jobs SET status = 'done', pr_url = 'https://github.com/acme/app/pull/42' WHERE id = ?").run(run.id);

  const released = await releaseJobWorktree({ job: await openStore(run.env).jobs.getJob(run.id), env: run.env });

  assert.deepEqual(released, { path: run.path, status: "kept", reason: "its detached HEAD has 1 commit(s) on no branch" });
  assert.equal(reachable(run, work), true);
});

test("--fresh after the worktree switched to another branch names that branch, the one holding the commit, and the CLI prints it", async (t) => {
  const run = await placedGateJob(t, "fresh-switched");
  git(["-C", run.path, "switch", "-q", "-c", "other"]);
  git(["-C", run.path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "work on other"]);
  const work = git(["-C", run.path, "rev-parse", "HEAD"]).trim();

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.equal(answer.keptBranch, "other");
  assert.equal(git(["-C", run.checkout, "rev-parse", "other"]).trim(), work);

  const printedRun = await placedGateJob(t, "fresh-switched-cli");
  git(["-C", printedRun.path, "switch", "-q", "-c", "other"]);
  const printed = spawnSync(process.execPath, [CLI, "queue", "retry", String(printedRun.id), "--note", "start over", "--fresh"], { env: printedRun.env, encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.ok(printed.stdout.includes("New job from it: start_branch: other\n"), printed.stdout);
});

test("--fresh with a recorded path that is no worktree of the checkout never reads its HEAD, and names the recorded branch", async (t) => {
  const run = await placedGateJob(t, "fresh-planted");
  const planted = initGitRepo(makeDir(t, "fresh-planted-repo"));
  git(["-C", planted, "switch", "-q", "-c", "planted-branch"]);
  recordRunFields({ projectId: run.projectId, slug: SLUG, fields: { worktree: planted }, env: run.env });

  const answer = await applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });

  assert.equal(answer.keptBranch, BRANCH);
  assert.equal(answer.worktree, null);
});

test("a start branch job whose path holds another dirty worktree is told to start over, and the fresh retry places it at a new path on the queued branch", async (t) => {
  const { checkout } = publishedCheckout(t, "fresh-occupied");
  const env = { ...makeHome(t, "fresh-occupied"), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const planPath = useFakeClaude(env, makeDir(t, "fresh-occupied-plan"), [{ stdout: doneStream({ slug: `${SLUG}-2` }), exitCode: 0 }]);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ?, start_branch = 'feat/x' WHERE id = ?").run(SLUG, id);
  git(["-C", checkout, "branch", "feat/x"]);
  const occupied = jobWorktreePath(projectId, SLUG, env);
  git(["-C", checkout, "worktree", "add", "-q", "-b", "somebody-else", occupied, "main"]);
  makeDirty(occupied);

  const gated = await runCycle({ jobId: id, env });

  assert.deepEqual(gated.processed[0], { id, status: "gated", code: "worktree-failed" });
  const notice = getJob(id, env).notice_md;
  assert.match(notice, new RegExp(`Start it over: nightqueue queue retry J-${id} --fresh`));
  assert.doesNotMatch(notice, /worktree remove|rm -rf|doctor/);
  assert.equal(fakeCalls(planPath).length, 0);

  await applyRetry({ id, fresh: true, env });
  await runCycle({ jobId: id, env });

  const calls = fakeCalls(planPath);
  assert.equal(calls.length, 1, "the fresh retry never reached the agent");
  const newSlot = jobWorktreePath(projectId, `${SLUG}-2`, env);
  assert.equal(calls[0].cwd, join(realpathSync(dirname(newSlot)), basename(newSlot)));
  assert.equal(readRunState({ projectId, slug: `${SLUG}-2`, env }).branch, "feat/x");
  assert.equal(existsSync(join(occupied, "uncommitted.txt")), true, "the dirty worktree was touched");
});

// Resolves once the row reads pending, so the retry has written and is releasing the worktree.
async function untilPending(run) {
  for (let turn = 0; turn < 200000; turn += 1) {
    if (getJob(run.id, run.env).status === "pending") return true;
    await new Promise((settled) => setImmediate(settled));
  }
  return false;
}

// The path as it reads when the directory itself is gone: its real parent plus the leaf name.
function resolvedPath(path) {
  return join(realpathSync(dirname(path)), basename(path));
}

test("a claim in the gap between the row going pending and the release takes a new slot, never the worktree being removed", async (t) => {
  const run = await placedGateJob(t, "fresh-claim-gap", [{ stdout: doneStream({ slug: `${SLUG}-2` }), exitCode: 0 }]);
  const retried = applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });
  assert.equal(await untilPending(run), true);

  const [answer] = await Promise.all([retried, runCycle({ jobId: run.id, env: run.env })]);

  assert.equal(answer.worktree.status, "removed", JSON.stringify(answer.worktree));
  const calls = fakeCalls(run.planPath);
  assert.equal(calls.length, 1);
  assert.notEqual(resolvedPath(calls[0].cwd), resolvedPath(run.path));
});

test("a worktree locked in the gap after the read-only check stays, and so does the run directory that names it", async (t) => {
  const run = await placedGateJob(t, "fresh-lock-gap");
  const retried = applyRetry({ id: run.id, note: "start over", fresh: true, env: run.env });
  assert.equal(await untilPending(run), true);
  git(["-C", run.checkout, "worktree", "lock", "--reason", "kept on purpose", run.path]);

  const answer = await retried;

  assert.equal(answer.worktree.status, "kept", JSON.stringify(answer.worktree));
  assert.equal(existsSync(join(runDirOf(run), "state.json")), true, "the state of a kept worktree was deleted");
  assert.equal(answer.runDir.status, "kept");
  assert.match(answer.runDir.reason, /its worktree .* was kept/);
  assert.equal(answer.job.status, "pending");
  assert.equal(answer.job.slug, null);
});

test("queue retry --fresh prints the removed worktree and the start_branch line, and --json carries both", async (t) => {
  const plain = await placedGateJob(t, "fresh-cli");
  const printed = spawnSync(process.execPath, [CLI, "queue", "retry", String(plain.id), "--note", "start over", "--fresh"], { env: plain.env, encoding: "utf8" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.ok(printed.stdout.includes(`worktree removed: ${plain.path}\n`), printed.stdout);
  assert.ok(printed.stdout.includes(`New job from it: start_branch: ${BRANCH}\n`), printed.stdout);

  const json = await placedGateJob(t, "fresh-cli-json");
  const answered = spawnSync(process.execPath, [CLI, "queue", "retry", String(json.id), "--note", "start over", "--fresh", "--json"], { env: json.env, encoding: "utf8" });
  assert.equal(answered.status, 0, answered.stderr);
  const answer = JSON.parse(answered.stdout);
  assert.deepEqual(answer.worktree, { path: json.path, status: "removed" });
  assert.equal(answer.keptBranch, BRANCH);
});

test("queue retry --fresh on a dirty worktree exits with the refusal and writes nothing", async (t) => {
  const run = await placedGateJob(t, "fresh-cli-dirty");
  makeDirty(run.path);
  const before = snapshot(run);

  const refused = spawnSync(process.execPath, [CLI, "queue", "retry", String(run.id), "--note", "start over", "--fresh"], { env: run.env, encoding: "utf8" });

  assert.notEqual(refused.status, 0);
  assert.ok(refused.stderr.includes(`the worktree has uncommitted changes at ${run.path}; commit or stash them, or retry without --fresh`), refused.stderr);
  assertUntouched(run, before);
});
