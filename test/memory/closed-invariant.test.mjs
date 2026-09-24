import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, claimJobById, finishJob, getJob, reclassifyJob, repairJobFromWitness, settleClose } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject, mergedChecklist, seedDoneJob } from "../../test-support/memory.mjs";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));
const WORKER = "host:1";
const CLOSER = "close:host:1:aaaa";
const PR_URL = "https://github.com/acme/api/pull/7";
const PIPELINE_ONLY = /status `closed` is written only by the closing pipeline; run nightshift queue close <id>/;
const CLOSED_WRITE = /SET\s+status\s*=\s*'closed'|,\s*status\s*=\s*'closed'|status\s*=\s*'closed'\s*,/g;
const CLOSED_WRITERS = { "memory/jobs.mjs": 1, "memory/close-migration.mjs": 2 };

// A home with project `alpha` registered.
function invariantHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// A job the given worker is running, the row every generic status writer starts from.
function runningJob(env) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: null }, env);
  return id;
}

// Every .mjs file under a directory, recursively.
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".mjs") ? [path] : [];
  });
}

test("the generic status writers refuse `closed` by name and leave the row as it was", (t) => {
  const env = invariantHome(t, "invariant-writers");
  const running = runningJob(env);
  const before = getJob(running, env);
  assert.throws(() => finishJob(running, { worker: WORKER, status: "closed", prUrl: PR_URL }, env), PIPELINE_ONLY);
  assert.throws(() => repairJobFromWitness(running, { status: "closed", prUrl: PR_URL }, env), PIPELINE_ONLY);
  assert.deepEqual(getJob(running, env), before);

  const failed = runningJob(env);
  finishJob(failed, { worker: WORKER, status: "failed", prUrl: PR_URL }, env);
  const failedBefore = getJob(failed, env);
  assert.throws(() => reclassifyJob(failed, { status: "closed", prUrl: PR_URL }, env), PIPELINE_ONLY);
  assert.deepEqual(getJob(failed, env), failedBefore);
});

test("raw SQL cannot write a closed row without a pull request and a recorded merge", (t) => {
  const env = invariantHome(t, "invariant-raw-sql");
  const id = seedDoneJob(env, { prUrl: PR_URL });
  const db = openDb(env);
  const before = getJob(id, env);
  assert.throws(() => db.prepare("UPDATE jobs SET status = 'closed' WHERE id = ?").run(id), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE jobs SET status = 'closed', close = '{\"data\":{\"merged\":false}}' WHERE id = ?").run(id), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE jobs SET status = 'closed', close = '{\"data\":{\"merged\":\"true\"}}' WHERE id = ?").run(id), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE jobs SET status = 'closed', close = 'not json' WHERE id = ?").run(id), /CHECK constraint failed/);
  assert.deepEqual(getJob(id, env), before);

  const merged = JSON.stringify(mergedChecklist());
  const insert = "INSERT INTO jobs (project, prompt, status, pr_url, close, close_status) VALUES ('alpha', 'raw', 'closed', ?, ?, ?)";
  assert.throws(() => db.prepare(insert).run(null, merged, null), /CHECK constraint failed/);
  assert.throws(() => db.prepare(insert).run("", merged, null), /CHECK constraint failed/);
  assert.throws(() => db.prepare(insert).run("   ", merged, null), /CHECK constraint failed/);
  assert.throws(() => db.prepare(insert).run(PR_URL, null, null), /CHECK constraint failed/);
  assert.throws(() => db.prepare(insert).run(PR_URL, merged, "closing"), /CHECK constraint failed/);
});

test("a settle whose checklist records no merge is refused by the schema and the job stays done under its lease", (t) => {
  const env = invariantHome(t, "invariant-settle");
  const id = seedDoneJob(env, { prUrl: PR_URL });
  assert.ok(acquireClose(id, { worker: CLOSER, leaseS: 660 }, env));
  const unmerged = { attempts: 1, steps: {}, data: { mergeSha: "abc1234def" } };

  assert.throws(() => settleClose(id, { worker: CLOSER, close: unmerged, noticeLine: "Closed: PR #7 merged as abc1234 on 2026-09-21" }, env), /CHECK constraint failed/);

  const row = getJob(id, env);
  assert.deepEqual([row.status, row.close_status, row.close_worker], ["done", "closing", CLOSER]);
});

test("the one way into closed is the close lease plus a settle recording the merge", (t) => {
  const env = invariantHome(t, "invariant-settle-ok");
  const id = seedDoneJob(env, { prUrl: PR_URL });
  assert.ok(acquireClose(id, { worker: CLOSER, leaseS: 660 }, env));
  const checklist = mergedChecklist();

  const settled = settleClose(id, { worker: CLOSER, close: checklist, noticeLine: checklist.data.noticeLine }, env);

  assert.equal(settled.status, "closed");
  assert.equal(settled.close.data.merged, true);
  assert.equal(settled.pr_url, PR_URL);
});

test("no source file writes the closed status except the settle of the closing pipeline and the close migration", () => {
  const found = {};
  for (const path of sourceFiles(SRC)) {
    const text = readFileSync(path, "utf8");
    const writes = text.match(CLOSED_WRITE)?.length ?? 0;
    if (writes) found[relative(SRC, path)] = writes;
    assert.equal(/status:\s*["']closed["']/.test(text), false, `${relative(SRC, path)} hands the closed status to a writer`);
  }
  assert.deepEqual(found, CLOSED_WRITERS);
});
