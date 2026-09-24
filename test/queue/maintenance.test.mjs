import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { runnerRegistryPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { lastMaintenance, runMaintenance, startMaintenance, stopMaintenance } from "../../src/queue/maintenance.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { writeRunTerminal } from "../../src/queue/resume.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const DEAD_PID = 999_997;
const SLUG = "lost-finish";

// A kill double that says no process answers for any pid, the way a registration of a dead runner looks.
function deadKill() {
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

// A home with one project, the timer of which is stopped once the test ends.
function makeMaintainedHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  t.after(() => stopMaintenance(env));
  return env;
}

// Waits until a condition holds, polling, and tells whether it did before the deadline.
async function waitFor(condition, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) return false;
    await new Promise((done) => setTimeout(done, 10));
  }
  return true;
}

// A maintenance double that counts its runs and can be held open, so a test sees an overlap if the timer allowed one.
function countingRun({ holdMs = 0, warning = null } = {}) {
  const calls = { started: 0, concurrent: 0, maxConcurrent: 0 };
  const run = async () => {
    calls.started += 1;
    calls.concurrent += 1;
    calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent);
    await new Promise((done) => setTimeout(done, holdMs));
    calls.concurrent -= 1;
    return { warning, pruned: [], ms: holdMs };
  };
  return { calls, run };
}

test("startMaintenance runs once right away, never twice for one home, and exposes what it found", async (t) => {
  const env = makeMaintainedHome(t, "maintenance-start");
  const { calls, run } = countingRun({ warning: "could not repair a job from state.json: job #1: locked" });

  assert.equal(startMaintenance(env, { intervalMs: 60_000, run }), true);
  assert.equal(startMaintenance(env, { intervalMs: 60_000, run }), false, "a second start of the same home started a second timer");
  assert.ok(await waitFor(() => lastMaintenance(env) !== null), "the timer never ran its first pass");
  assert.equal(calls.started, 1);
  assert.equal(lastMaintenance(env).warning, "could not repair a job from state.json: job #1: locked");
  assert.match(lastMaintenance(env).at, /^\d{4}-\d{2}-\d{2}T/);
});

test("the timer never overlaps a pass that is still running", async (t) => {
  const env = makeMaintainedHome(t, "maintenance-overlap");
  const { calls, run } = countingRun({ holdMs: 120 });

  startMaintenance(env, { intervalMs: 20, run });
  await new Promise((done) => setTimeout(done, 400));
  stopMaintenance(env);

  assert.ok(calls.started >= 2, `the interval never fired again (${calls.started} runs)`);
  assert.equal(calls.maxConcurrent, 1, "two passes of the maintenance ran at the same time");
});

test("inside a job the timer is never started: the runner owns the maintenance there", async (t) => {
  const env = { ...makeMaintainedHome(t, "maintenance-in-job"), NIGHTQUEUE_JOB_ID: "7" };
  const { calls, run } = countingRun();

  assert.equal(startMaintenance(env, { intervalMs: 20, run }), false);
  await new Promise((done) => setTimeout(done, 100));
  assert.equal(calls.started, 0);
  assert.equal(lastMaintenance(env), null);
});

test("a timer whose run throws keeps the failure as its warning instead of dying", async (t) => {
  const env = makeMaintainedHome(t, "maintenance-throws");
  startMaintenance(env, {
    run: async () => {
      throw new Error("disk full\nstack");
    },
  });
  assert.ok(await waitFor(() => lastMaintenance(env) !== null));
  assert.equal(lastMaintenance(env).warning, "could not repair a job from state.json: disk full");
});

test("runMaintenance prunes a dead registration and repairs a lost finish, and never throws", async (t) => {
  const env = makeMaintainedHome(t, "maintenance-run");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ?, lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(SLUG, id);
  const terminal = { status: "done", prUrl: "https://github.com/acme/api/pull/7", finishedAt: "2026-09-11T03:15:00Z", writtenBy: "/tmp/runtime", pid: 4242 };
  writeRunTerminal({ project: "alpha", slug: SLUG, terminal, env });
  writeRunnerRecord({ pid: DEAD_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/dead.log" }, env);
  const pidfile = runnerRegistryPath(DEAD_PID, env);

  const outcome = await runMaintenance({ env, killImpl: deadKill });

  assert.deepEqual(outcome.pruned, [pidfile]);
  assert.equal(existsSync(pidfile), false);
  assert.equal(outcome.warning, null);
  assert.ok(Number.isInteger(outcome.ms) && outcome.ms >= 0);
  assert.equal(getJob(id, env).status, "done", "the lost finish was not repaired");
});
