import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { test } from "node:test";
import { configPath } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { stopAndCancelJob } from "../../src/queue/cancel.mjs";
import { findRunnerRecord } from "../../src/queue/registry.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { cliEntrypoint } from "../../src/queue/spawn.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { addWorktree, gitVars, publishedCheckout } from "../../test-support/worktrees.mjs";

// Resolves after the given milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Polls a check until it answers truthy, or fails after the timeout.
async function waitFor(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Writes the largest allowed lease heartbeat into the home's config, so the runner notices SIGTERM only at its next 20 s poll.
function useLongHeartbeat(env) {
  const cfg = existsSync(configPath(env)) ? JSON.parse(readFileSync(configPath(env), "utf8")) : {};
  cfg.queue = { ...(cfg.queue ?? {}), leaseHeartbeatS: 20 };
  writeFileSync(configPath(env), `${JSON.stringify(cfg, null, 2)}\n`);
}

// Regression of H3: a runner with a long heartbeat outlives the 10 s wait; the answer is `alive`, the job is cancelled and its worktree is left alone.
test("stop-and-cancel of a real runner with leaseHeartbeatS 20 answers alive, cancels the job and keeps its worktree", async (t) => {
  const { checkout } = publishedCheckout(t, "stop-heartbeat");
  const env = { ...makeHome(t, "stop-heartbeat"), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  useLongHeartbeat(env);
  const planPath = useFakeClaude(env, makeDir(t, "stop-heartbeat-plan"), [
    { stdout: '{"type":"system","subtype":"init","session_id":"sess-hb000001"}\n', holdMs: 60000, exitCode: 0 },
  ]);
  t.after(() => {
    for (const call of fakeCalls(planPath)) {
      try {
        process.kill(call.pid, "SIGKILL");
      } catch {
        continue;
      }
    }
  });
  const projectId = ensureProject(env, "alpha");
  const target = addJob({ projectId, prompt: "the job that must stop", timeoutS: 300 }, env).id;
  const child = spawn(process.execPath, [cliEntrypoint(), "queue", "run", "--job", String(target), "--foreground"], { env, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const owner = `${hostname()}:${child.pid}`;
  await waitFor(() => getJob(target, env)?.status === "running" && getJob(target, env)?.worker === owner && findRunnerRecord(child.pid, env)?.status === "alive", "running", 20000);
  await waitFor(() => fakeCalls(planPath).length > 0, "fake claude spawned", 20000);
  const worktree = addWorktree(checkout, "feat+stop-heartbeat");
  recordRunFields({ projectId, slug: getJob(target, env).slug, fields: { worktree: worktree.path }, env });

  const answer = await stopAndCancelJob({ store: openStore(env), id: target, reason: "brief changed", releaseWorktree: true, env });

  assert.equal(answer.runner.outcome, "alive");
  assert.equal(answer.runner.pid, child.pid);
  assert.equal(getJob(target, env).status, "cancelled");
  assert.equal(answer.worktree, null, "a worktree was released while its runner may still write in it");
  assert.ok(existsSync(worktree.path), "the worktree of a runner still alive was removed");
});
