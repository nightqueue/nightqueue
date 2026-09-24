import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { getDecision, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { settleJobProposals } from "../../src/queue/proposals.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCloseDeps, mergedPr, CLOSE_PR_URL } from "../../test-support/close.mjs";

const QUESTION_MARK = "accept / reject / keep? [keep] ";
const CHILD_PID = 4242;

// A home with project `alpha` registered.
function makeDecisionsHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// A job that ended `done` with a pull request, ready to be closed.
function doneJob(env, prompt = "fix the worker") {
  const id = addJob({ project: "alpha", prompt }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run(CLOSE_PR_URL, id);
  return id;
}

// A decision the given job proposed, stamped straight in the database.
function proposal(env, { jobId, title }) {
  const saved = saveDecision({ project: "alpha", title, context: "why", decision: "what", status: "proposed" }, env);
  openDb(env).prepare("UPDATE decisions SET job_id = ? WHERE id = ?").run(jobId, saved.id);
  return saved;
}

// A terminal double: stdin says it is a TTY and answers each proposal question with the next answer, ending the input when none is left.
function answeringTerminal(answers) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  const stdout = new PassThrough();
  const asked = [];
  stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (!text.endsWith(QUESTION_MARK)) return;
    asked.push(text);
    const next = answers.shift();
    setImmediate(() => (next === undefined ? stdin.end() : stdin.write(`${next}\n`)));
  });
  return { stdin, stdout, asked };
}

// A spawn double recording every call and answering with a child that has a pid.
function fakeSpawn(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: CHILD_PID, unref: () => {} };
  };
}

// Runs `nightqueue queue close ...` in this process over a merged pull request, with the stdin/stdout the test gives, capturing out and err.
async function runQueueClose(env, argv, { stdin = { isTTY: false }, stdout = new PassThrough(), calls = [] } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    stdin,
    stdout,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    closeDeps: fakeCloseDeps({ pr: mergedPr() }).deps,
    spawnImpl: fakeSpawn(calls),
    killImpl: () => true,
  };
  const code = await run(argv, ctx);
  return { code, out, err };
}

// The lines a close printed about the proposals it settled or kept.
function decisionLines(out) {
  return out.filter((line) => line.startsWith("decision "));
}

// The stored status of a decision.
function statusOf(env, id) {
  return getDecision(id, env).status;
}

test("close --decisions accept flips every proposal of the closed job, and says so one line each", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-accept");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const second = proposal(env, { jobId: job, title: "runners register in one table" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground", "--decisions", "accept"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.equal(statusOf(env, first.id), "accepted");
  assert.equal(statusOf(env, second.id), "accepted");
  assert.ok(result.out.includes(`job #${job} closed: PR #7 merged as abc1234`), result.out.join("\n"));
  assert.deepEqual(decisionLines(result.out), [
    `decision #${first.number} leases are renewed by their owner: accepted`,
    `decision #${second.number} runners register in one table: accepted`,
  ]);
});

test("close --decisions reject rejects the proposal, and leaves the proposal of another job alone", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-reject");
  const job = doneJob(env);
  const other = doneJob(env, "another job");
  const mine = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const theirs = proposal(env, { jobId: other, title: "runners register in one table" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground", "--decisions", "reject"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(statusOf(env, mine.id), "rejected");
  assert.equal(statusOf(env, theirs.id), "proposed");
  assert.deepEqual(decisionLines(result.out), [`decision #${mine.number} leases are renewed by their owner: rejected`]);
});

test("without the flag and without a terminal the proposals stay proposed and are listed as kept", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-default");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.equal(statusOf(env, first.id), "proposed");
  assert.deepEqual(decisionLines(result.out), [`decision #${first.number} leases are renewed by their owner: kept (proposed)`]);
});

test("a detached close settles nothing itself and hands its --decisions choice to the child, which settles by it", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-detached");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const calls = [];

  const started = await runQueueClose(env, ["queue", "close", String(job), "--decisions", "accept"], { calls, stdin: answeringTerminal([]).stdin });

  assert.equal(started.code, 0, started.err.join("\n"));
  assert.deepEqual(calls[0].args.slice(1), ["queue", "close", String(job), "--foreground", "--decisions", "accept"]);
  assert.equal(statusOf(env, first.id), "proposed", "the parent of a detached close settled a proposal");
  const token = calls[0].options.env.NIGHTQUEUE_CLOSE_WORKER;
  const child = await runQueueClose({ ...env, NIGHTQUEUE_CLOSE_WORKER: token }, calls[0].args.slice(1));
  assert.equal(child.code, 0, child.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.equal(statusOf(env, first.id), "accepted");
});

test("a detached close without --decisions keeps the proposals: its child has no terminal to ask", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-detached-keep");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const calls = [];

  await runQueueClose(env, ["queue", "close", String(job)], { calls });
  assert.deepEqual(calls[0].args.slice(1), ["queue", "close", String(job), "--foreground"]);
  const token = calls[0].options.env.NIGHTQUEUE_CLOSE_WORKER;
  const child = await runQueueClose({ ...env, NIGHTQUEUE_CLOSE_WORKER: token }, calls[0].args.slice(1));

  assert.equal(child.code, 0, child.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.equal(statusOf(env, first.id), "proposed");
});

