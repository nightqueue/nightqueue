import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { defaultContext, run as runCli } from "../src/cli/index.mjs";
import { runDir, worktreesDir } from "../src/config/paths.mjs";
import { openDb } from "../src/memory/db.mjs";
import { addJob, getJob } from "../src/memory/jobs.mjs";
import { prepareJobWorktree } from "../src/queue/job-worktree.mjs";
import { readRunState } from "../src/queue/resume.mjs";
import { applyRetry } from "../src/queue/retry.mjs";
import { shellQuote } from "../src/host/shell.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../test-support/memory.mjs";
import { useFakeClaude } from "../test-support/queue-fake.mjs";
import { SLUG } from "../test-support/streams.mjs";
import { deadPid, git, gitVars, lockWorktree, makeDirty, publishedCheckout, registeredWorktrees } from "../test-support/worktrees.mjs";

const DESTRUCTIVE = /\brm\b|remove|--force/;

// A gated job of a real checkout, placed on its own worktree, with one unpushed commit.
async function placedGateJob(t, name, { homeName = null } = {}) {
  const { checkout } = publishedCheckout(t, name);
  const home = { ...makeHome(t, name), ...gitVars() };
  const env = homeName === null ? home : { ...home, NIGHTQUEUE_HOME: join(home.NIGHTQUEUE_HOME, homeName) };
  registerCheckout(env, { path: checkout, name: "alpha" });
  useFakeClaude(env, makeDir(t, `${name}-plan`), []);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'gate', slug = ?, notice_md = 'why it stopped', finished_at = datetime('now') WHERE id = ?").run(SLUG, id);
  const placed = await prepareJobWorktree({ job: { id, project_id: projectId, slug: SLUG }, checkout, baseBranch: "main", env });
  assert.equal(placed.ok, true, placed.message);
  git(["-C", placed.path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "work"]);
  return { env, id, projectId, checkout, path: placed.path, dir: runDir(projectId, SLUG, env) };
}

// Waits for the fresh retry to have taken the row, the gap the worktree can turn dirty in.
async function untilPending(id, env) {
  for (let turn = 0; turn < 200000; turn += 1) {
    if (getJob(id, env).status === "pending") return;
    await new Promise((settled) => setImmediate(settled));
  }
  assert.fail("the row never read pending");
}

// A fresh retry whose worktree turned dirty after the row was taken, so the release keeps it and its run directory.
async function keptByDirtyGap(t, name, options) {
  const job = await placedGateJob(t, name, options);
  const retried = applyRetry({ id: job.id, note: "start over", fresh: true, env: job.env });
  await untilPending(job.id, job.env);
  writeFileSync(join(job.path, "uncommitted.txt"), "work in progress\n");
  const answer = await retried;
  assert.equal(answer.worktree.status, "kept", JSON.stringify(answer.worktree));
  return { ...job, answer };
}

// Doctor's JSON report, in process, with gh stubbed and no registry call.
async function doctor(env, args = []) {
  const out = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: () => {},
    spawnSyncImpl: (file, argv, options) => {
      if (file === "gh") return { status: 0, stdout: "Logged in", stderr: "" };
      if (file === "npm") return { status: 1, stdout: "", stderr: "offline" };
      return spawnSync(file, argv, options);
    },
  };
  await runCli(["doctor", "--json", ...args], ctx);
  return JSON.parse(out[0]).checks;
}

// The row of a named check, or undefined.
function rowNamed(checks, name) {
  return checks.find((check) => check.name === name);
}
test("doctor lists a run directory kept by --fresh and its worktree, with read-only hints; the retry answer still names it", async (t) => {
  const job = await keptByDirtyGap(t, "kept-rows");
  assert.equal(job.answer.runDir.status, "kept");
  assert.equal(job.answer.runDir.dir, job.dir);

  const checks = await doctor(job.env);

  const runRow = rowNamed(checks, `run alpha/${SLUG}`);
  assert.equal(runRow.status, "warn");
  assert.ok(runRow.detail.includes(job.dir), runRow.detail);
  assert.ok(runRow.detail.includes(`J-${job.id}`), runRow.detail);
  assert.ok(runRow.detail.includes(`its worktree ${job.path} is kept`), runRow.detail);
  const worktreeRow = rowNamed(checks, `worktree alpha/${basename(job.path)}`);
  assert.equal(worktreeRow.status, "warn");
  assert.ok(worktreeRow.detail.includes("no job works in it now"), worktreeRow.detail);
  for (const row of [runRow, worktreeRow]) {
    assert.doesNotMatch(row.hint, DESTRUCTIVE, row.hint);
    const pasted = spawnSync("/bin/sh", ["-c", row.hint], { encoding: "utf8" });
    assert.equal(pasted.status, 0, `${row.hint}: ${pasted.stderr}`);
  }
  assert.equal(readFileSync(join(job.path, "uncommitted.txt"), "utf8"), "work in progress\n");
});

