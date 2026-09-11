import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, countActiveJobs, getJob, sweepOrphans } from "../../src/memory/jobs.mjs";
import { acquire, liveLocalWorker } from "../../src/queue/claim.mjs";
import { cliEntrypoint } from "../../src/queue/spawn.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const CAP = 4;
const TIMEOUT_S = 120;
const HARD_CEILING_S = TIMEOUT_S + 600;
const LIVE_WORKER = `${hostname()}:${process.pid}`;
const FIRST_HOLD_MS = 8000;
const SECOND_HOLD_MS = 400;

// Registers a REAL git repository as a project: the CLI path always runs the real git preflight.
function makeRealGitProject(t, env, name) {
  const path = initGitRepo(makeDir(t, `repo-${name}`));
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// Writes a stand-in child: it drops a marker with its own pid and then holds, so the test controls how long it lives.
function writeHoldingClaude(t) {
  const dir = makeDir(t, "lease-bin");
  const bin = join(dir, "holding-claude.mjs");
  const source = [
    "#!/usr/bin/env node",
    'import { writeFileSync } from "node:fs";',
    "",
    "function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }",
    "",
    "async function main() {",
    '  const holdMs = Number(process.env.NIGHTSHIFT_TEST_HOLD_MS ?? "0");',
    "  const markerPath = process.env.NIGHTSHIFT_TEST_MARKER;",
    "  if (markerPath) writeFileSync(markerPath, JSON.stringify({ pid: process.pid, start: Date.now() }));",
    "  await sleep(holdMs);",
    "}",
    "",
    "await main();",
    "process.exitCode = 0;",
    "",
  ].join("\n");
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  return bin;
}

// Runs the real CLI `queue run --job <id> --foreground` as its own process, resolving with its outcome.
function runQueueCli(env, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntrypoint(), "queue", "run", "--job", String(jobId), "--foreground"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr, pid: child.pid }));
  });
}

// Polls until the given file exists, or throws once the deadline passes.
async function waitForFile(path, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Tells whether a pid is still alive, without depending on it being a child of this process.
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kills every pid the test started, so no child of a killed runner survives the suite.
function killerOf(t) {
  const pids = new Set();
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        continue;
      }
    }
  });
  return pids;
}

// Environment of one real runner process, with its own hold and its own marker file.
function runnerEnv(env, bin, { holdMs, marker }) {
  return { ...env, NIGHTSHIFT_CLAUDE_BIN: bin, NIGHTSHIFT_TEST_HOLD_MS: String(holdMs), NIGHTSHIFT_TEST_MARKER: marker };
}

// Moves the lease of a job to a given number of seconds in the past.
function setLeaseAge(env, id, seconds) {
  openDb(env).prepare(`UPDATE jobs SET lease_until = datetime('now', '-${seconds} seconds') WHERE id = ?`).run(id);
}

// Moves the start of a job into the past, which is how its hard ceiling is made to expire.
function setStartAge(env, id, seconds) {
  openDb(env).prepare(`UPDATE jobs SET started_at = datetime('now', '-${seconds} seconds') WHERE id = ?`).run(id);
}

test("a lease that expires while its owner is ALIVE never gives a second real runner a second child", async (t) => {
  const env = makeHome(t, "lease-owner-alive");
  makeRealGitProject(t, env, "alpha");
  const bin = writeHoldingClaude(t);
  const marker1 = join(makeDir(t, "lease-marker1"), "marker.json");
  const marker2 = join(makeDir(t, "lease-marker2"), "marker.json");
  const pidsToKill = killerOf(t);
  const jobId = addJob({ project: "alpha", prompt: "fix the worker", maxAttempts: 5, timeoutS: TIMEOUT_S }, env).id;

  const process1 = runQueueCli(runnerEnv(env, bin, { holdMs: FIRST_HOLD_MS, marker: marker1 }), jobId);
  const child1 = await waitForFile(marker1, 8000, "the first real child to start");
  pidsToKill.add(child1.pid);
  const owner = getJob(jobId, env).worker;

  setLeaseAge(env, jobId, 120);
  const result2 = await runQueueCli(runnerEnv(env, bin, { holdMs: SECOND_HOLD_MS, marker: marker2 }), jobId);

  assert.equal(result2.code, 0, `the second runner failed: ${result2.stderr}`);
  assert.equal(existsSync(marker2), false, `a SECOND real child started for job #${jobId} while the first one was alive`);
  assert.match(result2.stdout, /^runner already active \(pid \d+, once\) - it will pick the job up$/m, `the second runner did not refuse: ${result2.stdout}`);
  assert.deepEqual(
    acquire({ jobId, cap: CAP, env }),
    { job: null, reason: "not-pending" },
    "the claim itself stopped protecting the job of a live owner whose lease expired",
  );
  assert.equal(isAlive(child1.pid), true, "the first real child was killed by the second runner");
  const row = getJob(jobId, env);
  assert.deepEqual({ status: row.status, worker: row.worker }, { status: "running", worker: owner }, "the job changed hands");

  const result1 = await process1;
  assert.equal(result1.code, 0, `the first runner failed: ${result1.stderr}`);
  assert.equal(getJob(jobId, env).worker, null, "the first runner did not close its own job");
});