test("a closed job with no proposal prints no decision line and answers an empty `decisions` under --json", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-none");
  const text = doneJob(env);
  const json = doneJob(env, "second");

  const textResult = await runQueueClose(env, ["queue", "close", String(text), "--foreground", "--decisions", "accept"]);
  const jsonResult = await runQueueClose(env, ["queue", "close", String(json), "--foreground", "--json"]);

  assert.deepEqual(decisionLines(textResult.out), []);
  assert.equal(jsonResult.out.length, 1, jsonResult.out.join("\n"));
  assert.deepEqual(JSON.parse(jsonResult.out[0]).decisions, []);
});

test("close --json on a terminal never prompts, keeps the proposals and prints one parseable line carrying them", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-json");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const tty = answeringTerminal(["accept"]);

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground", "--json"], tty);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(tty.asked, [], "a --json close asked on the terminal");
  assert.equal(result.out.length, 1, result.out.join("\n"));
  const payload = JSON.parse(result.out[0]);
  assert.equal(payload.job.status, "closed");
  assert.deepEqual(payload.decisions, [
    { job_id: job, id: first.id, number: first.number, label: `#${first.number}`, title: "leases are renewed by their owner", action: "kept" },
  ]);
  assert.equal(statusOf(env, first.id), "proposed");
});

test("close --json --decisions accept flips the proposals and still prints one parseable line", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-json-accept");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground", "--json", "--decisions", "accept"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(result.out.length, 1, result.out.join("\n"));
  assert.deepEqual(JSON.parse(result.out[0]).decisions.map((entry) => entry.action), ["accepted"]);
  assert.equal(statusOf(env, first.id), "accepted");
});

test("an invalid --decisions is refused before anything closes, detached or not", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-invalid");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  for (const flags of [[], ["--foreground"]]) {
    const calls = [];
    const result = await runQueueClose(env, ["queue", "close", String(job), ...flags, "--decisions", "maybe"], { calls });
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /invalid decisions choice `maybe`; expected one of accept\|reject\|keep/);
    assert.deepEqual(calls, [], "an invalid choice spawned a close");
  }
  assert.equal(getJob(job, env).status, "done");
  assert.equal(getJob(job, env).close_status, null);
  assert.equal(statusOf(env, first.id), "proposed");
});

test("on a terminal each proposal is asked by number, title and job; an empty or unknown answer keeps it", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-tty");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const second = proposal(env, { jobId: job, title: "runners register in one table" });
  const third = proposal(env, { jobId: job, title: "heartbeats are configuration" });
  const tty = answeringTerminal(["Reject", "", "later"]);

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"], tty);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.deepEqual(tty.asked, [
    `decision #${first.number} "leases are renewed by their owner" of job #${job}: ${QUESTION_MARK}`,
    `decision #${second.number} "runners register in one table" of job #${job}: ${QUESTION_MARK}`,
    `decision #${third.number} "heartbeats are configuration" of job #${job}: ${QUESTION_MARK}`,
  ]);
  assert.equal(statusOf(env, first.id), "rejected");
  assert.equal(statusOf(env, second.id), "proposed");
  assert.equal(statusOf(env, third.id), "proposed");
});

test("on a terminal whose input ends before an answer, the proposal is kept", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-tty-eof");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const tty = answeringTerminal([]);

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground"], tty);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(tty.asked.length, 1);
  assert.equal(statusOf(env, first.id), "proposed");
  assert.deepEqual(decisionLines(result.out), [`decision #${first.number} leases are renewed by their owner: kept (proposed)`]);
});

test("a proposal that cannot be settled is reported on stderr and never undoes the close", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-settle-fails");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  openDb(env).exec("CREATE TRIGGER no_decision_update BEFORE UPDATE ON decisions BEGIN SELECT RAISE(ABORT, 'decisions are frozen'); END;");

  const result = await runQueueClose(env, ["queue", "close", String(job), "--foreground", "--decisions", "accept"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(getJob(job, env).status, "closed");
  assert.deepEqual(decisionLines(result.out), []);
  assert.equal(result.err.length, 1, result.err.join("\n"));
  assert.match(result.err[0], new RegExp(`^decisions of job #${job} not settled: .*decisions are frozen`));
  assert.equal(statusOf(env, first.id), "proposed");
});

test("a close that stops before the merge settles no proposal", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-stopped");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, closeDeps: fakeCloseDeps({ checks: { ok: true, checks: [], failing: ["lint"], pending: [] } }).deps };

  const code = await run(["queue", "close", String(job), "--foreground", "--decisions", "accept"], ctx);

  assert.equal(code, 1);
  assert.equal(getJob(job, env).status, "done");
  assert.equal(statusOf(env, first.id), "proposed");
  assert.deepEqual(decisionLines(out), []);
});

test("settleJobProposals refuses an answer outside accept, reject and keep without touching the proposal", async (t) => {
  const env = makeDecisionsHome(t, "close-decisions-bad-chooser");
  const job = doneJob(env);
  const first = proposal(env, { jobId: job, title: "leases are renewed by their owner" });

  await assert.rejects(
    settleJobProposals({ store: openStore(env), jobId: job, choose: async () => "later" }),
    /invalid decisions choice `later`/,
  );
  assert.equal(statusOf(env, first.id), "proposed");
});
