import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob, noteRespawn, sweepOrphans } from "../../src/memory/jobs.mjs";
import { acquire } from "../../src/queue/claim.mjs";
import { orphanNoticeTail } from "../../src/queue/classify.mjs";
import { claimRunState, writeRunTerminal } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordOutcome } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { PR_URL, recordedDone, recordedGate, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const DEAD_WORKER = "host:6666";
const CAP = 4;

// A home with two registered projects and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  return env;
}

// Enqueues a job and claims it for a runner that is about to be declared dead.
function claimedJob(env, { project = "alpha" } = {}) {
  const id = addJob({ projectId: ensureProject(env, project), prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: DEAD_WORKER, cap: CAP }, env);
  return id;
}

// Moves the lease of a job past the reclaim grace, which is how a runner that died looks from the outside.
function expireLease(env, id) {
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
}

// The notice a sweep must leave for this attempt, worker and lease.
function orphanNotice({ attempt, worker, lease }) {
  return `the runner died during attempt ${attempt} (worker ${worker}, lease until ${lease}); nothing was requeued - send it back with nightqueue queue retry`;
}

// Gives a running job a run directory whose state.json holds the given record, as a run that died after writing it leaves behind.
function seedRunRecord(env, { id, project, record }) {
  const dir = runDir(ensureProject(env, project), SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 1, slug: SLUG, ...record }));
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

test("an orphan always ends failed: its attempts kept, its row released and a notice naming attempt, worker and lease", (t) => {
  const env = makeQueue(t, "orphan-fails");
  const id = claimedJob(env);
  noteRespawn(id, { worker: DEAD_WORKER }, env);
  expireLease(env, id);
  const lease = openDb(env).prepare("SELECT lease_until FROM jobs WHERE id = ?").get(id).lease_until;
  assert.ok(lease, "the fixture did not leave a lease to name");

  assert.deepEqual(sweepOrphans(env), { failed: 1 });
  const row = getJob(id, env);
  assert.deepEqual(
    { status: row.status, attempts: row.attempts, worker: row.worker, lease: row.lease_until, attempt: row.attempt_started_at },
    { status: "failed", attempts: 1, worker: null, lease: null, attempt: null },
  );
  assert.equal(row.notice_md, orphanNotice({ attempt: 1, worker: DEAD_WORKER, lease }));
  assert.deepEqual(JSON.parse(row.result), { orphaned: true });
  assert.ok(row.finished_at, "the failed orphan has no finished_at");
  assert.ok(row.started_at, "the sweep forgot the first start of the job");
  assert.deepEqual(
    row.attempt_rows.map((attempt) => ({ attempt: attempt.attempt, outcome: attempt.outcome, exit: attempt.exit_reason, spawns: attempt.spawns, open: attempt.finished_at === null })),
    [{ attempt: 1, outcome: "lost", exit: "orphaned", spawns: 2, open: false }],
  );
  assert.deepEqual(sweepOrphans(env), { failed: 0 }, "the sweep touched a job that already ended");
});

test("an orphan with no lease or no worker on its row still gets a whole notice", (t) => {
  const env = makeQueue(t, "orphan-null-facts");
  const noLease = claimedJob(env);
  const noWorker = claimedJob(env, { project: "beta" });
  const db = openDb(env);
  db.prepare("UPDATE jobs SET lease_until = NULL WHERE id = ?").run(noLease);
  db.prepare("UPDATE jobs SET lease_until = NULL, worker = NULL WHERE id = ?").run(noWorker);

  assert.deepEqual(sweepOrphans(env), { failed: 2 });
  assert.equal(getJob(noLease, env).notice_md, orphanNotice({ attempt: 1, worker: DEAD_WORKER, lease: "never" }));
  assert.equal(getJob(noWorker, env).notice_md, orphanNotice({ attempt: 1, worker: "unknown", lease: "never" }));
});

test("the notice of a swept orphan is searchable", (t) => {
  const env = makeQueue(t, "orphan-fts");
  const id = claimedJob(env);
  expireLease(env, id);

  sweepOrphans(env);

  const found = openDb(env).prepare("SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH 'notice:requeued'").all();
  assert.deepEqual(found.map((row) => row.rowid), [id]);
});

test("the sweep only touches a running job whose lease is gone", (t) => {
  const env = makeQueue(t, "orphan-scope");
  const alive = claimedJob(env);
  const pending = addJob({ projectId: ensureProject(env, "alpha"), prompt: "another one" }, env).id;
  const dead = claimedJob(env, { project: "beta" });
  expireLease(env, dead);

  assert.deepEqual(sweepOrphans(env), { failed: 1 });
  assert.equal(getJob(alive, env).status, "running", "a job with a live lease was failed");
  assert.equal(getJob(alive, env).worker, DEAD_WORKER);
  assert.equal(getJob(alive, env).notice_md, null, "a job with a live lease got the notice");
  assert.equal(getJob(pending, env).status, "pending");
  assert.equal(getJob(dead, env).status, "failed");
});

test("a job that keeps re-arming its lease is never swept while its re-spawn loop runs", (t) => {
  const env = makeQueue(t, "orphan-alive");
  const id = claimedJob(env);
  expireLease(env, id);
  assert.equal(noteRespawn(id, { worker: DEAD_WORKER }, env), true, "the re-spawn could not re-arm the lease");

  assert.deepEqual(sweepOrphans(env), { failed: 0 });
  assert.equal(getJob(id, env).status, "running");
  assert.equal(getJob(id, env).worker, DEAD_WORKER);
});

