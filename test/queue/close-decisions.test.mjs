import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { commentFor } from "../../src/memory/issue-workflow.mjs";
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

test("close accepts every proposal of the closed job in one go, says so one line each, and names them in the notice", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-accept");
  const job = doneJob(env);
  const other = doneJob(env, "another job");
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const second = proposal(env, { jobId: job, title: "runners register in one table" });
  const theirs = proposal(env, { jobId: other, title: "heartbeats are configuration" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.equal(statusOf(env, first.id), "accepted");
  assert.equal(statusOf(env, second.id), "accepted");
  assert.equal(statusOf(env, theirs.id), "proposed");
  assert.ok(result.out.includes(`J-${job} closed: PR #7 merged as abc1234`), result.out.join("\n"));
  assert.deepEqual(acceptedLines(result.out), [
    `accepted D-${first.number}: leases are renewed by their owner`,
    `accepted D-${second.number}: runners register in one table`,
  ]);
  assert.match(getJob(job, env).notice_md, new RegExp(`^Closed: PR #7 merged as abc1234 on \\d{4}-\\d{2}-\\d{2}, accepted D-${first.number}, D-${second.number}$`, "m"));
});

test("the issue's closed comment names the accepted refs, and only when there are some", () => {
  const withRefs = { id: 9, notice_md: "gate text\n\nClosed: PR #7 merged as abc1234 on 2026-09-30, accepted D-60, D-61" };
  const without = { id: 9, notice_md: "Closed: PR #7 merged as abc1234 on 2026-09-30" };

  assert.equal(commentFor(withRefs, "closed", []).body, "J-9 closed, accepted D-60, D-61");
  assert.equal(commentFor(without, "closed", []).body, "J-9 closed");
});

test("a detached close hands nothing down and its child accepts the proposals", async (t) => {
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
  assert.equal(statusOf(env, first.id), "accepted");
});

test("a closed job with no proposal prints no accepted line and answers an empty `decisions` under --json", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-none");
  const text = doneJob(env);
  const json = doneJob(env, "second");

  const textResult = await runQueueClose(env, ["queue", "close", String(text), "--foreground"]);
  const jsonResult = await runQueueClose(env, ["queue", "close", String(json), "--foreground", "--json"]);

  assert.deepEqual(acceptedLines(textResult.out), []);
  assert.equal(jsonResult.out.length, 1, jsonResult.out.join("\n"));
  assert.deepEqual(JSON.parse(jsonResult.out[0]).decisions, []);
});

test("close --json prints one parseable line carrying the accepted decisions", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-json");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground", "--json"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(result.out.length, 1, result.out.join("\n"));
  const payload = JSON.parse(result.out[0]);
  assert.equal(payload.job.status, "closed");
  assert.deepEqual(payload.decisions, [{ job_id: job, ref: `D-${first.number}`, title: "leases are renewed by their owner" }]);
  assert.equal(statusOf(env, first.id), "accepted");
});

test("--decisions is refused with the usage line, detached or not, and nothing closes", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-removed");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  for (const flags of [[], ["--foreground"]]) {
    const calls = [];
    const result = await runQueueClose(env, ["queue", "close", String(job), ...flags, "--decisions", "accept"], { calls });
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /`--decisions` no longer exists.*usage: nightqueue queue close <id>/);
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

test("a decision write that fails rolls the close back: the job stays done and the proposal stays proposed", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-write-fails");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  openDb(env).exec("CREATE TRIGGER no_decision_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are frozen'); END;");

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"]);

  assert.equal(result.code, 1);
  assert.equal(getJob(job, env).status, "done");
  assert.equal(statusOf(env, first.id), "proposed");
  assert.deepEqual(acceptedLines(result.out), []);
});
