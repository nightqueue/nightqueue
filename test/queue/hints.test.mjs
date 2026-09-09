import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, countActiveJobs, countsByStatus, LEASE_GRACE_S } from "../../src/memory/jobs.mjs";
import { isQueueIdle, pendingJobs } from "../../src/queue/hints.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const STOPPED = { running: false };
const WATCHING = { running: true };

// Expires a job's lease well past the grace window, the state a dead worker leaves behind.
function orphanLease(env, id) {
  openDb(env)
    .prepare(`UPDATE jobs SET lease_until = datetime('now', '-${LEASE_GRACE_S * 2} seconds') WHERE id = ?`)
    .run(id);
}

test("the queue is idle only when no job holds a live lease and no watcher is registered", () => {
  assert.equal(isQueueIdle({ activeJobs: 0, runner: STOPPED }), true);
  assert.equal(isQueueIdle({ activeJobs: 1, runner: STOPPED }), false, "a job under a live lease left the queue idle");
  assert.equal(isQueueIdle({ activeJobs: 0, runner: WATCHING }), false, "a live watcher left the queue idle");
  assert.equal(isQueueIdle({ activeJobs: 2, runner: WATCHING }), false);
});

test("a running job whose lease died leaves the queue idle, so the backlog still gets its nudge", (t) => {
  const env = makeHome(t, "hints-orphan-lease");
  makeProject(t, env, "alpha");
  const orphaned = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(orphaned, { worker: "host:4242", cap: 4 }, env);
  addJob({ project: "alpha", prompt: "fix the parser" }, env);

  assert.equal(isQueueIdle({ activeJobs: countActiveJobs(env), runner: STOPPED }), false, "a live lease read as idle");

  orphanLease(env, orphaned);
  assert.equal(countsByStatus(env).running, 1, "the fixture did not land the orphaned job in `running`");
  assert.equal(countActiveJobs(env), 0, "a dead lease still counted as an active job");
  assert.equal(isQueueIdle({ activeJobs: countActiveJobs(env), runner: STOPPED }), true);
  assert.equal(isQueueIdle({ activeJobs: countActiveJobs(env), runner: WATCHING }), false, "a watcher is still work");
});

test("the number of pending jobs is written in the singular for a single job", () => {
  assert.equal(pendingJobs(0), "0 pending jobs");
  assert.equal(pendingJobs(1), "1 pending job");
  assert.equal(pendingJobs(2), "2 pending jobs");
});