test("a claim sweeps first and never takes the orphan: the job behind it runs, and alone it reads as an empty queue", async (t) => {
  const env = makeQueue(t, "orphan-acquire");
  const orphan = claimedJob(env);
  expireLease(env, orphan);
  const next = addJob({ projectId: ensureProject(env, "beta"), prompt: "another one" }, env).id;

  const claimed = await acquire({ cap: CAP, env });

  assert.equal(claimed.job?.id, next);
  assert.equal(getJob(orphan, env).status, "failed");
  assert.equal(getJob(orphan, env).attempts, 1, "the sweep spent an attempt");
  assert.equal(getJob(orphan, env).attempt_rows.length, 1, "the orphan opened another attempt row");
  assert.equal((await acquire({ cap: CAP, env })).reason, "empty-queue");
});

test("a claim by id refuses a job the sweep just failed", async (t) => {
  const env = makeQueue(t, "orphan-acquire-id");
  const id = claimedJob(env);
  expireLease(env, id);

  assert.deepEqual(await acquire({ jobId: id, cap: CAP, env }), { job: null, reason: "not-pending" });
  assert.equal(getJob(id, env).status, "failed");
});

test("a sweep quotes what each orphan's own run recorded: a throw, no slug or a foreign stamp never block it nor land on the wrong row", async (t) => {
  const env = makeQueue(t, "orphan-quotes");
  const [gated, noSlug, foreign, thrown] = [claimedJob(env), claimedJob(env), claimedJob(env), claimedJob(env)];
  const projectId = ensureProject(env, "alpha");
  const db = openDb(env);
  for (const [id, slug] of [[gated, "run-gated"], [foreign, "run-foreign"], [thrown, "run-thrown"]]) db.prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  recordOutcome({ projectId, slug: "run-gated", status: "gate", notice: "Which branch?", env });
  recordOutcome({ projectId, slug: "run-foreign", status: "gate", notice: "Somebody else's question", env });
  writeRunTerminal({ projectId, slug: "run-foreign", terminal: { status: "gate", jobId: thrown + 1 }, env });
  for (const id of [gated, noSlug, foreign, thrown]) expireLease(env, id);
  const tailOf = (row) => {
    if (row.id === thrown) throw new Error("unreadable");
    return orphanNoticeTail(claimRunState({ projectId: row.project_id, slug: row.slug, jobId: row.id, attempt: row.attempts, env }));
  };

  assert.deepEqual(sweepOrphans(env, { orphanTailImpl: tailOf }), { failed: 4 });

  assert.match(getJob(gated, env).notice_md, /^the runner died during attempt 1 .*\n\nit had recorded a gate: Which branch\?$/);
  for (const id of [noSlug, foreign, thrown]) {
    assert.equal(getJob(id, env).status, "failed");
    assert.equal(getJob(id, env).notice_md.includes("it had recorded"), false, getJob(id, env).notice_md);
  }
});

test("a swept orphan quotes only a record of its own attempt and names the one it ignored", async (t) => {
  const env = makeQueue(t, "orphan-stale-record");
  const [own, stale] = [claimedJob(env), claimedJob(env)];
  const projectId = ensureProject(env, "alpha");
  const db = openDb(env);
  for (const [id, slug] of [[own, "run-own"], [stale, "run-stale"]]) db.prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  recordOutcome({ projectId, slug: "run-own", status: "gate", notice: "My own question?", claim: { attempt: 1, session: null }, env });
  db.prepare("UPDATE jobs SET attempts = 2 WHERE id = ?").run(stale);
  recordOutcome({ projectId, slug: "run-stale", status: "gate", notice: "An older question?", claim: { attempt: 1, session: null }, env });
  for (const id of [own, stale]) expireLease(env, id);

  await acquire({ cap: CAP, env });

  assert.match(getJob(own, env).notice_md, /\n\nit had recorded a gate: My own question\?$/);
  const notice = getJob(stale, env).notice_md;
  assert.equal(notice.includes("An older question?"), false, notice);
  assert.match(notice, /^the runner died during attempt 2 .*\n\nignored a record of attempt 1$/);
});

test("the real sweep of a claim quotes a recorded gate", async (t) => {
  const env = makeQueue(t, "orphan-quote-acquire");
  const id = claimedJob(env);
  seedRunRecord(env, { id, project: "alpha", record: recordedGate({ notice: "Which branch?" }) });
  expireLease(env, id);

  await acquire({ cap: CAP, env });

  assert.ok(getJob(id, env).notice_md.endsWith("it had recorded a gate: Which branch?"), getJob(id, env).notice_md);
});

test("a run that recorded done before its runner died ends failed, and a retry that records nothing fails with the pull request on the row", async (t) => {
  const env = makeQueue(t, "orphan-recorded");
  const silent = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
  useFakeClaude(env, makeDir(t, "orphan-recorded-plan"), [{ stdout: silent, exitCode: 0 }]);
  const id = claimedJob(env);
  seedRunRecord(env, { id, project: "alpha", record: recordedDone({ notice: "the pull request is open" }) });
  expireLease(env, id);

  assert.equal((await acquire({ cap: CAP, env })).reason, "empty-queue");
  assert.equal(getJob(id, env).status, "failed", "a recorded outcome spared the orphan");
  assert.ok(getJob(id, env).notice_md.startsWith("the runner died during attempt 1"), getJob(id, env).notice_md);

  await applyRetry({ id, env });
  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });

  assert.deepEqual([cycle.processed[0].status, cycle.processed[0].prUrl], ["failed", PR_URL], JSON.stringify(cycle.processed));
  assert.equal(getJob(id, env).attempts, 2);
});
