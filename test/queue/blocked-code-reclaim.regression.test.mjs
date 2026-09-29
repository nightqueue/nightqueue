import assert from "node:assert/strict";
import { test } from "node:test";
import { addJob, getJob, retryJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { doneStream, PR_URL } from "../../test-support/streams.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";

// A job the preflight blocks stops at a gate carrying `blocked_code`, so no claim takes it again by itself; once the cause
// is gone (here, the checkout is clean again) `queue retry` with no note sends it back and the next cycle runs it.
// `blocked_code` is cleared by the retry, because a job that is pending again must never still look blocked.
function fakeGit({ status = "" } = {}) {
  return ({ args }) => {
    if (args[0] === "status") return `${status}\n`;
    if (args[0] === "rev-parse") return "main\n";
    if (args[0] === "symbolic-ref") return "origin/main\n";
    throw new Error(`git ${args[0]} failed`);
  };
}

test("a job gated by a preflight failure is not reclaimed until a noteless retry, then runs once the cause clears", async (t) => {
  const env = makeHome(t, "blocked-code-reclaim");
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, "blocked-code-reclaim-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;

  const blocked = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit({ status: " M src/a.mjs" }) } });
  assert.deepEqual(blocked.processed, [{ id, status: "gated", code: "dirty-checkout" }]);
  const stuck = getJob(id, env);
  assert.deepEqual(
    { status: stuck.status, blockedCode: stuck.blocked_code, attempts: stuck.attempts, note: stuck.operator_note },
    { status: "gate", blockedCode: "dirty-checkout", attempts: 0, note: null },
  );
  assert.match(stuck.notice_md, /^dirty-checkout: /);
  assert.equal(JSON.parse(stuck.result).blocked.code, "dirty-checkout");

  const untouched = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit() } });
  assert.deepEqual({ processed: untouched.processed, reason: untouched.reason }, { processed: [], reason: "not-pending" });

  const retried = retryJob(id, {}, env);
  assert.deepEqual({ status: retried.status, blockedCode: retried.blocked_code, maxAttempts: retried.max_attempts }, { status: "pending", blockedCode: null, maxAttempts: stuck.max_attempts });

  const recovered = await runCycle({ jobId: id, env, deps: { gitImpl: fakeGit() } });
  assert.deepEqual(recovered.processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }]);
  const done = getJob(id, env);
  assert.deepEqual({ status: done.status, blockedCode: done.blocked_code }, { status: "done", blockedCode: null });
});
