import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { queuePausedPath } from "../../src/config/paths.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { addJob, countActiveJobs, getJob } from "../../src/memory/jobs.mjs";
import { acquire, concurrencyCap, isPaused, leaseHeartbeatMs, resumeSessionEnabled, workerId } from "../../src/queue/claim.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLAIMER = fileURLToPath(new URL("../../test-support/queue-claimer.mjs", import.meta.url));
const BARRIER_MS = 400;

// A home with two registered projects and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  return env;
}

// Enqueues one job of a test project.
function enqueue(env, prompt = "fix the worker", project = "alpha") {
  return addJob({ project, prompt }, env).id;
}

// Runs the claimer as a real child process, so the two claims cross inside SQLite and not inside one heap.
function claimerAsync(env, { cap, jobId = "any", startAt }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLAIMER, String(cap), String(jobId), String(startAt)], {
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
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Races two claimer processes over the same queue and returns what each one got.
async function raceClaimers(env, { cap, jobId = "any" }) {
  const startAt = Date.now() + BARRIER_MS;
  const results = await Promise.all([
    claimerAsync(env, { cap, jobId, startAt }),
    claimerAsync(env, { cap, jobId, startAt }),
  ]);
  return results.map((result) => {
    assert.equal(result.code, 0, `claimer exited ${result.code}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim());
  });
}

test("two runner processes racing over the SAME job: exactly one of them owns it", async (t) => {
  const env = makeQueue(t, "claim-same-job");
  const id = enqueue(env);
  const claims = await raceClaimers(env, { cap: 4, jobId: id });

  const winners = claims.filter((claim) => claim.id !== null);
  assert.equal(winners.length, 1, `both processes claimed the job: ${JSON.stringify(claims)}`);
  assert.equal(winners[0].id, id);
  assert.equal(claims.find((claim) => claim.id === null).reason, "not-pending");
  const row = getJob(id, env);
  assert.equal(row.worker, winners[0].worker);
  assert.equal(row.attempts, 1, "the losing claim also spent an attempt");
});

test("two runner processes over jobs of DISTINCT projects both run while maxConcurrent allows it", async (t) => {
  const env = makeQueue(t, "claim-two-jobs");
  const first = enqueue(env, "fix the worker");
  const second = enqueue(env, "fix the parser", "beta");
  const claims = await raceClaimers(env, { cap: 2 });

  assert.deepEqual(
    claims.map((claim) => claim.id).sort((a, b) => a - b),
    [first, second],
    `the two processes did not take one job each: ${JSON.stringify(claims)}`,
  );
  assert.notEqual(claims[0].worker, claims[1].worker, "both jobs were claimed by the same worker id");
  assert.equal(countActiveJobs(env), 2);
});

test("the ceiling holds ACROSS processes: with maxConcurrent 1 the second runner gets nothing", async (t) => {
  const env = makeQueue(t, "claim-cap-across");
  enqueue(env, "fix the worker");
  enqueue(env, "fix the parser", "beta");
  const claims = await raceClaimers(env, { cap: 1 });

  const winners = claims.filter((claim) => claim.id !== null);
  assert.equal(winners.length, 1, `the ceiling was crossed: ${JSON.stringify(claims)}`);
  assert.equal(claims.find((claim) => claim.id === null).reason, "cap-reached");
  assert.equal(countActiveJobs(env), 1);
});

test("acquire explains every refusal instead of just returning nothing", async (t) => {
  const env = makeQueue(t, "claim-reasons");
  assert.deepEqual(await acquire({ cap: 1, env }), { job: null, reason: "empty-queue" });
  assert.deepEqual(await acquire({ jobId: 9999, cap: 1, env }), { job: null, reason: "unknown-job" });

  const id = enqueue(env);
  assert.equal((await acquire({ cap: 1, env })).job.id, id);
  assert.deepEqual(await acquire({ cap: 1, env }), { job: null, reason: "cap-reached" });
  assert.deepEqual(await acquire({ jobId: id, cap: 4, env }), { job: null, reason: "not-pending" });
});

test("the pause sentinel stops the queue, but never an explicit `--job`", async (t) => {
  const env = makeQueue(t, "claim-paused");
  const id = enqueue(env);
  assert.equal(isPaused(env), false);
  writeFileSync(queuePausedPath(env), `${new Date().toISOString()}\n`);
  assert.equal(isPaused(env), true);

  assert.deepEqual(await acquire({ cap: 2, env }), { job: null, reason: "paused" });
  assert.equal((await acquire({ jobId: id, cap: 2, env })).job.id, id, "an explicit job id was blocked by the pause");
  rmSync(queuePausedPath(env), { force: true });
  assert.equal(isPaused(env), false);
});

test("the ceiling and the resume switch come from the configuration, fail-closed on anything else", (t) => {
  const env = makeQueue(t, "claim-config");
  assert.equal(concurrencyCap(env), 2);
  assert.equal(resumeSessionEnabled(env), false);

  const config = loadConfig(env, { warn: () => {} });
  saveConfig({ ...config, queue: { maxConcurrent: 5, resumeSession: true } }, env);
  assert.equal(concurrencyCap(env), 5);
  assert.equal(resumeSessionEnabled(env), true);

  saveConfig({ ...config, queue: { maxConcurrent: 0, resumeSession: "true" } }, env);
  assert.equal(concurrencyCap(env), 2, "a broken ceiling did not fall back to the normalized default");
  assert.equal(resumeSessionEnabled(env), false);
});

test("the heartbeat of the lease comes from the configuration and never falls below one second", (t) => {
  const env = makeQueue(t, "claim-heartbeat");
  assert.equal(leaseHeartbeatMs(env), 5000);

  const config = loadConfig(env, { warn: () => {} });
  saveConfig({ ...config, queue: { maxConcurrent: 2, resumeSession: false, leaseHeartbeatS: 2 } }, env);
  assert.equal(leaseHeartbeatMs(env), 2000);

  for (const broken of [0, -1, 999, "3", null]) {
    saveConfig({ ...config, queue: { maxConcurrent: 2, resumeSession: false, leaseHeartbeatS: broken } }, env);
    assert.equal(leaseHeartbeatMs(env), 5000, `\`${String(broken)}\` became the heartbeat`);
  }
});

test("the worker id names the host and the process, so an ownership check survives a reboot", () => {
  assert.match(workerId(), /^.+:\d+$/);
  assert.ok(workerId().endsWith(`:${process.pid}`));
});
