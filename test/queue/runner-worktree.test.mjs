import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath } from "../../src/config/paths.mjs";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { codeChangePublishedEvent, doneStream, GATE_NOTICE, gateStream, PR_URL, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";
import { addWorktree, gitVars, localBranches, makeDirty, publishedCheckout, registeredWorktrees } from "../../test-support/worktrees.mjs";

// A git double for the preflight: a clean checkout of the default branch; the worktree calls of the runner use the real git.
function preflightGit({ args }) {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return `${answers[args[0]] ?? ""}\n`;
}

// A home whose project is a real published checkout, one job bound to the run of a real worktree, and the fake `claude` playing `stdout`.
function makeWorktreeRun(t, name, { stdout, dirty = false, rowNotice = null }) {
  const { checkout } = publishedCheckout(t, name);
  const worktree = addWorktree(checkout, `feat+${name}`);
  if (dirty) makeDirty(worktree.path);
  const env = { ...makeHome(t, name), ...gitVars() };
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path: checkout, name: "alpha" }).config, env);
  useFakeClaude(env, makeDir(t, `${name}-plan`), [{ stdout, exitCode: 0 }]);
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET slug = ?, notice_md = ? WHERE id = ?").run(SLUG, rowNotice, id);
  recordRunFields({ project: "alpha", slug: SLUG, fields: { worktree: worktree.path }, env });
  return { env, id, checkout, ...worktree };
}

// Runs the one job of the home through a real cycle.
function runJob(env, id) {
  return runCycle({ jobId: id, env, deps: { gitImpl: preflightGit } });
}

test("(a) a done run with a clean, pushed worktree removes it, keeps the branch and names nothing", async (t) => {
  const run = makeWorktreeRun(t, "rw-done-clean", { stdout: doneStream({ notice: "the pull request is open" }) });

  const cycle = await runJob(run.env, run.id);

  assert.equal(cycle.processed[0].status, "done", JSON.stringify(cycle.processed));
  assert.equal(existsSync(run.path), false, "the worktree of a clean, pushed done run is still on disk");
  assert.deepEqual(registeredWorktrees(run.checkout), [], "git still registers the removed worktree");
  assert.ok(localBranches(run.checkout).includes(run.branch), "the removal deleted the local branch");
  const row = getJob(run.id, run.env);
  assert.equal(row.notice_md, "the pull request is open");
  assert.match(readFileSync(jobLogPath(run.id, run.env), "utf8"), new RegExp(`^worktree removed: ${run.path.replaceAll("+", "\\+")}$`, "m"));
});

test("(b) a done run with a dirty worktree keeps it and names it in the notice and the job log", async (t) => {
  const run = makeWorktreeRun(t, "rw-done-dirty", { stdout: doneStream({ notice: "the pull request is open" }), dirty: true });

  await runJob(run.env, run.id);

  const line = `Worktree kept: ${run.path} - it has uncommitted changes.`;
  assert.equal(existsSync(run.path), true, "a dirty worktree was removed");
  const row = getJob(run.id, run.env);
  assert.equal(row.status, "done");
  assert.equal(row.notice_md, `the pull request is open\n\n${line}`);
  assert.ok(readFileSync(jobLogPath(run.id, run.env), "utf8").includes(line), "the kept line never reached the job log");
});

test("(c) a gate run with a clean, pushed worktree keeps it for the resume and names nothing", async (t) => {
  const run = makeWorktreeRun(t, "rw-gate-clean", { stdout: gateStream() });

  await runJob(run.env, run.id);

  const row = getJob(run.id, run.env);
  assert.equal(row.status, "gate");
  assert.equal(existsSync(run.path), true, "the worktree of a gate run was removed");
  assert.equal(row.notice_md, GATE_NOTICE, "the notice must be the gate reason alone");
  assert.equal(row.notice_md.includes("Worktree kept:"), false);
});

test("(d) a run with no notice of its own appends the kept line to the notice the row already held", async (t) => {
  const stdout = toNdjson([systemInitEvent(), slugEvent(), codeChangePublishedEvent(), resultEvent({ text: "" })]);
  const run = makeWorktreeRun(t, "rw-row-notice", { stdout, dirty: true, rowNotice: "earlier notice" });

  const cycle = await runJob(run.env, run.id);

  assert.deepEqual(cycle.processed, [{ id: run.id, status: "done", prUrl: PR_URL, attempts: 1 }]);
  assert.equal(getJob(run.id, run.env).notice_md, `earlier notice\n\nWorktree kept: ${run.path} - it has uncommitted changes.`);
  assert.equal(existsSync(run.path), true);
});
