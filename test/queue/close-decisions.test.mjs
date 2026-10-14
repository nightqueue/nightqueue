import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { getDecision, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { fakeCloseDeps, mergedPr, openPr, CLOSE_PR_URL } from "../../test-support/close.mjs";

const CHILD_PID = 4242;

// A home with project `alpha` registered.
function makeDecisionsHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// A job that ended `done` with a pull request, ready to be closed.
function doneJob(env, prompt = "fix the worker") {
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run(CLOSE_PR_URL, id);
  return id;
}

// A decision the given job proposed, stamped straight in the database.
function proposal(env, { jobId, title }) {
  const saved = saveDecision({ projectId: projectIdOf(env, "alpha"), title, context: "why", decision: "what", status: "proposed" }, env);
  openDb(env).prepare("UPDATE decisions SET job_id = ? WHERE id = ?").run(jobId, saved.id);
  return saved;
}

// A spawn double recording every call and answering with a child that has a pid.
function fakeSpawn(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: CHILD_PID, unref: () => {} };
  };
}

// Runs `nightqueue queue close ...` in this process over the given pull request, capturing out and err.
async function runQueueClose(env, argv, { calls = [], pr = mergedPr() } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    stdin: { isTTY: false },
    stdout: new PassThrough(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    closeDeps: fakeCloseDeps({ pr }).deps,
    spawnImpl: fakeSpawn(calls),
    killImpl: () => true,
  };
  const code = await run(argv, ctx);
  return { code, out, err };
}

// The lines a close printed about the decisions it accepted.
function acceptedLines(out) {
  return out.filter((line) => line.startsWith("accepted "));
}

// The stored status of a decision.
function statusOf(env, id) {
  return getDecision(id, env).status;
}

test("close leaves every proposal of the closed job proposed, prints no accepted line and names none in the notice", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-untouched");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const second = proposal(env, { jobId: job, title: "runners register in one table" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.equal(statusOf(env, first.id), "proposed");
  assert.equal(statusOf(env, second.id), "proposed");
  assert.ok(result.out.includes(`J-${job} closed: PR #7 merged as abc1234`), result.out.join("\n"));
  assert.deepEqual(acceptedLines(result.out), []);
  assert.doesNotMatch(getJob(job, env).notice_md ?? "", /Closed:|accepted/);
});

test("a detached close hands nothing down and its child leaves the proposals proposed", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-detached");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const calls = [];

  const started = await runQueueClose(env, ["queue", "close", String(job)], { calls });

  assert.equal(started.code, 0, started.err.join("\n"));
  assert.deepEqual(calls[0].args.slice(1), ["queue", "close", String(job), "--foreground"]);
  assert.equal(statusOf(env, first.id), "proposed", "the parent of a detached close accepted a proposal");
  const token = calls[0].options.env.NIGHTQUEUE_CLOSE_WORKER;
  const child = await runQueueClose({ ...env, NIGHTQUEUE_CLOSE_WORKER: token }, calls[0].args.slice(1));
  assert.equal(child.code, 0, child.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.equal(statusOf(env, first.id), "proposed");
});

test("close --json prints one parseable line with no `decisions` key, and the proposal stays proposed", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-json");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground", "--json"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(result.out.length, 1, result.out.join("\n"));
  const payload = JSON.parse(result.out[0]);
  assert.equal(payload.job.status, "closed");
  assert.equal("decisions" in payload, false);
  assert.deepEqual(Object.keys(payload).sort(), ["job", "outcome"]);
  assert.equal(statusOf(env, first.id), "proposed");
});

test("--decisions is an unknown option, detached or not, and nothing closes", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-removed");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  for (const flags of [[], ["--foreground"]]) {
    const calls = [];
    const result = await runQueueClose(env, ["queue", "close", String(job), ...flags, "--decisions", "accept"], { calls });
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /Unknown option '--decisions'/);
    assert.deepEqual(calls, [], "a refused flag spawned a close");
  }
  assert.equal(getJob(job, env).status, "done");
  assert.equal(statusOf(env, first.id), "proposed");
});

test("a close that stops before the merge writes no decision", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-stopped");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, closeDeps: fakeCloseDeps({ checks: { ok: true, checks: [], failing: ["lint"], pending: [] } }).deps };

  const code = await run(["queue", "close", String(job), "--foreground"], ctx);

  assert.equal(code, 1);
  assert.equal(getJob(job, env).status, "done");
  assert.equal(statusOf(env, first.id), "proposed");
  assert.deepEqual(acceptedLines(out), []);
});

test("a job that ends cancelled because its pull request was closed touches no decision", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-cancelled");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"], { pr: openPr({ state: "CLOSED" }) });

  assert.equal(result.code, 1);
  assert.equal(getJob(job, env).status, "cancelled");
  assert.equal(statusOf(env, first.id), "proposed");
  assert.deepEqual(acceptedLines(result.out), []);
});

test("a close never writes a decision: with every decision update aborted by a trigger it still ends closed", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-frozen");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  openDb(env).exec("CREATE TRIGGER no_decision_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are frozen'); END;");

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.doesNotMatch(getJob(job, env).notice_md ?? "", /Closed:/);
  assert.equal(statusOf(env, first.id), "proposed");
  assert.deepEqual(acceptedLines(result.out), []);
});
