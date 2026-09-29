import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { test } from "node:test";
import { jobLogPath, jobWorktreePath, runDir, worktreesDir } from "../../src/config/paths.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { prepareJobWorktree } from "../../src/queue/job-worktree.mjs";
import { discardRunDir, renameRunDir } from "../../src/queue/resume.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { releaseJobWorktree } from "../../src/queue/worktree.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { argValue, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, SESSION_ID, SLUG } from "../../test-support/streams.mjs";
import { addWorktree, git, gitVars, publishedCheckout, registeredWorktrees } from "../../test-support/worktrees.mjs";

const PROMPT = "fix the worker";

// A home whose project is a real published checkout that does NOT ignore `.claude/`, with the fake `claude` playing the attempts.
function makeHomeRun(t, name, attempts) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: PROMPT }, env).id;
  return { env, checkout, id, projectId: ensureProject(env, "alpha"), planPath };
}

// Adds probes to the plan of the fake `claude`, which it answers in the record of each call.
function addProbes(planPath, probes) {
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  writeFileSync(planPath, JSON.stringify({ ...plan, ...probes }));
}

// The real path of a directory that may already be removed, resolved through its parent.
function realOf(path) {
  return join(realpathSync(dirname(path)), basename(path));
}

// The local exclude file of a checkout, byte for byte.
function excludeOf(checkout) {
  return readFileSync(join(checkout, ".git", "info", "exclude"));
}

// Turns on the session resume, so a test can see whether the runner hands `--resume` to the child.
function enableResume(env) {
  const config = loadConfig(env, { warn: () => {} });
  saveConfig({ ...config, queue: { ...config.queue, resumeSession: true } }, env);
}

// Binds the job to its run and its recorded session, the shape of a job whose earlier attempt stopped.
function bindRun(env, id, { worktree, branch }) {
  openDb(env).prepare("UPDATE jobs SET slug = ?, session_id = ? WHERE id = ?").run(SLUG, SESSION_ID, id);
  recordRunFields({ projectId: ensureProject(env, "alpha"), slug: SLUG, fields: { worktree, branch }, env });
}

