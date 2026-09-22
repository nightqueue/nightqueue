import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { acquireShip, addJob, getJob, retryJob, settleShip } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// H1a — src/memory/jobs.mjs:780-800 (settleShip)
//
// The plan explicitly declines to guard `queue retry` against a live ship lease (Usage coverage line 158),
// relying on settleShip's own status allowlist to refuse gracefully instead of silently closing a job an
// operator just reopened. A job cannot be force-shipped from `done` (acquireShip's WHERE only allows a plain
// ship from `done`, never a race with retry since retryJob refuses a `done` job outright), so the only job
// state where "acquire a ship lease, then a concurrent retry reopens the same job" is a real, exercisable
// race is a `--force`-shipped `failed` (or `gate`) job: acquireShip never touches the `status` column, so a
// job forced into shipping straight from `failed` is still `failed` in the eyes of a concurrent `queue retry`.
test("a concurrent retry reopening a force-shipped failed job makes settleShip refuse instead of silently closing it", (t) => {
  const env = makeHome(t, "ship-jobs-retry-race");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'failed', pr_url = ? WHERE id = ?").run("https://github.com/acme/api/pull/7", id);

  const worker = "ship:test:1:aaaa";
  const acquired = acquireShip(id, { worker, leaseS: 660, force: true }, env);
  assert.ok(acquired, "the ship must be able to force-acquire a failed job's lease");
  assert.equal(acquired.status, "failed", "acquireShip never touches the job status column before settle");

  // Simulate a concurrent operator `queue retry <id>` racing the ship that is already in flight.
  const retried = retryJob(id, {}, env);
  assert.equal(retried.status, "pending", "the concurrent retry must actually reopen the job for the race to be real");

  const settled = settleShip(id, { worker, ship: JSON.parse(acquired.ship), noticeLine: "Shipped: PR #7 merged as abc1234 on 2026-09-21" }, env);

  assert.equal(settled, null, "settleShip must refuse once the job left the terminal-status allowlist under it, never return a row");

  const after = getJob(id, env);
  assert.equal(after.status, "pending", "the job must stay pending/reopened by the retry, never silently closed by the stale ship");
  assert.notEqual(after.status, "closed");
  assert.equal(after.ship_status, "shipping", "a refused settle must not clear the ship lease it never released");
  assert.equal(after.ship_worker, worker, "the ship's own lease bookkeeping must survive a refused settle");
  assert.ok(after.ship_lease_until, "the lease timestamp must remain untouched by the refused settle");
});
