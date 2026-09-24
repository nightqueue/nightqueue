import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, failClose, settleClose } from "../../src/memory/jobs.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import {
  currentCloseStep,
  queueWorkers,
  closeChecklistLines,
  closeLines,
  closedLine,
  closeState,
  closesSummary,
  closeStoppedLine,
  statusLabel,
} from "../../src/queue/close-view.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const LATER = "2026-09-21T12:10:00.000Z";
const EARLIER = "2026-09-21T11:50:00.000Z";
const WORKER = "close:host:1:aaaa";
const PR_URL = "https://github.com/acme/api/pull/7";

// A job view with the close fields the test gives, everything else a done job carries.
function closeRow(fields) {
  return { id: 12, status: "done", close_status: null, close_lease_until: null, close: null, ...fields };
}

// Runs the CLI in this process, collecting what it prints.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, stdout: out.join("\n"), stderr: err.join("\n") };
}

// A home with one project and one done job carrying a pull request, the target every render of this file closes.
function closeHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run(PR_URL, id);
  return { env, id };
}

test("closeState reads in flight only under a live lease, and a dead lease as stalled", () => {
  assert.equal(closeState(closeRow({}), NOW), null);
  assert.equal(closeState(closeRow({ close_status: "closing", close_lease_until: LATER }), NOW), "closing");
  assert.equal(closeState(closeRow({ close_status: "closing", close_lease_until: EARLIER }), NOW), "stalled");
  assert.equal(closeState(closeRow({ close_status: "closing", close_lease_until: "2026-09-21 12:10:00" }), NOW), "closing", "a SQLite timestamp is UTC");
  assert.equal(closeState(closeRow({ close_status: "closing", close_lease_live: 0, close_lease_until: LATER }), NOW), "stalled", "the SQL liveness wins");
  assert.equal(closeState(closeRow({ status: "closed", close: { data: { merged: true } } }), NOW), "closed");
  assert.equal(closeState(closeRow({ status: "closed" }), NOW), null, "a closed job with no checklist has no close state");
  assert.equal(closeState(closeRow({ close_status: "failed" }), NOW), "failed");
});

test("the status label, the current step and the stopped line follow the checklist", () => {
  const steps = { preflight: { status: "done" }, conflict: { status: "skipped" } };
  const failed = closeRow({ close_status: "failed", close: { steps, failed: { step: "merge", reason: "merge-without-sha" } } });
  assert.equal(statusLabel(closeRow({}), NOW), "done");
  assert.equal(statusLabel(closeRow({ close_status: "closing", close_lease_until: LATER }), NOW), "done · closing");
  assert.equal(statusLabel(closeRow({ close_status: "closing", close_lease_until: EARLIER }), NOW), "done · close stalled");
  assert.equal(statusLabel(failed, NOW), "done · close failed at merge");
  assert.equal(statusLabel(closeRow({ status: "closed", close: { data: { merged: true } } }), NOW), "closed");
  assert.equal(statusLabel(closeRow({ status: "closed" }), NOW), "closed");
  assert.equal(currentCloseStep({ steps }), "merge");
  assert.equal(currentCloseStep(JSON.stringify({ steps: {} })), "preflight");
  assert.equal(closeStoppedLine(failed), "⛔ close stopped at merge: merge-without-sha - run again with: nightshift queue close 12");
  assert.equal(closeStoppedLine(closeRow({ status: "closed", close: { data: { merged: true } } })), null);
});

test("the checklist block prints every step in order, with the ones not reached marked", () => {
  const close = {
    attempts: 2,
    steps: { preflight: { status: "done", note: "checks green", at: "t1" }, conflict: { status: "skipped", note: "mergeable" }, merge: { status: "failed", note: "merge-without-sha - still open" } },
    failed: { step: "merge", reason: "merge-without-sha" },
  };
  assert.deepEqual(closeChecklistLines(closeRow({ close_status: "failed", close: close }), NOW), [
    "close           failed, attempt 2",
    "  ✓ preflight  checks green  (t1)",
    "  - conflict   skipped: mergeable",
    "  ✗ merge      merge-without-sha - still open",
    "  · settle     not reached",
    "⛔ close stopped at merge: merge-without-sha - run again with: nightshift queue close 12",
  ]);
  assert.deepEqual(closeChecklistLines(closeRow({}), NOW), []);
});

test("the summary names closes in flight with their pid, stopped ones with their reason and stalled ones with their lease", () => {
  const rows = [
    { id: 12, close_status: "closing", close_lease_live: 1, close: JSON.stringify({ steps: { preflight: { status: "done" } } }) },
    { id: 9, close_status: "failed", close: JSON.stringify({ failed: { step: "merge", reason: "merge-without-sha" } }) },
    { id: 4, close_status: "closing", close_lease_live: 0, close_lease_until: "2026-09-21 11:50:00" },
  ];
  const runners = [{ running: true, pid: 4242, mode: "close", jobId: 12 }, { running: true, pid: 77, mode: "drain", jobId: null }];
  const summary = closesSummary(rows, runners, NOW);
  assert.deepEqual(summary, {
    inFlight: [{ id: 12, step: "conflict", pid: 4242 }],
    failed: [{ id: 9, step: "merge", reason: "merge-without-sha" }],
    stalled: [{ id: 4, leaseUntil: EARLIER }],
  });
  assert.deepEqual(closeLines(summary), [
    "close in flight: #12 at conflict (pid 4242) - follow with: nightshift queue status 12",
    "⛔ close stopped at merge: merge-without-sha - run again with: nightshift queue close 9",
    `close of #4 stalled: its lease expired at ${EARLIER} - run again with: nightshift queue close 4`,
  ]);
  assert.deepEqual(queueWorkers(runners).map((runner) => runner.pid), [77], "a close runner was counted as a queue worker");
});

