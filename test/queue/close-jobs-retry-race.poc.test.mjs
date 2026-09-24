import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob, retryJob, settleClose } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject, mergedChecklist } from "../../test-support/memory.mjs";

// H1a — src/memory/jobs.mjs (acquireClose, settleClose)
//
// The race this file once exercised - a `--force`-closed `failed` job reopened by a concurrent `queue retry` while its
// close was in flight - can no longer be set up: a close only ever starts from `done`, with or without force, and
// `queue retry` refuses a `done` job outright. What stays provable is both halves of that fence, and that a settle
// whose row moved out of `done` under it still refuses instead of closing the job.
test("a failed job is never force-acquired, a done job under a close is never reopened by retry, and a moved row refuses the settle", (t) => {
  const env = makeHome(t, "close-jobs-retry-race");
  makeProject(t, env, "alpha");
  const failed = addJob({ project: "alpha", prompt: "fix the parser" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'failed', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/8", failed);
  assert.equal(acquireClose(failed, { worker: "close:test:1:aaaa", leaseS: 660, force: true }, env), null, "a failed job took a close lease");

  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/7", id);
  const worker = "close:test:1:aaaa";
  assert.ok(acquireClose(id, { worker, leaseS: 660 }, env), "a done job must take the close lease");
  assert.throws(() => retryJob(id, {}, env), /cannot be retried from status `done`/);

  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(id);
  const checklist = mergedChecklist();
  assert.equal(settleClose(id, { worker, close: checklist, noticeLine: checklist.data.noticeLine }, env), null, "a settle closed a job that left `done`");

  const after = getJob(id, env);
  assert.equal(after.status, "failed");
  assert.equal(after.close_status, "closing", "a refused settle must not clear the lease it never released");
  assert.equal(after.close_worker, worker);
  assert.ok(after.close_lease_until, "the lease timestamp must remain untouched by the refused settle");
});
