import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath } from "../../src/config/paths.mjs";
import { checkpointWal, isoToSqlite, openDb, sqliteToIso, withFullSync } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:1000";
const CAP = 4;
const PR_URL = "https://github.com/acme/api/pull/7";
const FAILURE = "finish verification failed";

// A home with one registered project and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Collects everything the code under test writes to stderr, restoring the real stream at the end of the test.
function captureStderr(t) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  return () => chunks.join("");
}

// Counts how many times the literal shows up in a text.
function occurrences(text, literal) {
  return text.split(literal).length - 1;
}

// Enqueues a job and claims it, which is the only state a finish is allowed from.
function claimed(env, { project = "alpha", prompt = "fix the worker" } = {}) {
  const id = addJob({ project, prompt }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  return id;
}

// Installs a trigger that reverts the finish of a job, which is what a lost terminal write looks like from the outside.
function revertFinishWith(env, condition) {
  openDb(env).exec(
    `CREATE TRIGGER revert_finish AFTER UPDATE OF status ON jobs WHEN ${condition}
     BEGIN UPDATE jobs SET status = 'running' WHERE id = NEW.id; END`,
  );
}

test("withFullSync raises the durability of the connection and restores the level it found, on success and on failure", (t) => {
  const env = makeQueue(t, "full-sync-pragma");
  const db = openDb(env);
  db.exec("PRAGMA synchronous = NORMAL");
  const level = () => db.prepare("PRAGMA synchronous").get().synchronous;
  assert.equal(level(), 1, "the test needs a connection that is not already FULL");

  const inside = withFullSync(db, () => level());
  assert.equal(inside, 2, "the action did not run with `synchronous = FULL`");
  assert.equal(level(), 1, "the durability level was not restored after the action");

  assert.throws(
    () =>
      withFullSync(db, () => {
        throw new Error("the transaction failed");
      }),
    /the transaction failed/,
  );
  assert.equal(level(), 1, "an action that threw left the connection at another durability level");
});

test("isoToSqlite and sqliteToIso round-trip the timestamp the witness carries, and refuse anything unusable", () => {
  assert.equal(isoToSqlite("2026-09-11T03:15:00Z"), "2026-09-11 03:15:00");
  assert.equal(sqliteToIso(isoToSqlite("2026-09-11T03:15:00Z")), "2026-09-11T03:15:00Z");
  assert.equal(isoToSqlite("2026-09-11 03:15:00"), "2026-09-11 03:15:00", "a zone-less timestamp must be read as UTC, which is what the database stores");
  assert.equal(isoToSqlite("2026-09-11T03:15:00"), "2026-09-11 03:15:00");
  assert.equal(isoToSqlite("not a date"), null);
  assert.equal(isoToSqlite(null), null);
});

test("checkpointWal folds the log into the database and answers false instead of throwing when it cannot", (t) => {
  const env = makeQueue(t, "checkpoint");
  claimed(env);
  assert.equal(checkpointWal(env), true);
  assert.equal(checkpointWal({ ...env, NIGHTSHIFT_HOME: "/dev/null/nowhere" }), false);
});

test("a finish that does not read back is reported and repaired by the single retry", (t) => {
  const env = makeQueue(t, "finish-verify-retry");
  const stderr = captureStderr(t);
  const id = claimed(env);
  revertFinishWith(env, "NEW.status = 'done' AND OLD.worker IS NOT NULL");

  assert.equal(finishJob(id, { worker: WORKER, status: "done", prUrl: PR_URL }, env), true);

  const row = getJob(id, env);
  assert.equal(row.status, "done", "the retry did not repair the row");
  assert.equal(row.pr_url, PR_URL);
  assert.ok(row.finished_at, "the repaired row lost its finished_at");
  const log = readFileSync(jobLogPath(id, env), "utf8");
  assert.equal(occurrences(log, FAILURE), 1, `the job log does not carry the failure exactly once:\n${log}`);
  assert.ok(/expected status=done pr_url=.*finished_at=.*; read status=running/.test(log), `the detail line is missing:\n${log}`);
  assert.equal(occurrences(stderr(), FAILURE), 1, "the failure was not reported on stderr exactly once");
});

test("a finish that survives the retry keeps the job finished and says so twice, because a false would re-run work already done", (t) => {
  const env = makeQueue(t, "finish-verify-gives-up");
  const stderr = captureStderr(t);
  const id = claimed(env);
  revertFinishWith(env, "NEW.status = 'done'");

  assert.equal(
    finishJob(id, { worker: WORKER, status: "done", prUrl: PR_URL }, env),
    true,
    "a verification failure marked the job lost, which would re-run work that is already done",
  );

  const log = readFileSync(jobLogPath(id, env), "utf8");
  assert.equal(occurrences(log, FAILURE), 2, `the two attempts were not both reported:\n${log}`);
  assert.equal(occurrences(stderr(), FAILURE), 2, "the two attempts were not both reported on stderr");
});

test("finishJob still answers false for the one reason it always did: no row matched the claim", (t) => {
  const env = makeQueue(t, "finish-lost-job");
  const stderr = captureStderr(t);
  const id = claimed(env);
  assert.equal(finishJob(id, { worker: "host:9999", status: "done" }, env), false);
  assert.equal(getJob(id, env).status, "running");
  assert.equal(stderr(), "", "a job that never committed must not report a verification failure");
});

test("a pipeline run that vanished after the commit is inserted once more; one that came back different is only reported", (t) => {
  const dropped = makeQueue(t, "run-verify-absent");
  const stderr = captureStderr(t);
  openDb(dropped).exec(
    "CREATE TRIGGER drop_first AFTER INSERT ON pipeline_runs WHEN NEW.id = 1 BEGIN DELETE FROM pipeline_runs WHERE id = NEW.id; END",
  );
  const reinserted = logPipelineRun({ project: "alpha", slug: "fix-worker", tier: "simple", outcome: "pr_opened" }, dropped);
  assert.equal(reinserted.runId, 2, "the absent row was not inserted again");
  assert.equal(openDb(dropped).prepare("SELECT COUNT(*) AS total FROM pipeline_runs").get().total, 1);
  assert.equal(occurrences(stderr(), FAILURE), 1, "the lost run was not reported exactly once");

  const mutated = makeQueue(t, "run-verify-different");
  openDb(mutated).exec(
    "CREATE TRIGGER mutate AFTER INSERT ON pipeline_runs BEGIN UPDATE pipeline_runs SET outcome = 'no_commit' WHERE id = NEW.id; END",
  );
  const logged = logPipelineRun({ project: "alpha", slug: "fix-worker", tier: "simple", outcome: "pr_opened" }, mutated);
  assert.equal(logged.runId, 1);
  assert.equal(
    openDb(mutated).prepare("SELECT COUNT(*) AS total FROM pipeline_runs").get().total,
    1,
    "a row that is there, only different, was inserted twice",
  );
  assert.equal(occurrences(stderr(), FAILURE), 2, "the different run was not reported");
});
