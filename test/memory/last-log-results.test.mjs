import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireClose, lastLogResults, settleClose } from "../../src/memory/jobs.mjs";
import { openStoreReadOnly } from "../../src/store/open.mjs";
import { makeHome, mergedChecklist, projectIdOf, seedDoneJob } from "../../test-support/memory.mjs";

const WORKER = "test:last-log";

// Closes a seeded job of a project with a merged checklist carrying the given log step, and answers its id.
function closeWithLog(env, project, log) {
  const id = seedDoneJob(env, { project });
  if (!acquireClose(id, { worker: WORKER, leaseS: 600 }, env)) throw new Error(`job #${id} refused the close lease`);
  const checklist = mergedChecklist();
  const close = log ? { ...checklist, steps: { ...checklist.steps, log } } : checklist;
  if (!settleClose(id, { worker: WORKER, close, noticeLine: checklist.data.noticeLine }, env)) throw new Error(`job #${id} refused the settle`);
  return id;
}

// The last log result of one project, by name.
function resultOf(env, project) {
  return lastLogResults(env).find((entry) => entry.projectId === projectIdOf(env, project)) ?? null;
}

test("each log step status maps to a last notice: done ok, warning and a discord skip failed, other skips and running ignored", (t) => {
  const env = makeHome(t, "last-log-statuses");
  const at = "2026-10-08T18:02:00.000Z";
  const done = closeWithLog(env, "done", { status: "done", note: "discord: logged through dlw-log", at });
  const warned = closeWithLog(env, "warned", { status: "warning", note: "discord: log not posted through dlw-log (HTTP 404)", at });
  const dangling = closeWithLog(env, "dangling", { status: "skipped", note: "discord: connection `ghost` is not bound", at });
  closeWithLog(env, "none", { status: "skipped", note: "no log destination", at });
  closeWithLog(env, "running", { status: "running", note: "posting", at });
  closeWithLog(env, "nolog", null);
  assert.deepEqual(resultOf(env, "done"), { projectId: projectIdOf(env, "done"), jobId: done, at, ok: true, note: "discord: logged through dlw-log" });
  assert.deepEqual([resultOf(env, "warned").jobId, resultOf(env, "warned").ok], [warned, false]);
  assert.deepEqual([resultOf(env, "dangling").jobId, resultOf(env, "dangling").ok], [dangling, false]);
  for (const project of ["none", "running", "nolog"]) assert.equal(resultOf(env, project), null, project);
});

test("the newest log step of a project wins, whatever the job order", (t) => {
  const env = makeHome(t, "last-log-newest");
  const newer = closeWithLog(env, "alpha", { status: "warning", note: "discord: refused", at: "2026-10-09T10:00:00.000Z" });
  closeWithLog(env, "alpha", { status: "done", note: "discord: logged", at: "2026-10-01T10:00:00.000Z" });
  assert.deepEqual([resultOf(env, "alpha").jobId, resultOf(env, "alpha").ok], [newer, false]);
});

test("a log step of an unexpected shape never fails the read, and the read-only store serves it", async (t) => {
  const env = makeHome(t, "last-log-malformed");
  const good = closeWithLog(env, "alpha", { status: "done", note: "discord: logged", at: "2026-10-01T10:00:00.000Z" });
  closeWithLog(env, "beta", "garbled");
  closeWithLog(env, "gamma", { status: 5, at: "2026-10-01T10:00:00.000Z" });
  closeWithLog(env, "delta", { status: "done", note: "discord: logged" });
  closeWithLog(env, "epsilon", { status: "done", note: ["discord"], at: 42 });
  assert.deepEqual(lastLogResults(env).map((entry) => entry.jobId), [good]);
  const store = openStoreReadOnly(env);
  assert.deepEqual((await store.jobs.lastLogResults()).map((entry) => entry.jobId), [good]);
});