test("a job runs in its own worktree under the home: the checkout stays clean before, during and after, and nothing is written into its .git/info/exclude", async (t) => {
  const run = makeHomeRun(t, "home-wt-run", [{ stdout: doneStream(), exitCode: 0, commitFile: "feature.txt" }]);
  addProbes(run.planPath, { probeStatusOf: run.checkout, probePath: join(runDir(run.projectId, SLUG, run.env), "state.json") });
  const excludeBefore = excludeOf(run.checkout);
  assert.equal(git(["-C", run.checkout, "status", "--porcelain"]), "");

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.equal(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
  const [call] = fakeCalls(run.planPath);
  const expected = jobWorktreePath(run.projectId, SLUG, run.env);
  assert.equal(call.cwd, realOf(expected), "the child did not run in the job's worktree under the home");
  assert.ok(call.cwd.startsWith(realpathSync(worktreesDir(run.env)) + sep));
  assert.equal(call.probedStatus, "", "the canonical checkout was dirty while the child ran");
  assert.equal(call.probeExisted, true, "the state.json naming the worktree did not exist before the spawn");
  assert.equal(git(["-C", run.checkout, "status", "--porcelain"]), "", "the canonical checkout is dirty after the run");
  assert.deepEqual(excludeOf(run.checkout), excludeBefore, "nightqueue wrote into .git/info/exclude");
  assert.equal(getJob(run.id, run.env).branch, `worktree-${SLUG}`);
  assert.match(git(["-C", run.checkout, "log", "-1", "--format=%s", `worktree-${SLUG}`]), /^feat: add feature\.txt/, "the child's commit is not on the job's branch");
  assert.match(readFileSync(jobLogPath(run.id, run.env), "utf8"), new RegExp(`^worktree removed: ${expected}$`, "m"), "finalize did not release the worktree from the checkout");
  assert.deepEqual(registeredWorktrees(run.checkout), []);
});

test("a job whose state names a legacy `.claude/worktrees/` worktree runs in it, and without the session recorded in another directory", async (t) => {
  const run = makeHomeRun(t, "home-wt-legacy", [{ stdout: doneStream(), exitCode: 0 }]);
  const legacy = addWorktree(run.checkout, "fix+legacy");
  bindRun(run.env, run.id, { worktree: legacy.path, branch: legacy.branch });
  enableResume(run.env);

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.equal(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
  const [call] = fakeCalls(run.planPath);
  assert.equal(call.cwd, realOf(legacy.path));
  assert.equal(call.argv.includes("--resume"), false, "a session recorded in the checkout was resumed from the legacy worktree");
  assert.equal(getJob(run.id, run.env).session_id, SESSION_ID, "the first session of the job was overwritten");
});

test("another job of the project is not gated by the legacy worktree an open job still names", async (t) => {
  const run = makeHomeRun(t, "home-wt-legacy-other", [{ stdout: doneStream(), exitCode: 0 }]);
  const legacy = addWorktree(run.checkout, "fix+legacy");
  const owner = addJob({ projectId: run.projectId, prompt: "the legacy job" }, run.env).id;
  openDb(run.env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run("legacy-run", owner);
  recordRunFields({ projectId: run.projectId, slug: "legacy-run", fields: { worktree: legacy.path, branch: legacy.branch }, env: run.env });

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.equal(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
});

test("a job whose home worktree is reused keeps resuming its recorded session", async (t) => {
  const run = makeHomeRun(t, "home-wt-resume", [{ stdout: doneStream(), exitCode: 0 }]);
  const path = jobWorktreePath(run.projectId, SLUG, run.env);
  git(["-C", run.checkout, "worktree", "add", "-q", "--no-track", "-b", `worktree-${SLUG}`, path, "main"]);
  bindRun(run.env, run.id, { worktree: path, branch: `worktree-${SLUG}` });
  enableResume(run.env);

  await runCycle({ jobId: run.id, env: run.env });

  const [call] = fakeCalls(run.planPath);
  assert.equal(call.cwd, realOf(path));
  assert.equal(argValue(call.argv, "--resume"), SESSION_ID);
});

test("a job whose worktree cannot be placed gates with worktree-failed, the message in its result, and spawns nothing", async (t) => {
  const run = makeHomeRun(t, "home-wt-gate", [{ stdout: doneStream(), exitCode: 0 }]);
  openDb(run.env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, run.id);
  git(["-C", run.checkout, "branch", `worktree-${SLUG}`]);

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.deepEqual(cycle.processed, [{ id: run.id, status: "gated", code: "worktree-failed" }]);
  const row = getJob(run.id, run.env);
  assert.equal(row.status, "gate");
  assert.match(row.notice_md, /^worktree-failed: the branch `worktree-fix-the-worker` already exists/);
  assert.deepEqual(fakeCalls(run.planPath), [], "the child was spawned without a worktree");
});

test("an interactive worktree in the checkout that no open job names gates the job as dirty-checkout, naming it, and spawns nothing", async (t) => {
  const run = makeHomeRun(t, "home-wt-interactive", [{ stdout: doneStream(), exitCode: 0 }]);
  addWorktree(run.checkout, "fix+interactive");

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.deepEqual(cycle.processed, [{ id: run.id, status: "gated", code: "dirty-checkout" }]);
  const row = getJob(run.id, run.env);
  assert.equal(row.blocked_code, "dirty-checkout");
  assert.match(row.notice_md, /\.claude\/worktrees\/fix\+interactive\/ is a linked worktree of this repository that no open job owns/);
  assert.deepEqual(fakeCalls(run.planPath), []);
});

// The worktree the runtime places a slug in, created for another job the way the preparer does, with its run renamed afterwards when asked.
async function occupySlot(run, { renameTo = null } = {}) {
  const other = addJob({ projectId: run.projectId, prompt: "another job" }, run.env).id;
  openDb(run.env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, other);
  const prepared = await prepareJobWorktree({ job: { id: other, project_id: run.projectId, slug: SLUG }, checkout: run.checkout, baseBranch: "main", env: run.env });
  assert.equal(prepared.ok, true, prepared.message);
  if (renameTo) {
    assert.equal(renameRunDir({ projectId: run.projectId, from: SLUG, to: renameTo, env: run.env }).status, "renamed");
    openDb(run.env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(renameTo, other);
  }
  return prepared.path;
}

test("a provisional slug another job renamed away from is not bound while its worktree lives: the job takes the next variant", async (t) => {
  const run = makeHomeRun(t, "home-wt-slot-renamed", [{ stdout: doneStream({ slug: `${SLUG}-2` }), exitCode: 0 }]);
  const kept = await occupySlot(run, { renameTo: "login-page" });

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.equal(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
  const [call] = fakeCalls(run.planPath);
  assert.equal(call.cwd, realOf(jobWorktreePath(run.projectId, `${SLUG}-2`, run.env)));
  assert.equal(getJob(run.id, run.env).slug, `${SLUG}-2`);
  assert.ok(registeredWorktrees(run.checkout).some((path) => realOf(path) === realOf(kept)), "the other job's worktree was touched");
});

test("after `retry --fresh` the rebound run never lands on the worktree its earlier run kept, and that worktree stays", async (t) => {
  const run = makeHomeRun(t, "home-wt-slot-fresh", [{ stdout: doneStream({ slug: `${SLUG}-2` }), exitCode: 0 }]);
  openDb(run.env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, run.id);
  const first = await prepareJobWorktree({ job: { id: run.id, project_id: run.projectId, slug: SLUG }, checkout: run.checkout, baseBranch: "main", env: run.env });
  assert.equal(first.ok, true, first.message);
  openDb(run.env).prepare("UPDATE jobs SET slug = NULL WHERE id = ?").run(run.id);
  discardRunDir({ projectId: run.projectId, slug: SLUG, env: run.env });

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.equal(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
  assert.equal(fakeCalls(run.planPath)[0].cwd, realOf(jobWorktreePath(run.projectId, `${SLUG}-2`, run.env)));
  assert.equal(existsSync(first.path), true, "the kept worktree was removed");
});

test("a slug whose `worktree-<slug>` branch alone is still alive is skipped at claim time", async (t) => {
  const run = makeHomeRun(t, "home-wt-slot-branch", [{ stdout: doneStream({ slug: `${SLUG}-2` }), exitCode: 0 }]);
  git(["-C", run.checkout, "branch", `worktree-${SLUG}`]);

  const cycle = await runCycle({ jobId: run.id, env: run.env });

  assert.equal(cycle.processed[0]?.status, "done", JSON.stringify(cycle.processed));
  assert.equal(fakeCalls(run.planPath)[0].cwd, realOf(jobWorktreePath(run.projectId, `${SLUG}-2`, run.env)));
  assert.match(readFileSync(jobLogPath(run.id, run.env), "utf8"), /the worktree slot of `fix-the-worker` is taken/);
});

test("a closed job whose recorded legacy worktree is gone releases nothing and never blocks, while a live clean one is removed", async (t) => {
  const run = makeHomeRun(t, "home-wt-release", [{ stdout: doneStream(), exitCode: 0 }]);
  const stale = addWorktree(run.checkout, "fix+stale");
  bindRun(run.env, run.id, { worktree: stale.path, branch: stale.branch });
  rmSync(stale.path, { recursive: true, force: true });
  const job = { ...getJob(run.id, run.env), project: "alpha", pr_url: "https://github.com/acme/api/pull/42" };

  assert.equal(await releaseJobWorktree({ job, env: run.env }), null, "a stale legacy path blocked the release");

  const live = addWorktree(run.checkout, "fix+live");
  recordRunFields({ projectId: run.projectId, slug: SLUG, fields: { worktree: live.path }, env: run.env });
  assert.deepEqual(await releaseJobWorktree({ job, env: run.env }), { path: live.path, status: "removed" });
  assert.equal(registeredWorktrees(run.checkout).some((path) => path.endsWith("fix+live")), false);
});
