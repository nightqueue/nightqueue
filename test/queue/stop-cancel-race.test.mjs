import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runnerRegistryPath } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { stopAndCancelJob } from "../../src/queue/cancel.mjs";
import { findRunnerRecord } from "../../src/queue/registry.mjs";
import { cliEntrypoint } from "../../src/queue/spawn.mjs";
import { openStore } from "../../src/store/open.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";

const HAMMER = fileURLToPath(new URL("../../test-support/claim-hammer.mjs", import.meta.url));
const HAMMERS = 2;
const RUNNING_TIMEOUT_MS = 15000;
const CANARY_TIMEOUT_MS = 10000;
const EXIT_TIMEOUT_MS = 15000;
const AFTER_CANCEL_MS = 1000;
// The runner is signalled right after the cancel, but it may see the row it lost and exit first: every outcome of a runner confirmed gone counts.
const RUNNER_GONE = ["stopped", "stale", "absent"];

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Polls a condition until it holds, throwing with the label once the deadline passes.
async function waitFor(check, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

// Starts a child process whose exit is kept as a promise, and kills it when the test ends whatever happened.
function startChild(t, args, env) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stderr }));
  });
  t.after(() => child.kill("SIGKILL"));
  return { child, exited };
}

// Waits for a child to exit, throwing when it is still there after the timeout.
async function exitWithin(started, label, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not exit within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    return await Promise.race([started.exited, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Every claim a hammer recorded, from all of its out files.
function hammerClaims(outPaths) {
  return outPaths.flatMap((path) =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line))
      : [],
  );
}

// Kills the fake `claude` children the runner started, so none of them outlives the test.
function killFakeChildren(t, planPath) {
  t.after(() => {
    for (const call of fakeCalls(planPath)) {
      try {
        process.kill(call.pid, "SIGKILL");
      } catch {
        continue;
      }
    }
  });
}

// A home with one real git project `alpha`, a fake `claude` that holds its attempt for a minute, a target job and a canary job.
function raceHome(t) {
  const env = makeHome(t, "stop-cancel-race");
  registerCheckout(env, { path: initGitRepo(makeDir(t, "stop-cancel-race-repo")), name: "alpha" });
  const planPath = useFakeClaude(env, makeDir(t, "stop-cancel-race-plan"), [
    { stdout: '{"type":"system","subtype":"init","session_id":"sess-race0001"}\n', holdMs: 60000, exitCode: 0 },
  ]);
  killFakeChildren(t, planPath);
  const projectId = ensureProject(env, "alpha");
  const target = addJob({ projectId, prompt: "the job that must stop", timeoutS: 300 }, env).id;
  const canary = addJob({ projectId, prompt: "the canary the hammers must be able to claim", timeoutS: 300 }, env).id;
  return { env, target, canary };
}

// Starts the claim hammers over the target and the canary, each with its own out file and one shared stop file.
function startHammers(t, env, { target, canary }) {
  const dir = makeDir(t, "stop-cancel-race-hammers");
  const stopPath = join(dir, "stop");
  const outPaths = Array.from({ length: HAMMERS }, (_, index) => join(dir, `hammer-${index + 1}.jsonl`));
  const hammers = outPaths.map((outPath, index) => startChild(t, [HAMMER, `hammer-${index + 1}`, String(target), String(canary), outPath, stopPath], env));
  return { hammers, outPaths, stopPath };
}

// The claims only ever take `pending` rows, and a stop-and-cancel moves the job from `running` straight to `cancelled`:
// the job never passes through `pending`, so no claimer racing the stop can take it. That is the property this test pins.
test("a stop-and-cancel of a job held by a real runner wins over real processes claiming it the whole time", async (t) => {
  const { env, target, canary } = raceHome(t);
  const runner = startChild(t, [cliEntrypoint(), "queue", "run", "--job", String(target), "--foreground"], env);
  const runnerPid = runner.child.pid;
  const owner = `${hostname()}:${runnerPid}`;
  await waitFor(
    () => getJob(target, env)?.status === "running" && getJob(target, env)?.worker === owner && findRunnerRecord(runnerPid, env)?.status === "alive",
    `job #${target} running under ${owner} with a live registration`,
    RUNNING_TIMEOUT_MS,
  );

  const { hammers, outPaths, stopPath } = startHammers(t, env, { target, canary });
  await waitFor(() => hammerClaims(outPaths).some((claim) => claim.id === canary), "a hammer to claim the canary", CANARY_TIMEOUT_MS);

  const answer = await stopAndCancelJob({ store: openStore(env), id: target, reason: "brief changed", env });

  await sleep(AFTER_CANCEL_MS);
  writeFileSync(stopPath, "stop\n");
  for (const [index, hammer] of hammers.entries()) {
    const exit = await exitWithin(hammer, `hammer ${index + 1}`, EXIT_TIMEOUT_MS);
    assert.equal(exit.code, 0, `hammer ${index + 1} failed: ${exit.stderr}`);
  }
  await exitWithin(runner, "the runner", EXIT_TIMEOUT_MS);

  assert.ok(RUNNER_GONE.includes(answer.runner.outcome), `the runner was not confirmed gone: ${answer.runner.outcome} - ${answer.runner.message}`);
  assert.equal(answer.runner.pid, runnerPid);
  assert.equal(existsSync(runnerRegistryPath(runnerPid, env)), false, "the registration of the stopped runner is still there");
  assert.deepEqual(hammerClaims(outPaths).filter((claim) => claim.id === target), [], "a hammer claimed the job being stopped");
  const row = getJob(target, env);
  assert.deepEqual(
    { status: row.status, cancelledFrom: JSON.parse(row.result).cancelledFrom, worker: row.worker, attempts: row.attempts, note: row.operator_note },
    { status: "cancelled", cancelledFrom: "running", worker: null, attempts: 0, note: "brief changed" },
    "a write of the stopped runner resurrected or reshaped the cancelled job",
  );
});
