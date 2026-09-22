import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireShip, addJob, failShip } from "../../src/memory/jobs.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import {
  currentShipStep,
  queueWorkers,
  shipChecklistLines,
  shipLines,
  shippedLine,
  shipState,
  shipStatusSuffix,
  shipsSummary,
  shipStoppedLine,
} from "../../src/queue/ship-view.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const NOW = Date.parse("2026-09-21T12:00:00Z");
const LATER = "2026-09-21T12:10:00.000Z";
const EARLIER = "2026-09-21T11:50:00.000Z";
const WORKER = "ship:host:1:aaaa";
const PR_URL = "https://github.com/acme/api/pull/7";

// A job view with the ship fields the test gives, everything else a done job carries.
function shipJob(fields) {
  return { id: 12, status: "done", ship_status: null, ship_lease_until: null, ship: null, ...fields };
}

// Runs the CLI in this process, collecting what it prints.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, stdout: out.join("\n"), stderr: err.join("\n") };
}

// A home with one project and one done job carrying a pull request, the target every render of this file ships.
function shipHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run(PR_URL, id);
  return { env, id };
}

test("shipState reads in flight only under a live lease, and a dead lease as stalled", () => {
  assert.equal(shipState(shipJob({}), NOW), null);
  assert.equal(shipState(shipJob({ ship_status: "shipping", ship_lease_until: LATER }), NOW), "shipping");
  assert.equal(shipState(shipJob({ ship_status: "shipping", ship_lease_until: EARLIER }), NOW), "stalled");
  assert.equal(shipState(shipJob({ ship_status: "shipping", ship_lease_until: "2026-09-21 12:10:00" }), NOW), "shipping", "a SQLite timestamp is UTC");
  assert.equal(shipState(shipJob({ ship_status: "shipping", ship_lease_live: 0, ship_lease_until: LATER }), NOW), "stalled", "the SQL liveness wins");
  assert.equal(shipState(shipJob({ ship_status: "shipped" }), NOW), "shipped");
  assert.equal(shipState(shipJob({ ship_status: "failed" }), NOW), "failed");
});

test("the status suffix, the current step and the stopped line follow the checklist", () => {
  const steps = { preflight: { status: "done" }, conflict: { status: "skipped" } };
  const failed = shipJob({ ship_status: "failed", ship: { steps, failed: { step: "merge", reason: "merge-without-sha" } } });
  assert.equal(shipStatusSuffix(shipJob({}), NOW), "");
  assert.equal(shipStatusSuffix(shipJob({ ship_status: "shipping", ship_lease_until: LATER }), NOW), " · shipping");
  assert.equal(shipStatusSuffix(shipJob({ ship_status: "shipping", ship_lease_until: EARLIER }), NOW), " · ship stalled");
  assert.equal(shipStatusSuffix(failed, NOW), " · ship failed");
  assert.equal(shipStatusSuffix(shipJob({ status: "closed", ship_status: "shipped" }), NOW), " · shipped");
  assert.equal(currentShipStep({ steps }), "merge");
  assert.equal(currentShipStep(JSON.stringify({ steps: {} })), "preflight");
  assert.equal(shipStoppedLine(failed), "⛔ ship stopped at merge: merge-without-sha - run again with: nightshift queue ship 12");
  assert.equal(shipStoppedLine(shipJob({ ship_status: "shipped" })), null);
});

test("the checklist block prints every step in order, with the ones not reached marked", () => {
  const ship = {
    attempts: 2,
    steps: { preflight: { status: "done", note: "checks green", at: "t1" }, conflict: { status: "skipped", note: "mergeable" }, merge: { status: "failed", note: "merge-without-sha - still open" } },
    failed: { step: "merge", reason: "merge-without-sha" },
  };
  assert.deepEqual(shipChecklistLines(shipJob({ ship_status: "failed", ship }), NOW), [
    "ship            failed, attempt 2",
    "  ✓ preflight  checks green  (t1)",
    "  - conflict   skipped: mergeable",
    "  ✗ merge      merge-without-sha - still open",
    "  · settle     not reached",
    "⛔ ship stopped at merge: merge-without-sha - run again with: nightshift queue ship 12",
  ]);
  assert.deepEqual(shipChecklistLines(shipJob({}), NOW), []);
});

