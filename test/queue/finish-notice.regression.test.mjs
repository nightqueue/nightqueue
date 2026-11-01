import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, fillFinishGaps, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { appendPendingWrite, PENDING_KEYS, replayPendingWrites } from "../../src/queue/pending-writes.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { runOwnNotice } from "../../src/queue/run-notice.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { PR_URL, recordedGate, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const WORKER = "host:1";
const HELD = "the old question";
const SILENT = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
const DELIVERED = { outcome: { status: "done", prUrl: PR_URL } };

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// A home with a job a worker runs, its row already holding a notice from an earlier attempt.
function claimedWithNotice(t, name) {
  const env = makeHome(t, name);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker", slug: SLUG }, env).id;
  claimJobById(id, { worker: WORKER, cap: null }, env);
  openDb(env).prepare("UPDATE jobs SET notice_md = ? WHERE id = ?").run(HELD, id);
  return { env, projectId, id };
}

// Runs the home's one job through a real cycle, with a fake worktree and a clean preflight.
function runJob({ env, id }) {
  return runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });
}

// A home with one job of project `alpha`, the fake `claude` replaying the given spawns.
function runnerHome(t, name, spawns) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), spawns);
  return { env, id: addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id };
}

test("a done finish writes only its own notice: null clears what the row held", (t) => {
  const { env, id } = claimedWithNotice(t, "finish-done-null");
  assert.equal(finishJob(id, { worker: WORKER, status: "done", noticeMd: null, prUrl: PR_URL }, env), true);
  assert.equal(getJob(id, env).notice_md, null);
});

test("a done finish with a notice writes it, the no-change one included", (t) => {
  const { env, id } = claimedWithNotice(t, "finish-done-own");
  assert.equal(finishJob(id, { worker: WORKER, status: "done", noticeMd: "resolved without a change" }, env), true);
  assert.equal(getJob(id, env).notice_md, "resolved without a change");
});

for (const status of ["failed", "gate", "cancelled"]) {
  test(`a ${status} finish with no notice keeps what the row held`, (t) => {
    const { env, id } = claimedWithNotice(t, `finish-${status}-keeps`);
    assert.equal(finishJob(id, { worker: WORKER, status, noticeMd: null }, env), true);
    assert.equal(getJob(id, env).notice_md, HELD);
  });
}

test("a finish queued in an outage follows the same rule when it is replayed", async (t) => {
  const { env, projectId, id } = claimedWithNotice(t, "finish-replayed");
  mkdirSync(runDir(projectId, SLUG, env), { recursive: true });
  const payload = { worker: WORKER, status: "done", noticeMd: null, prUrl: PR_URL };
  const entry = { key: PENDING_KEYS.finish(id, WORKER), kind: "finish", jobId: id, payload };
  assert.equal(appendPendingWrite({ projectId, slug: SLUG, entry, env }).status, "queued");

  await replayPendingWrites({ projectId, slug: SLUG, env, store: openStore(env) });

  const row = getJob(id, env);
  assert.deepEqual([row.status, row.notice_md, row.pr_url], ["done", null, PR_URL]);
});

test("a row at done with a null notice still takes a late one through fillFinishGaps", (t) => {
  const { env, id } = claimedWithNotice(t, "finish-gaps");
  finishJob(id, { worker: WORKER, status: "done", noticeMd: null }, env);
  assert.equal(fillFinishGaps(id, { status: "done", noticeMd: "late notice" }, env), true);
  assert.equal(getJob(id, env).notice_md, "late notice");
});

test("a gate answered and then delivered with no record notice ends done with no notice, and the origins get no conclusion", async (t) => {
  const home = runnerHome(t, "finish-gate-delivered", [{ stdout: SILENT, runState: recordedGate({ notice: HELD }), exitCode: 0 }, { stdout: SILENT, runState: DELIVERED, exitCode: 0 }]);
  await runJob(home);
  assert.equal(getJob(home.id, home.env).notice_md, HELD);
  await applyRetry({ id: home.id, note: "go on", env: home.env });

  await runJob(home);

  const row = getJob(home.id, home.env);
  assert.deepEqual([row.status, row.notice_md, row.pr_url], ["done", null, PR_URL]);
  assert.equal(runOwnNotice(row.notice_md), null);
});

test("a failed attempt retried and delivered does not carry the exit line", async (t) => {
  const home = runnerHome(t, "finish-failed-delivered", [{ stdout: SILENT, exitCode: 1 }, { stdout: SILENT, runState: DELIVERED, exitCode: 0 }]);
  await runJob(home);
  assert.equal(getJob(home.id, home.env).notice_md, "the session exited with code 1");
  await applyRetry({ id: home.id, env: home.env });

  await runJob(home);

  assert.equal(getJob(home.id, home.env).notice_md, null);
});
