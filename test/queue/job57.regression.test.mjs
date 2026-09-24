import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { STRAY_PR_PREFIX, classifyJobResult } from "../../src/queue/classify.mjs";
import { runClosePipeline } from "../../src/queue/close.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCloseDeps, openPr } from "../../test-support/close.mjs";
import { codeChangePublishedEvent, resultEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

// Job 57's real values (github.com/maykonVinicius/nightshift): the runtime QA opened its own
// scratch pull request #71 on a scratch branch of the SAME repository while job 57's own run
// was still going, and #71 got merged onto job 57 by `queue close` before this fix.
const REPO = "maykonVinicius/nightshift";
const QA_PR = "https://github.com/maykonVinicius/nightshift/pull/71";
const OWN_PR = "https://github.com/maykonVinicius/nightshift/pull/72";
const QA_BRANCH = "scratch/close-qa-20260921201325";
const RUN_BRANCH = "worktree-feat+queue-close";
const FINAL_TEXT = "Phase 7 done.";

test("job 57, scenario A: the runtime QA's own scratch pull request on another branch never replaces the run's own recorded delivery", () => {
  const publication = codeChangePublishedEvent({ url: QA_PR, repo: REPO, identifier: "71", action: "created", branch: QA_BRANCH });
  const log = toNdjson([systemInitEvent(), publication, resultEvent({ text: FINAL_TEXT })]);
  const state = { schemaVersion: 1, slug: "queue-close", type: "feature/refactor", branch: RUN_BRANCH, phases: [], outcome: { status: "done", prUrl: OWN_PR } };

  const outcome = classifyJobResult({ log, exitCode: 0, state });

  assert.equal(outcome.prUrl, OWN_PR, "job 57's own pull request (#72) must stay the recorded delivery");
  assert.equal(outcome.status, "done");
  assert.ok(
    outcome.noticeMd.endsWith(`${STRAY_PR_PREFIX}${QA_PR} on branch \`${QA_BRANCH}\`; recorded instead: ${OWN_PR}`),
    `the notice must flag the stray QA pull request: ${outcome.noticeMd}`,
  );
});

test("job 57, scenario B: closing the job's own recorded pull request never merges the QA's foreign pull request onto it", async (t) => {
  const env = makeHome(t, "job57-regression");
  const checkout = makeProject(t, env, "nightshift");
  const id = addJob({ project: "nightshift", prompt: "fix queue close follow-ups" }, env).id;
  // Job 57's row as it stood right before the incident: `pr_url` still points at the QA's
  // scratch pull request #71 (the wrong record scenario A above guards against), and the job
  // ran on its own real worktree branch.
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, notice_md = ?, branch = ? WHERE id = ?").run(QA_PR, "A", RUN_BRANCH, id);
  acquireClose(id, { worker: "close:test:57:aaaa", leaseS: 660 }, env);
  const store = openStore(env);

  // PR #71 for real: its head is the QA's scratch branch, not job 57's branch.
  const fake = fakeCloseDeps({ pr: openPr({ headRefName: QA_BRANCH }) });

  const outcome = await runClosePipeline({ store, job: getJob(id, env), worker: "close:test:57:aaaa", env, deps: fake.deps, timeoutS: 600, checkout, force: false });
  const row = getJob(id, env);

  assert.deepEqual(outcome, { status: "failed", step: "preflight", reason: "pr-not-the-job-branch", mergeSha: null, worktree: null });
  assert.equal(fake.log.merges.length, 0, "the QA's foreign pull request was merged onto job 57");
  assert.equal(row.status, "done", "the job was closed on a pull request that was never its own");
  assert.equal(row.notice_md, "A", "a Closed line was appended for a foreign pull request");
});
