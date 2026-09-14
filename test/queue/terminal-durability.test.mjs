import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isoToSqlite, openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob } from "../../src/memory/jobs.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WRITER = join(PACKAGE_ROOT, "test-support", "concurrent-writer.mjs");
const FINISHER_TRAIL = join("test-support", "job-finisher.mjs");
const RUNTIME_ENTRIES = ["package.json", "src", "test-support"];
const WORKER = "host:4242";
const CAP = 4;
const SLUG = "fix-worker";
const BARRIER_MS = 1000;
const WRITE_MS = 2000;

// A COPY of the package directory: the tree an old runtime was loaded from, before an install replaced it.
function copyRuntime(t, name) {
  const dir = join(makeDir(t, name), "old-runtime");
  mkdirSync(dir, { recursive: true });
  for (const entry of RUNTIME_ENTRIES) cpSync(join(PACKAGE_ROOT, entry), join(dir, entry), { recursive: true });
  return realpathSync(dir);
}

// Enqueues a job, claims it and records the slug of its run: the row a runner owns while it works.
function runningJob(env) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  return id;
}

// Runs one child process to the end, outside the tree it loads, and reports the first line it printed as soon as it arrives.
function runChild(entry, args, env, { onFirstLine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: tmpdir(), env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let notify = onFirstLine;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!notify || !stdout.includes("\n")) return;
      const announce = notify;
      notify = null;
      announce(JSON.parse(stdout.split("\n")[0]));
    });
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// The JSON lines a child printed, in the order it printed them.
function linesOf(result) {
  return result.stdout.trim().split("\n").map((line) => JSON.parse(line));
}

// Reverts the row to what a lost finish leaves behind: running again, under a lease no runner answers for any more.
function revertFinish(env, id) {
  openDb(env)
    .prepare(
      `UPDATE jobs
          SET status = 'running', worker = ?, lease_until = datetime('now', '-120 seconds'), finished_at = NULL, pr_url = NULL
        WHERE id = ?`,
    )
    .run(WORKER, id);
}

test("a finish written by a runtime replaced under it survives a second process writing the same database, and the witness repairs a reverted row", async (t) => {
  const env = makeHome(t, "terminal-durability");
  makeProject(t, env, "alpha");
  const oldRuntime = copyRuntime(t, "old-runtime");
  const id = runningJob(env);

  const finisher = runChild(
    join(oldRuntime, FINISHER_TRAIL),
    [String(id), WORKER, "alpha", SLUG, String(Date.now() + BARRIER_MS)],
    env,
    { onFirstLine: () => rmSync(oldRuntime, { recursive: true, force: true }) },
  );
  const writer = runChild(WRITER, ["decision", "durability", String(WRITE_MS)], env);
  const [finished, written] = await Promise.all([finisher, writer]);

  assert.equal(finished.code, 0, `the finisher exited ${finished.code}: ${finished.stderr}`);
  assert.equal(written.code, 0, `the concurrent writer exited ${written.code}: ${written.stderr}`);
  const [ready, report] = linesOf(finished);
  assert.equal(report.finished, true, "the finish was refused");
  assert.equal(report.runtimeGone, true, "the tree was still there when the job finished: it was not replaced under the process");
  assert.equal(report.writtenBy, oldRuntime, "the finisher ran from the checkout instead of from the copy");
  assert.doesNotMatch(finished.stderr, /finish verification failed/, `the finish did not survive:\n${finished.stderr}`);

  const row = getJob(id, env);
  assert.equal(row.status, "done");
  assert.equal(row.pr_url, report.prUrl);
  assert.equal(row.finished_at, isoToSqlite(report.finishedAt));
  assert.equal(row.worker, null);
  assert.equal(row.lease_until, null);

  const terminal = readRunState({ project: "alpha", slug: SLUG, env })?.terminal;
  assert.deepEqual(Object.keys(terminal ?? {}), ["status", "prUrl", "finishedAt", "writtenBy", "pid"]);
  assert.deepEqual(terminal, {
    status: "done",
    prUrl: report.prUrl,
    finishedAt: report.finishedAt,
    writtenBy: oldRuntime,
    pid: ready.pid,
  });

  const decisions = openDb(env).prepare("SELECT COUNT(*) AS total FROM decisions WHERE title LIKE 'concurrent %'").get().total;
  assert.equal(decisions, linesOf(written).pop().written, "the writes of the other process were lost");
  assert.ok(decisions > 0, "the other process wrote nothing, so nothing crossed the finish");

  revertFinish(env, id);
  assert.deepEqual(await reconcileFromWitness(env), { repaired: [id], error: null });
  const repaired = getJob(id, env);
  assert.equal(repaired.status, "done");
  assert.equal(repaired.pr_url, report.prUrl);
  assert.equal(repaired.finished_at, isoToSqlite(report.finishedAt));
  assert.equal(JSON.parse(repaired.result).repairedFrom, "state.json");
});
