import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { projectFootprint, purgeProject } from "../../src/memory/project-purge.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:4242";

// Makes the first close of an attempt row revert the job and the row to running, as a finish that never became durable.
function loseFirstFinish(db, id) {
  const { lease_until: lease } = db.prepare("SELECT lease_until FROM jobs WHERE id = ?").get(id);
  db.exec(`CREATE TABLE lost_once (n INTEGER);
    CREATE TRIGGER lose_finish AFTER UPDATE OF finished_at ON job_attempts
    WHEN NEW.finished_at IS NOT NULL AND (SELECT COUNT(*) FROM lost_once) = 0
    BEGIN
      INSERT INTO lost_once VALUES (1);
      UPDATE jobs SET status = 'running', worker = '${WORKER}', finished_at = NULL, attempt_started_at = datetime('now'), lease_until = '${lease}' WHERE id = NEW.job_id;
      UPDATE job_attempts SET finished_at = NULL, outcome = NULL WHERE job_id = NEW.job_id AND attempt = NEW.attempt;
    END;`);
}

test("a finish repaired by its re-apply also clears attempt_started_at and closes the attempt row with the finish's outcome", (t) => {
  const env = makeHome(t, "reapply-attempt");
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "x" }, env).id;
  assert.ok(claimJobById(id, { worker: WORKER, cap: 4 }, env));
  const db = openDb(env);
  loseFirstFinish(db, id);
  t.mock.method(process.stderr, "write", () => true);

  finishJob(id, { worker: WORKER, status: "done", result: { status: "done", exitCode: 0 }, usage: { tokensIn: 1, tokensOut: 1, costUsd: 0.1 } }, env);

  const job = db.prepare("SELECT status, attempt_started_at FROM jobs WHERE id = ?").get(id);
  assert.deepEqual({ ...job }, { status: "done", attempt_started_at: null });
  const rows = db.prepare("SELECT outcome, exit_reason, finished_at IS NULL AS open FROM job_attempts WHERE job_id = ?").all(id);
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ outcome: "done", exit_reason: "exit:0", open: 0 }]);
});

test("a project purge counts the attempt rows of its jobs and removes them with the jobs", (t) => {
  const env = makeHome(t, "purge-attempts");
  makeProject(t, env, "alpha");
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "x" }, env).id;
  assert.ok(claimJobById(id, { worker: WORKER, cap: 4 }, env));
  finishJob(id, { worker: WORKER, status: "done", result: { status: "done" } }, env);
  const db = openDb(env);

  assert.deepEqual(projectFootprint(db, projectId).find((entry) => entry.table === "job_attempts"), { table: "job_attempts", total: 1 });
  purgeProject(db, projectId);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_attempts WHERE job_id = ?").get(id).n, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