test("the summary names ships in flight with their pid, stopped ones with their reason and stalled ones with their lease", () => {
  const rows = [
    { id: 12, ship_status: "shipping", ship_lease_live: 1, ship: JSON.stringify({ steps: { preflight: { status: "done" } } }) },
    { id: 9, ship_status: "failed", ship: JSON.stringify({ failed: { step: "merge", reason: "merge-without-sha" } }) },
    { id: 4, ship_status: "shipping", ship_lease_live: 0, ship_lease_until: "2026-09-21 11:50:00" },
  ];
  const runners = [{ running: true, pid: 4242, mode: "ship", jobId: 12 }, { running: true, pid: 77, mode: "drain", jobId: null }];
  const summary = shipsSummary(rows, runners, NOW);
  assert.deepEqual(summary, {
    inFlight: [{ id: 12, step: "conflict", pid: 4242 }],
    failed: [{ id: 9, step: "merge", reason: "merge-without-sha" }],
    stalled: [{ id: 4, leaseUntil: EARLIER }],
  });
  assert.deepEqual(shipLines(summary), [
    "ship in flight: #12 at conflict (pid 4242) - follow with: nightshift queue status 12",
    "⛔ ship stopped at merge: merge-without-sha - run again with: nightshift queue ship 9",
    `ship of #4 stalled: its lease expired at ${EARLIER} - run again with: nightshift queue ship 4`,
  ]);
  assert.deepEqual(queueWorkers(runners).map((runner) => runner.pid), [77], "a ship runner was counted as a queue worker");
});

test("the Shipped line names the pull request, the short sha and the day it merged", () => {
  assert.equal(shippedLine({ number: 7, sha: "abc1234def5678", at: "2026-09-21T23:59:00Z" }), "Shipped: PR #7 merged as abc1234 on 2026-09-21");
});

test("queue status widens STATUS only for a listing with a ship, and prints the ship hint lines", async (t) => {
  const { env, id } = shipHome(t, "ship-view-render");
  const before = await runCli(env, ["queue", "status"]);
  assert.match(before.out[1], /^ID {4}STATUS {7}DURATION/, "a listing with no ship changed its STATUS width");

  acquireShip(id, { worker: WORKER, leaseS: 660 }, env);
  const shipping = await runCli(env, ["queue", "status"]);
  assert.match(shipping.stdout, /^ID {4}STATUS {12}DURATION/m, "STATUS did not grow to the ship suffix");
  assert.match(shipping.stdout, /✓ done · shipping -/);
  assert.match(shipping.stdout, /shipping: preflight/);
  assert.ok(shipping.out.includes(`ship in flight: #${id} at preflight - follow with: nightshift queue status ${id}`), shipping.stdout);

  failShip(id, { worker: WORKER, ship: { attempts: 1, steps: {}, data: {}, failed: { step: "conflict", reason: "suite-red" } } }, env);
  const failed = await runCli(env, ["queue", "status"]);
  assert.match(failed.stdout, /✓ done · ship failed/);
  assert.ok(failed.out.includes(`⛔ ship stopped at conflict: suite-red - run again with: nightshift queue ship ${id}`), failed.stdout);

  const detail = await runCli(env, ["queue", "status", String(id)]);
  assert.ok(detail.out.includes("ship            failed, attempt 1"), detail.stdout);
  assert.ok(detail.out.includes("  · preflight  not reached"), detail.stdout);
  assert.equal(detail.stdout.includes("[object Object]"), false, "the checklist object was printed as a key/value line");

  const { job } = JSON.parse((await runCli(env, ["queue", "status", String(id), "--json"])).stdout);
  assert.equal(job.ship_status, "failed");
  assert.deepEqual(job.ship.failed, { step: "conflict", reason: "suite-red" });
});

test("a live ship runner alone never promises a pending job will be picked up", async (t) => {
  const { env, id } = shipHome(t, "ship-view-workers");
  addJob({ project: "alpha", prompt: "the next job" }, env);
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "ship", jobId: id, intervalS: null, detached: false, logPath: null, runtimeDir: null }, env);
  const status = await runCli(env, ["queue", "status"]);
  assert.match(status.stdout, new RegExp(`runner: running \\(pid ${process.pid}, ship, job #${id}`));
  assert.ok(status.out.includes("1 pending job waiting - start the batch: nightshift queue run"), status.stdout);
  const added = await runCli(env, ["queue", "add", "alpha", "one more job"]);
  assert.match(added.stdout, /0 runners online - pending jobs will wait until `nightshift queue run` starts one\./);
});