test("the Closed line names the pull request, the short sha and the day it merged", () => {
  assert.equal(closedLine({ number: 7, sha: "abc1234def5678", at: "2026-09-21T23:59:00Z" }), "Closed: PR #7 merged as abc1234 on 2026-09-21");
});

test("queue status shows `done · closing` while a close holds the job, `done · close failed at <step>` once it stopped, and prints the close hint lines", async (t) => {
  const { env, id } = closeHome(t, "close-view-render");
  const before = await runCli(env, ["queue", "status"]);
  assert.match(before.out[1], /^ID {4}STATUS {7}DURATION/, "a listing with no close changed its STATUS width");

  acquireClose(id, { worker: WORKER, leaseS: 660 }, env);
  const closing = await runCli(env, ["queue", "status"]);
  assert.match(closing.stdout, /^ID {4}STATUS {11}DURATION/m, "STATUS did not grow to the `done · closing` label");
  assert.match(closing.stdout, new RegExp(`^#${id} +✓ done · closing +-`, "m"));
  assert.match(closing.stdout, /closing: preflight/);
  assert.ok(closing.out.includes(`close in flight: #${id} at preflight - follow with: nightshift queue status ${id}`), closing.stdout);

  failClose(id, { worker: WORKER, close: { attempts: 1, steps: {}, data: {}, failed: { step: "conflict", reason: "suite-red" } } }, env);
  const failed = await runCli(env, ["queue", "status"]);
  assert.match(failed.stdout, /^ID {4}STATUS {28}DURATION/m, "STATUS did not grow to the stopped close's label");
  assert.match(failed.stdout, /✓ done · close failed at conflict /);
  assert.ok(failed.out.includes(`⛔ close stopped at conflict: suite-red - run again with: nightshift queue close ${id}`), failed.stdout);

  const detail = await runCli(env, ["queue", "status", String(id)]);
  assert.ok(detail.out.includes("close           failed, attempt 1"), detail.stdout);
  assert.ok(detail.out.includes("  · preflight  not reached"), detail.stdout);
  assert.equal(detail.stdout.includes("[object Object]"), false, "the checklist object was printed as a key/value line");

  const { job } = JSON.parse((await runCli(env, ["queue", "status", String(id), "--json"])).stdout);
  assert.equal(job.close_status, "failed");
  assert.deepEqual(job.close.failed, { step: "conflict", reason: "suite-red" });
});

// Runs `queue status --follow --until-idle` in this process on a pipe, with a sleep that never waits.
async function followOnce(env) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, stdout: { isTTY: false, columns: 160, write: () => {} }, sleep: async () => {} };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  return { code, stdout: out.join("\n") };
}

test("a closed job shows `closed` alone, in the table and in the live view, while --json keeps its close checklist", async (t) => {
  const { env, id } = closeHome(t, "close-view-closed");
  acquireClose(id, { worker: WORKER, leaseS: 660 }, env);
  const live = await followOnce(env);
  assert.equal(live.code, 0, live.stdout);
  assert.match(live.stdout, new RegExp(`^#${id} +✓ done · closing +-`, "m"), "the live view did not show `done · closing`");

  settleClose(id, { worker: WORKER, close: { attempts: 1, steps: {}, data: { merged: true, mergeSha: "abc1234def" } }, noticeLine: "Closed: PR #7 merged as abc1234 on 2026-09-21" }, env);
  const table = await runCli(env, ["queue", "status"]);
  assert.match(table.stdout, /^ID {4}STATUS {7}DURATION/m, "a closed job widened STATUS");
  assert.match(table.stdout, new RegExp(`^#${id} +■ closed +-`, "m"));
  assert.equal(/· closed/.test(table.stdout), false, "the cell kept the old `· closed` suffix");
  const followed = await followOnce(env);
  assert.match(followed.stdout, new RegExp(`^#${id} +■ closed +-`, "m"), "the live view did not show `closed` alone");
  assert.equal(/· closed/.test(followed.stdout), false, "the live view kept the old `· closed` suffix");

  const { job } = JSON.parse((await runCli(env, ["queue", "status", String(id), "--json"])).stdout);
  assert.equal(job.close_status, null);
  assert.equal(job.close.data.merged, true);
  assert.equal(job.status, "closed");
});

test("a live close runner alone never promises a pending job will be picked up", async (t) => {
  const { env, id } = closeHome(t, "close-view-workers");
  addJob({ project: "alpha", prompt: "the next job" }, env);
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "close", jobId: id, intervalS: null, detached: false, logPath: null, runtimeDir: null }, env);
  const status = await runCli(env, ["queue", "status"]);
  assert.match(status.stdout, new RegExp(`runner: running \\(pid ${process.pid}, close, job #${id}`));
  assert.ok(status.out.includes("1 pending job waiting - start the batch: nightshift queue run"), status.stdout);
  const added = await runCli(env, ["queue", "add", "alpha", "one more job"]);
  assert.match(added.stdout, /0 runners online - pending jobs will wait until `nightshift queue run` starts one\./);
});
