import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { test } from "node:test";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { stopAndCancelJob } from "../../src/queue/cancel.mjs";
import { findRunnerRecord } from "../../src/queue/registry.mjs";
import { cliEntrypoint } from "../../src/queue/spawn.mjs";
import { openStore } from "../../src/store/open.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// H1: a DRAIN runner (no --job) holds J with K pending behind it; stop-and-cancel of J must leave K untouched.
test("stop-and-cancel of the job of a drain runner leaves the next pending job pending, unspent and never spawned", async (t) => {
  const env = makeHome(t, "stop-cancel-drain");
  registerCheckout(env, { path: initGitRepo(makeDir(t, "stop-cancel-drain-repo")), name: "alpha" });
  const planPath = useFakeClaude(env, makeDir(t, "stop-cancel-drain-plan"), [
    { stdout: '{"type":"system","subtype":"init","session_id":"sess-drain0001"}\n', holdMs: 60000, exitCode: 0 },
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
  const first = addJob({ projectId, prompt: "job J, held by the drain", timeoutS: 300 }, env).id;
  const second = addJob({ projectId, prompt: "job K, waiting behind J", timeoutS: 300 }, env).id;
  const child = spawn(process.execPath, [cliEntrypoint(), "queue", "run", "--foreground"], { env, stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  const owner = `${hostname()}:${child.pid}`;
  await waitFor(
    () => getJob(first, env)?.status === "running" && getJob(first, env)?.worker === owner && findRunnerRecord(child.pid, env)?.status === "alive",
    "J running under the drain runner",
    15000,
  );
  assert.equal(getJob(second, env).status, "pending");

  const answer = await stopAndCancelJob({ store: openStore(env), id: first, reason: "brief changed", env });
  await Promise.race([exited, sleep(20000)]);
  await sleep(1500);

  const j = getJob(first, env);
  const k = getJob(second, env);
  assert.equal(j.status, "cancelled", `J: ${j.status} (runner ${answer.runner.outcome})`);
  assert.deepEqual(
    { status: k.status, worker: k.worker, attempts: k.attempts },
    { status: "pending", worker: null, attempts: 0 },
    "K was claimed, charged or left owned by the drain runner that was being stopped",
  );
  assert.equal(fakeCalls(planPath).length, 1, "a claude was spawned for a job other than J");
});
