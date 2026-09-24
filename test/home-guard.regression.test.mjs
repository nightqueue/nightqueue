import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { countsByStatus, getJob } from "../src/memory/jobs.mjs";
import { JOB_CLAUDE_DIR_ENV, JOB_HOME_ENV } from "../src/queue/home-guard.mjs";
import { makeHostEnv } from "../test-support/host.mjs";
import { makeProject } from "../test-support/memory.mjs";

// Regression net of the reported incident: an unattended verifier job ran `queue add`/`queue cancel`
// against the operator's own home, in already-registered projects, and then cancelled the jobs it
// created with the note "test artifact of an acceptance run". This must never happen again.

const VERIFIER_JOB_ID = 42;

// The refusal the operator's own home always answers with from inside a job.
function homeRefusal(id) {
  return `refused: this command would change the operator's nightqueue home from inside job #${id}; verify against a temporary home (NIGHTQUEUE_HOME=$(mktemp -d)) instead`;
}

// Context that captures the output and never asks a terminal anything.
function makeCtx(env) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: { isTTY: false },
    stdout: new PassThrough(),
  };
  return { ctx, out, err };
}

// Environment of the unattended child the runner itself spawned, pinned to the operator's real home.
function insideJob(env, { home, configDir }) {
  return { ...env, NIGHTQUEUE_JOB_ID: String(VERIFIER_JOB_ID), [JOB_HOME_ENV]: home, [JOB_CLAUDE_DIR_ENV]: configDir };
}

test("an unattended job never adds or cancels work in the operator's own home, even against already-registered projects", async (t) => {
  const host = makeHostEnv(t, "home-guard-regression");
  makeProject(t, host.env, "scripted");
  makeProject(t, host.env, "dup");

  // A job that already existed in the operator's home before the incident, exactly like the ones a
  // verifier "accepted" in production (job 3 in `scripted`).
  const preexisting = await run(["queue", "add", "scripted", "the operator's own pending work"], makeCtx(host.env).ctx);
  assert.equal(preexisting, 0, "setting up the pre-existing job must itself succeed as the operator");
  const before = countsByStatus(host.env);
  const jobId = getJob(1, host.env)?.id;
  assert.equal(jobId, 1, "the pre-existing job must have been created");
  assert.equal(getJob(jobId, host.env).status, "pending");

  const entriesBefore = readdirSync(host.home).sort();

  const jobEnv = insideJob(host.env, { home: host.home, configDir: host.configDir });

  const added = makeCtx(jobEnv);
  assert.equal(
    await run(["queue", "add", "scripted", "test artifact of an acceptance run"], added.ctx),
    1,
    "queue add from inside the verifier job must be refused",
  );
  assert.deepEqual(added.err, [`nightqueue: ${homeRefusal(VERIFIER_JOB_ID)}`]);
  assert.deepEqual(added.out, []);
  assert.deepEqual(countsByStatus(host.env), before, "a refused queue add must not create a job row");

  const cancelled = makeCtx(jobEnv);
  assert.equal(
    await run(["queue", "cancel", String(jobId), "--reason", "test artifact of an acceptance run"], cancelled.ctx),
    1,
    "queue cancel from inside the verifier job must be refused",
  );
  assert.deepEqual(cancelled.err, [`nightqueue: ${homeRefusal(VERIFIER_JOB_ID)}`]);
  assert.deepEqual(cancelled.out, []);
  assert.equal(getJob(jobId, host.env).status, "pending", "a refused queue cancel must not change the job's status");
  assert.deepEqual(countsByStatus(host.env), before, "a refused queue cancel must not change any job counts");

  assert.equal(existsSync(`${host.home}.lock`), false, "a refused command must not create the write lock in the operator's home");
  assert.deepEqual(readdirSync(host.home).sort(), entriesBefore, "a refused command must not leave any new entry in the operator's home");
});
