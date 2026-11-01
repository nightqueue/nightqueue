import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { NOTHING_TO_CLOSE_LINE } from "../../src/queue/classify.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { jobDetailView } from "../../src/queue/view.mjs";
import { withReadOnlyStore } from "../../src/store/open.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { noticeText, recordedTermination, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";

const REASON = "The bug is already fixed on main; there was nothing to change.";
const NO_PR = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: noticeText(REASON) })]);

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// A home with project `alpha`, the fake `claude` replaying the given attempts, and one job of it.
function noPrHome(t, name, attempts = [{ stdout: NO_PR, exitCode: 0 }]) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  return { env, id };
}

// Records a pipeline run of the job's slug with the given outcome, dated later than the attempt.
function recordRun(env, outcome) {
  const { runId } = logPipelineRun({ projectId: projectIdOf(env, "alpha"), slug: SLUG, outcome, phases: [] }, env);
  openDb(env).prepare("UPDATE pipeline_runs SET created_at = datetime('now', '+1 hour') WHERE id = ?").run(runId);
}

test("a clean run with no pull request that recorded its termination ends cancelled with the reason and the nothing-to-close line", async (t) => {
  const { env, id } = noPrHome(t, "runner-no-commit", [{ stdout: NO_PR, runState: recordedTermination({ reason: REASON }), exitCode: 0 }]);

  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });

  assert.deepEqual(cycle.processed, [{ id, status: "cancelled", prUrl: null, attempts: 1 }]);
  const row = getJob(id, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.notice_md.startsWith(`${REASON}\n\n${NOTHING_TO_CLOSE_LINE}`), true, row.notice_md);
  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal("run_notice" in detail, false, "the nothing-to-close line made the row's notice look replaced");
  assert.equal(jobView(row).status, "cancelled");
});

test("telemetry never cancels: a no_commit or local_commit row with no termination stays failed", async (t) => {
  for (const outcome of ["no_commit", "local_commit"]) {
    const { env, id } = noPrHome(t, `runner-no-commit-${outcome}`);
    recordRun(env, outcome);
    const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });
    assert.equal(cycle.processed[0].status, "failed", outcome);
    assert.equal(String(getJob(id, env).notice_md).includes(NOTHING_TO_CLOSE_LINE), false, `${outcome}: the nothing-to-close line was written`);
  }
});

test("a terminated run is never retried, even when its log carries a transient error", async (t) => {
  const overloaded = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: noticeText(`${REASON} The API was overloaded once.`) })]);
  const attempt = { stdout: overloaded, runState: recordedTermination({ reason: REASON }), exitCode: 0 };
  const { env, id } = noPrHome(t, "runner-no-commit-transient", [attempt, attempt]);

  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });

  assert.deepEqual(cycle.processed, [{ id, status: "cancelled", prUrl: null, attempts: 1 }]);
});
