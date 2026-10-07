import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";

const WORKER = "host:5151";

// Queues and claims one job of `alpha`.
function claimedJob(env) {
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: 4 }, env);
  return id;
}

// Turns a current home back into the v22 shape: no attempt table, no attempt columns, stamped 22, its runner stopped so the v24 step may run.
function downgradeToV22(env) {
  const db = openDb(env);
  db.exec("UPDATE jobs SET lease_until = datetime('now', '-1 hour') WHERE status = 'running'");
  db.exec("DROP TABLE job_attempts; ALTER TABLE jobs DROP COLUMN attempt_started_at; ALTER TABLE jobs DROP COLUMN next_attempt_fresh; PRAGMA user_version = 22;");
  closeDb(env);
}

// A v22 home with a done, a gated, a running and a pending job, the done one's timing pinned to 10:00-10:25.
function makeV22Home(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const done = claimedJob(env);
  finishJob(done, { worker: WORKER, status: "done", result: { status: "done" }, usage: { tokensIn: 40, tokensOut: 20, costUsd: 1.5 } }, env);
  const gate = claimedJob(env);
  finishJob(gate, { worker: WORKER, status: "gate", result: { status: "gate" }, noticeMd: "q?" }, env);
  const running = claimedJob(env);
  const pending = addJob({ projectId: ensureProject(env, "alpha"), prompt: "later" }, env).id;
  openDb(env).prepare("UPDATE jobs SET started_at = '2026-10-06 10:00:00', finished_at = '2026-10-06 10:25:00' WHERE id = ?").run(done);
  downgradeToV22(env);
  return { env, ids: { done, gate, running, pending } };
}

// Every attempt row of the home, in key order.
function attemptRows(db) {
  return db.prepare("SELECT * FROM job_attempts ORDER BY job_id, attempt").all().map((row) => ({ ...row }));
}

test("the schema is past v22, so every home carries the v23 attempt history", () => {
  assert.ok(DB_USER_VERSION > 22);
});

test("a v22 home gains the attempt table and columns, one backfilled row per job that ran, and a second open writes nothing", (t) => {
  const { env, ids } = makeV22Home(t, "migration-v23");
  assert.throws(() => openDbReadOnly(env), (err) => err.code === "SCHEMA_OUTDATED");
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 24);
  const rows = attemptRows(db);
  assert.deepEqual(
    rows.map(({ job_id, attempt, outcome, measured, backfilled, spawns, tokens_out, finished_at }) => ({ job_id, attempt, outcome, measured, backfilled, spawns, tokens_out, open: finished_at === null })),
    [
      { job_id: ids.done, attempt: 1, outcome: "done", measured: 1, backfilled: 1, spawns: 1, tokens_out: 20, open: false },
      { job_id: ids.gate, attempt: 1, outcome: "gate", measured: 1, backfilled: 1, spawns: 1, tokens_out: null, open: false },
      { job_id: ids.running, attempt: 1, outcome: null, measured: 0, backfilled: 1, spawns: 1, tokens_out: null, open: true },
    ],
  );
  const running = db.prepare("SELECT started_at, attempt_started_at FROM jobs WHERE id = ?").get(ids.running);
  assert.equal(running.attempt_started_at, running.started_at, "the running job lost its orphan ceiling anchor");

  closeDb(env);
  const again = openDb(env);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "the second open wrote rows");
  assert.deepEqual(attemptRows(again), rows);
});

test("a pre-v23 job keeps the DURATION and tokens it showed before the migration", (t) => {
  const { env, ids } = makeV22Home(t, "migration-v23-duration");
  migrateTestHome(env);
  const done = jobView(getJob(ids.done, env));
  assert.equal(done.active_s, 25 * 60);
  assert.equal(done.wall_s, 25 * 60);
  assert.deepEqual([done.tokens_in, done.tokens_out, done.cost_usd], [40, 20, 1.5]);
  assert.equal(done.attempts_log[0].backfilled, true);
  const pending = jobView(getJob(ids.pending, env));
  assert.deepEqual([pending.attempts_log, pending.active_s], [[], null]);
});

test("the running job of a migrated home finishes on its backfilled row, its usage added once", (t) => {
  const { env, ids } = makeV22Home(t, "migration-v23-running");
  migrateTestHome(env);
  finishJob(ids.running, { worker: WORKER, status: "done", result: { status: "done" }, usage: { tokensOut: 8 } }, env);
  const view = jobView(getJob(ids.running, env));
  assert.deepEqual(view.attempts_log.map((row) => [row.outcome, row.tokens_out, row.backfilled]), [["done", 8, true]]);
  assert.equal(view.tokens_out, 8);
});
