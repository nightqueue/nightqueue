import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { NOTHING_TO_CLOSE_LINE } from "../../src/queue/classify.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { jobDetailView } from "../../src/queue/view.mjs";
import { withReadOnlyStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { noticeText, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const REASON = "The bug is already fixed on main; there was nothing to change.";
const NO_PR = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: noticeText(REASON) })]);

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// A home with project `alpha`, the fake `claude` replaying the given attempts, and one job of it.
function noPrHome(t, name, attempts = [{ stdout: NO_PR, exitCode: 0 }], { maxAttempts } = {}) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const id = addJob({ project: "alpha", prompt: "fix the worker", maxAttempts }, env).id;
  return { env, id };
}

// Records a pipeline run of the job's slug with the given outcome, dated the given SQLite offset from now.
function recordRun(env, outcome, offset) {
  const { runId } = logPipelineRun({ project: "alpha", slug: SLUG, tier: "simple", outcome, phases: [] }, env);
  openDb(env).prepare(`UPDATE pipeline_runs SET created_at = datetime('now', ?) WHERE id = ?`).run(offset, runId);
}

test("a clean run with no pull request whose own telemetry says no_commit ends cancelled with the run's reason and the nothing-to-close line", async (t) => {
  const { env, id } = noPrHome(t, "runner-no-commit");
  recordRun(env, "no_commit", "+1 hour");

  const cycle = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit() } });

  assert.deepEqual(cycle.processed, [{ id, status: "cancelled", prUrl: null, attempts: 1 }]);
  const row = getJob(id, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.notice_md.startsWith(`${REASON}\n\n${NOTHING_TO_CLOSE_LINE}`), true, row.notice_md);
  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal("run_notice" in detail, false, "the nothing-to-close line made the row's notice look replaced");
  assert.equal(jobView(row).status, "cancelled");
});

test("only a no_commit row of THIS attempt cancels: an older one, local_commit and no row at all stay failed", async (t) => {
  const cases = [
    ["older", (env) => recordRun(env, "no_commit", "-1 hour")],
    ["local-commit", (env) => recordRun(env, "local_commit", "+1 hour")],
    ["no-row", () => {}],
  ];
  for (const [label, seed] of cases) {
    const { env, id } = noPrHome(t, `runner-no-commit-${label}`);
    seed(env);
    const cycle = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit() } });
    assert.equal(cycle.processed[0].status, "failed", label);
    assert.equal(String(getJob(id, env).notice_md).includes(NOTHING_TO_CLOSE_LINE), false, `${label}: the nothing-to-close line was written`);
  }
});

test("a no_commit run is never retried, even when its log carries a transient error", async (t) => {
  const overloaded = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: noticeText(`${REASON} The API was overloaded once.`) })]);
  const { env, id } = noPrHome(t, "runner-no-commit-transient", [{ stdout: overloaded, exitCode: 0 }, { stdout: overloaded, exitCode: 0 }], { maxAttempts: 2 });
  recordRun(env, "no_commit", "+1 hour");

  const cycle = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit(), sleepImpl: async () => {} } });

  assert.deepEqual(cycle.processed, [{ id, status: "cancelled", prUrl: null, attempts: 1 }]);
});