test("doctor --fix leaves the kept worktree, its file and the kept run directory", async (t) => {
  const job = await keptByDirtyGap(t, "kept-fix");

  await doctor(job.env, ["--fix"]);

  assert.equal(existsSync(join(job.path, "uncommitted.txt")), true);
  assert.ok(registeredWorktrees(job.checkout).some((path) => realpathSync(path) === realpathSync(job.path)));
  assert.equal(existsSync(join(job.dir, "state.json")), true);
});

test("with the worktree gone the row stops warning, and a home with no worktree directory still lists it", async (t) => {
  const job = await keptByDirtyGap(t, "kept-gone");
  git(["-C", job.checkout, "worktree", "remove", "--force", job.path]);
  rmSync(worktreesDir(job.env), { recursive: true, force: true });

  const row = rowNamed(await doctor(job.env), `run alpha/${SLUG}`);

  assert.equal(row.status, "ok");
  assert.ok(row.detail.includes(`its worktree ${job.path} is gone`), row.detail);
});

test("a fresh retry that removed everything leaves no row", async (t) => {
  const job = await placedGateJob(t, "kept-none");

  const answer = await applyRetry({ id: job.id, note: "start over", fresh: true, env: job.env });
  assert.equal(answer.runDir.status, "removed");

  assert.equal(rowNamed(await doctor(job.env), `run alpha/${SLUG}`), undefined);
});

// The worktree row of a kept run.
async function keptRow(job) {
  return rowNamed(await doctor(job.env), `worktree alpha/${basename(job.path)}`);
}

// The row of a kept worktree that is not locked, byte for byte.
function unlockedRow(job) {
  return {
    detail: `kept by \`queue retry --fresh\` of J-${job.id} with its run directory ${job.dir}: no job works in it now`,
    hint: `git -C ${shellQuote(job.path)} status --short`,
  };
}

test("a kept worktree that is not locked keeps its row byte for byte", async (t) => {
  const job = await keptByDirtyGap(t, "kept-unlocked");

  const row = await keptRow(job);

  assert.deepEqual({ detail: row.detail, hint: row.hint }, unlockedRow(job));
});

test("a kept worktree locked by hand names the lock, its hint is the unlock alone, and taking it gives the unlocked row", async (t) => {
  const job = await keptByDirtyGap(t, "kept-locked");
  git(["-C", job.checkout, "worktree", "lock", "--reason", "my own reason", job.path]);

  const row = await keptRow(job);

  assert.equal(row.status, "warn");
  assert.ok(row.detail.endsWith("no job works in it now; it is locked (my own reason)"), row.detail);
  assert.equal(row.hint, `git -C ${shellQuote(realpathSync(job.checkout))} worktree unlock ${shellQuote(job.path)}`);
  assert.doesNotMatch(row.hint, DESTRUCTIVE);

  const taken = spawnSync("/bin/sh", ["-c", row.hint], { encoding: "utf8", env: job.env });
  assert.equal(taken.status, 0, `${row.hint}: ${taken.stderr}`);
  assert.doesNotMatch(git(["-C", job.checkout, "worktree", "list", "--porcelain"]), /^locked/m);
  const after = await keptRow(job);
  assert.deepEqual({ detail: after.detail, hint: after.hint }, unlockedRow(job));
  assert.equal(readFileSync(join(job.path, "uncommitted.txt"), "utf8"), "work in progress\n");
});

test("a kept worktree under a lock whose pid is gone names that pid", async (t) => {
  const job = await keptByDirtyGap(t, "kept-stale");
  const pid = deadPid();
  lockWorktree(job.checkout, job.path, pid);

  const row = await keptRow(job);

  assert.ok(row.detail.includes(`it is locked (`), row.detail);
  assert.ok(row.detail.includes(String(pid)), row.detail);
  assert.doesNotMatch(row.hint, DESTRUCTIVE);
});

test("a kept worktree locked with no reason says so", async (t) => {
  const job = await keptByDirtyGap(t, "kept-no-reason");
  git(["-C", job.checkout, "worktree", "lock", job.path]);

  const row = await keptRow(job);

  assert.ok(row.detail.endsWith("it is locked (no reason)"), row.detail);
  assert.doesNotMatch(row.hint, DESTRUCTIVE);
});

test("the unlock hint runs on a path with a space and a quote", async (t) => {
  const job = await keptByDirtyGap(t, "kept-quoted", { homeName: "it's a home" });
  git(["-C", job.checkout, "worktree", "lock", job.path]);

  const row = await keptRow(job);
  const taken = spawnSync("/bin/sh", ["-c", row.hint], { encoding: "utf8", env: job.env });

  assert.equal(taken.status, 0, `${row.hint}: ${taken.stderr}`);
  assert.doesNotMatch(git(["-C", job.checkout, "worktree", "list", "--porcelain"]), /^locked/m);
});

test("a refused fresh retry records nothing", async (t) => {
  const job = await placedGateJob(t, "kept-refused");
  makeDirty(job.path);

  await assert.rejects(applyRetry({ id: job.id, note: "start over", fresh: true, env: job.env }), /uncommitted changes/);

  assert.equal(readRunState({ projectId: job.projectId, slug: SLUG, env: job.env }).freshRetry, undefined);
  assert.equal(rowNamed(await doctor(job.env), `run alpha/${SLUG}`), undefined);
});
