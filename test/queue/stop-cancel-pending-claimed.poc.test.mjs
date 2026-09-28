import assert from "node:assert/strict";
import { hostname } from "node:os";
import { test } from "node:test";
import { runnerRegistryPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { stopAndCancelJob } from "../../src/queue/cancel.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

const OWNER_PID = 4242;
const FAST_STOP = { sleepImpl: async () => {}, pollMs: 1, timeoutMs: 5 };

function fakeKill(alive) {
  const live = new Set(alive);
  const terms = [];
  const kill = (pid, signal) => {
    if (!live.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
    if (signal === "SIGTERM") {
      terms.push(pid);
      live.delete(pid);
    }
    return true;
  };
  return { kill, terms };
}

test("H2: a pending job claimed between the read and the cancel is stopped-and-cancelled, not refused with the live-lease text", async (t) => {
  const { checkout } = publishedCheckout(t, "stop-cancel-pending-claimed");
  const env = { ...makeHome(t, "stop-cancel-pending-claimed"), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  const store = openStore(env);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "a pending job" }, env).id;
  writeRunnerRecord({ pid: OWNER_PID, startedAt: "2026-09-28T10:00:00.000Z", mode: "job" }, env);
  assert.ok(runnerRegistryPath(OWNER_PID, env));
  const kill = fakeKill([OWNER_PID]);

  // The runner claims the job right after stopAndCancelJob read it as pending.
  let claimed = false;
  const getJob = async (jobId) => {
    const row = await store.jobs.getJob(jobId);
    if (!claimed) {
      claimed = true;
      openDb(env)
        .prepare("UPDATE jobs SET status = 'running', worker = ?, attempts = 1, lease_until = datetime('now', '+1 hour') WHERE id = ?")
        .run(`${hostname()}:${OWNER_PID}`, jobId);
    }
    return row;
  };
  const racing = { ...store, jobs: { ...store.jobs, getJob } };

  const answer = await stopAndCancelJob({ store: racing, id, env, killImpl: kill.kill, ...FAST_STOP });

  assert.equal(answer.job.status, "cancelled");
  assert.equal(answer.runner?.outcome, "stopped");
  assert.deepEqual(kill.terms, [OWNER_PID]);
});