test("the job of a runner that DIED is requeued after the grace and picked up by the next runner", async (t) => {
  const env = makeHome(t, "lease-owner-dead");
  makeRealGitProject(t, env, "alpha");
  const bin = writeHoldingClaude(t);
  const marker1 = join(makeDir(t, "lease-dead-marker1"), "marker.json");
  const marker2 = join(makeDir(t, "lease-dead-marker2"), "marker.json");
  const pidsToKill = killerOf(t);
  const jobId = addJob({ project: "alpha", prompt: "fix the worker", maxAttempts: 5, timeoutS: TIMEOUT_S }, env).id;

  const process1 = runQueueCli(runnerEnv(env, bin, { holdMs: FIRST_HOLD_MS, marker: marker1 }), jobId);
  const child1 = await waitForFile(marker1, 8000, "the first real child to start");
  pidsToKill.add(child1.pid);
  const owner = getJob(jobId, env).worker;

  process.kill(Number(owner.slice(owner.lastIndexOf(":") + 1)), "SIGKILL");
  await process1;
  process.kill(child1.pid, "SIGKILL");
  setLeaseAge(env, jobId, 120);

  const result2 = await runQueueCli(runnerEnv(env, bin, { holdMs: SECOND_HOLD_MS, marker: marker2 }), jobId);

  assert.equal(result2.code, 0, `the second runner failed: ${result2.stderr}`);
  const child2 = JSON.parse(readFileSync(marker2, "utf8"));
  pidsToKill.add(child2.pid);
  assert.notEqual(child2.pid, child1.pid, "the second child reused the pid of the first one");
  const row = getJob(jobId, env);
  assert.equal(row.worker, null, "the second runner did not close the job it took over");
  assert.equal(row.attempts, 2, "the requeue of the orphan did not preserve the attempt of the dead runner");
  assert.notEqual(row.status, "pending", "the job of the dead runner was never taken over");
});

test("a live owner past the hard ceiling is recycled anyway: reclaiming never depends on a healthy process", (t) => {
  const env = makeHome(t, "lease-hard-ceiling");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker", maxAttempts: 3, timeoutS: TIMEOUT_S }, env).id;
  claimJobById(id, { worker: LIVE_WORKER, cap: CAP }, env);
  setLeaseAge(env, id, 120);
  setStartAge(env, id, HARD_CEILING_S + 60);

  assert.equal(liveLocalWorker(LIVE_WORKER), true, "the owner of the job is not alive, so the case proves nothing");
  assert.deepEqual(sweepOrphans(env, { liveWorkerImpl: liveLocalWorker }), { failed: 0, requeued: 1 });
  assert.equal(getJob(id, env).status, "pending");
});

test("a lease inside the grace window is left alone and keeps its project and its slot busy", (t) => {
  const env = makeHome(t, "lease-grace");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker", maxAttempts: 3, timeoutS: TIMEOUT_S }, env).id;
  claimJobById(id, { worker: LIVE_WORKER, cap: CAP }, env);
  const second = addJob({ project: "alpha", prompt: "fix the parser" }, env).id;
  setLeaseAge(env, id, 30);

  assert.deepEqual(sweepOrphans(env, { liveWorkerImpl: liveLocalWorker }), { failed: 0, requeued: 0 });
  assert.equal(getJob(id, env).status, "running");
  assert.equal(countActiveJobs(env), 1, "a job inside the grace window stopped counting for the ceiling");
  assert.equal(claimJobById(second, { worker: "host:1", cap: CAP }, env), null, "the project stopped being busy inside the grace");
});

test("an expired lease of a LIVE owner is protected, and a malformed worker never breaks the sweep", (t) => {
  const env = makeHome(t, "lease-protection");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const mine = addJob({ project: "alpha", prompt: "fix the worker", maxAttempts: 3, timeoutS: TIMEOUT_S }, env).id;
  const broken = addJob({ project: "beta", prompt: "fix the parser", maxAttempts: 3, timeoutS: TIMEOUT_S }, env).id;
  claimJobById(mine, { worker: LIVE_WORKER, cap: CAP }, env);
  claimJobById(broken, { worker: "no-colon-at-all", cap: CAP }, env);
  setLeaseAge(env, mine, 120);
  setLeaseAge(env, broken, 120);

  assert.deepEqual(sweepOrphans(env, { liveWorkerImpl: liveLocalWorker }), { failed: 0, requeued: 1 });
  assert.equal(getJob(mine, env).status, "running", "the job of a runner that is still alive was taken away from it");
  assert.equal(getJob(broken, env).status, "pending", "a malformed worker stopped the sweep from recycling its job");

  for (const worker of [null, undefined, "", ":", "host:", "host:abc", "host:-1", `${hostname()}:0`, "other-host:1"]) {
    assert.equal(liveLocalWorker(worker), false, `\`${String(worker)}\` was read as a live local worker`);
  }
  assert.equal(liveLocalWorker(LIVE_WORKER), true);
});
