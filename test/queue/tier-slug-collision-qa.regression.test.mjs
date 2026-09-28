import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, bindRunSlug, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, PR_URL } from "../../test-support/streams.mjs";

// The exact header the operator's Step 8 stamps onto a tiered job, verbatim.
const TIER_HEADER = "Tier: complex (set by the operator - the pipeline may only raise it, with evidence, never lower it)";

// The prompt shape a tiered job is queued with: the runtime header first, the brief after it.
function operatorPrompt(brief) {
  return `${TIER_HEADER}\n\n## Brief\n${brief}`;
}

// Queues one tiered job the way the operator does.
function queueTiered(env, brief) {
  return addJob({ project: "alpha", prompt: operatorPrompt(brief), tier: "complex" }, env).id;
}

// A home with the project `alpha` registered and the fake `claude` playing the given attempts in order.
function makeRunnerHome(t, name, attempts) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return env;
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// Runs one cycle over a single job with the git reads injected.
function runJobCycle(env, jobId) {
  return runCycle({ jobId, env, deps: { gitImpl: fakeGit() } });
}

test("a second tiered job left running under a dead worker, after losing the same-name race, never inherits the first job's run, its witness or its pull request", async (t) => {
  const env = makeRunnerHome(t, "tier-slug-collision-qa", [{ stdout: doneStream({ slug: "shared-run" }), exitCode: 0 }]);
  const a = queueTiered(env, "Rename the lease column of the jobs table");
  const b = queueTiered(env, "Drop the retired ship columns after the close migration");

  // A runs for real, to completion, and names its own run "shared-run" mid-run (the QUEUE_SLUG line) - the runtime's own bind, not a manual write.
  await runJobCycle(env, a);
  const rowA = getJob(a, env);
  assert.equal(rowA.slug, "shared-run", "setup: job A did not bind the run name it declared");
  assert.equal(rowA.pr_url, PR_URL, "setup: job A did not finish with its pull request recorded");
  const stateAPath = join(runDir("alpha", rowA.slug, env), "state.json");
  const bytesBefore = readFileSync(stateAPath, "utf8");

  // B is picked up by a second worker and, before it ever writes anything of its own, tries to name its run
  // after A's ("shared-run" first in its candidate list) - the exact collision this ticket exists to refuse.
  // The guarded claim (`bindRunSlug`, checked and written inside one transaction) must refuse it regardless of
  // A's status, leaving B with a run name of its own.
  claimJobById(b, { worker: "worker:dead", cap: null }, env);
  const claim = bindRunSlug(b, { worker: "worker:dead", candidates: ["shared-run", "drop-the-retired-ship-columns"] }, env);
  assert.equal(claim.status, "bound", "setup: B never bound any run name at all");
  assert.notEqual(claim.slug, "shared-run", "the guarded claim let job B take the run job A already finished with");

  // Before B ever writes its own state.json, its worker dies: the lease goes stale and no witness of its own exists.
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(b);
  assert.equal(getJob(b, env).status, "running", "setup: B is not the \"running under a dead worker\" case this test targets");

  // The repair sweep that restores a job from a witness on disk must not reach into A's run to do it.
  const outcome = await reconcileFromWitness(env);

  assert.deepEqual(outcome.repaired, [], "a job with no witness of its own was repaired from the witness of another job");
  const rowB = getJob(b, env);
  assert.notEqual(rowB.slug, rowA.slug, "job B ended up sharing the run name of job A");
  assert.notEqual(rowB.pr_url, PR_URL, "job B inherited the pull request of job A");
  assert.equal(rowB.pr_url, null, "job B was given a pull request it never opened");
  const resultB = JSON.parse(rowB.result ?? "{}");
  assert.equal(resultB.repairedFrom, undefined, "job B was silently repaired from a witness that was never its own");
  assert.equal(resultB.reclassifiedFrom, undefined, "job B was silently reclassified from evidence that was never its own");
  assert.equal(
    readFileSync(stateAPath, "utf8"),
    bytesBefore,
    "the state.json job A finished with was rewritten while a second job was being repaired",
  );
});
