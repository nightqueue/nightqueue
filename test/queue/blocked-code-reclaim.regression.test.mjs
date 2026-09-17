import assert from "node:assert/strict";
import { test } from "node:test";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { doneStream, PR_URL } from "../../test-support/streams.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";

// A pending job the preflight blocks writes `blocked_code` and is left visibly stuck; once the cause is gone
// (here, the checkout is clean again) the NEXT cycle of the drain claims it by itself, with no operator retry
// and no `queue_retry` call. `blocked_code` must be cleared the instant the claim picks it back up, because a
// job that starts running again must never still look blocked.
function fakeGit({ status = "" } = {}) {
  return ({ args }) => {
    if (args[0] === "status") return `${status}\n`;
    if (args[0] === "rev-parse") return "main\n";
    if (args[0] === "symbolic-ref") return "origin/main\n";
    throw new Error(`git ${args[0]} failed`);
  };
}

test("a job blocked by a preflight failure is reclaimed by the next drain cycle alone, once the cause clears", async (t) => {
  const env = makeHome(t, "blocked-code-reclaim");
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, "blocked-code-reclaim-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;

  const blocked = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit({ status: " M src/a.mjs" }) } });
  assert.deepEqual(blocked.processed, [{ id, status: "blocked", code: "dirty-checkout" }]);
  const stuck = getJob(id, env);
  assert.deepEqual({ status: stuck.status, blockedCode: stuck.blocked_code }, { status: "pending", blockedCode: "dirty-checkout" });

  const recovered = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit() } });
  assert.deepEqual(recovered.processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }]);
  const done = getJob(id, env);
  assert.deepEqual({ status: done.status, blockedCode: done.blocked_code }, { status: "done", blockedCode: null });
});
