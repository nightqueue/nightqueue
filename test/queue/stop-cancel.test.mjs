import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, uptime } from "node:os";
import { test } from "node:test";
import { runnerRegistryPath, runnersDir } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { cancelJobAndWorktree, stopAndCancelJob } from "../../src/queue/cancel.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { recordRunFields } from "../../src/queue/run-state.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { addWorktree, gitVars, makeDirty, publishedCheckout } from "../../test-support/worktrees.mjs";

const PR_URL = "https://github.com/acme/api/pull/7";
const OWNER_PID = 4242;
const OTHER_PID = 5353;
const FAST_STOP = { sleepImpl: async () => {}, pollMs: 1, timeoutMs: 5 };

// A home whose project `alpha` is a published checkout, so a job's worktree can really be released.
function stopHome(t, name) {
  const { checkout } = publishedCheckout(t, name);
  const env = { ...makeHome(t, name), ...gitVars() };
  registerCheckout(env, { path: checkout, name: "alpha" });
  return { env, checkout, store: openStore(env) };
}

// A kill double over pretend pids: it records every signal, and a SIGTERM ends a live pid unless the test says it never dies.
function fakeKill({ alive = [], foreign = [], diesOnTerm = true, termError = null } = {}) {
  const live = new Set(alive);
  const signals = [];
  const kill = (pid, signal) => {
    signals.push([pid, signal]);
    if (foreign.includes(pid)) throw Object.assign(new Error(`kill EPERM ${pid}`), { code: "EPERM" });
    if (!live.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
    if (signal === "SIGTERM" && termError) throw termError;
    if (signal === "SIGTERM" && diesOnTerm) live.delete(pid);
    return true;
  };
  return { kill, terms: () => signals.filter(([, signal]) => signal === "SIGTERM").map(([pid]) => pid) };
}

// The worker a runner of this host with the given pid writes on the rows it claims.
function localWorker(pid) {
  return `${hostname()}:${pid}`;
}

// A job of `alpha` in the given status, owned by the given worker, whose run recorded a clean published worktree of its own.
function seedJob(home, { status = "running", slug, worker = localWorker(OWNER_PID), lease = "+1 hour", prUrl = null }) {
  const worktree = addWorktree(home.checkout, `feat+${slug}`);
  const projectId = ensureProject(home.env, "alpha");
  const id = addJob({ projectId, prompt: `a ${status} job` }, home.env).id;
  const running = status === "running";
  openDb(home.env)
    .prepare(`UPDATE jobs SET status = ?, slug = ?, pr_url = ?, worker = ?, attempts = ?, lease_until = ${running ? `datetime('now', '${lease}')` : "NULL"} WHERE id = ?`)
    .run(status, slug, prUrl, running ? worker : null, running ? 1 : 0, id);
  recordRunFields({ projectId, slug, fields: { worktree: worktree.path }, env: home.env });
  return { id, path: worktree.path };
}

// The raw row of a job, every column, so an untouched row compares equal.
function rawRow(env, id) {
  return openDb(env).prepare("SELECT * FROM jobs WHERE id = ?").get(id);
}

// Registers a live runner under a pid, the way a runner process of this boot does.
function registerRunner(env, pid) {
  writeRunnerRecord({ pid, startedAt: "2026-09-28T10:00:00.000Z", mode: "job" }, env);
  return runnerRegistryPath(pid, env);
}

// Writes a registration file by hand, for the shapes no live runner would leave.
function writeRecordFile(env, pid, text) {
  ensureHome(env);
  mkdirSync(runnersDir(env), { recursive: true });
  writeFileSync(runnerRegistryPath(pid, env), text);
  return runnerRegistryPath(pid, env);
}

// Asserts a stop-and-cancel is refused with the given reason and that the row, the registration file and every process are untouched.
async function assertRefused(home, { id, kill, pattern, recordPath = null }) {
  const row = rawRow(home.env, id);
  const record = recordPath ? readFileSync(recordPath, "utf8") : null;
  await assert.rejects(stopAndCancelJob({ store: home.store, id, env: home.env, killImpl: kill.kill, releaseWorktree: true, ...FAST_STOP }), pattern);
  assert.deepEqual(rawRow(home.env, id), row, "a refused stop-and-cancel wrote the row");
  assert.deepEqual(kill.terms(), [], "a refused stop-and-cancel signalled a process");
  if (recordPath) assert.equal(readFileSync(recordPath, "utf8"), record, "a refused stop-and-cancel touched the registration");
}

test("a job of a live registered runner is cancelled from running, and only its owner is stopped", async (t) => {
  const home = stopHome(t, "stop-cancel-owner");
  const job = seedJob(home, { slug: "owner" });
  registerRunner(home.env, OWNER_PID);
  const otherRecord = registerRunner(home.env, OTHER_PID);
  const kill = fakeKill({ alive: [OWNER_PID, OTHER_PID] });

  const answer = await stopAndCancelJob({ store: home.store, id: job.id, reason: "brief changed", env: home.env, killImpl: kill.kill, ...FAST_STOP });

  assert.equal(answer.job.status, "cancelled");
  assert.equal(answer.job.cancelled_from, "running");
  assert.equal(answer.job.operator_note, "brief changed");
  assert.deepEqual(answer.runner, { outcome: "stopped", pid: OWNER_PID, message: `runner stopped (pid ${OWNER_PID})` });
  assert.equal(answer.worktree, null, "a worktree was released without `releaseWorktree`");
  assert.equal(existsSync(job.path), true);
  assert.deepEqual(kill.terms(), [OWNER_PID], "SIGTERM went to a runner that did not own the job");
  assert.equal(existsSync(otherRecord), true, "the registration of another runner was removed");
  const row = rawRow(home.env, job.id);
  assert.deepEqual({ status: row.status, worker: row.worker, lease: row.lease_until, attempts: row.attempts }, { status: "cancelled", worker: null, lease: null, attempts: 0 });
});

test("with releaseWorktree a clean published worktree is removed and a dirty one is kept with its reason", async (t) => {
  const home = stopHome(t, "stop-cancel-release");
  const clean = seedJob(home, { slug: "clean" });
  registerRunner(home.env, OWNER_PID);
  const cleanAnswer = await stopAndCancelJob({ store: home.store, id: clean.id, releaseWorktree: true, env: home.env, killImpl: fakeKill({ alive: [OWNER_PID] }).kill, ...FAST_STOP });
  assert.equal(cleanAnswer.runner.outcome, "stopped");
  assert.deepEqual(cleanAnswer.worktree, { path: clean.path, status: "removed" });
  assert.equal(existsSync(clean.path), false);

  const dirty = seedJob(home, { slug: "dirty", worker: localWorker(OTHER_PID) });
  makeDirty(dirty.path);
  registerRunner(home.env, OTHER_PID);
  const dirtyAnswer = await stopAndCancelJob({ store: home.store, id: dirty.id, releaseWorktree: true, env: home.env, killImpl: fakeKill({ alive: [OTHER_PID] }).kill, ...FAST_STOP });
  assert.equal(dirtyAnswer.runner.outcome, "stopped");
  assert.equal(dirtyAnswer.worktree.status, "kept");
  assert.equal(dirtyAnswer.worktree.path, dirty.path);
  assert.equal(typeof dirtyAnswer.worktree.reason, "string");
  assert.ok(dirtyAnswer.worktree.reason.length > 0, "a kept worktree carries no reason");
  assert.equal(existsSync(dirty.path), true);
});

test("a runner that does not stop leaves the job cancelled and its worktree where it is", async (t) => {
  const home = stopHome(t, "stop-cancel-alive");
  const job = seedJob(home, { slug: "stubborn" });
  registerRunner(home.env, OWNER_PID);
  const kill = fakeKill({ alive: [OWNER_PID], diesOnTerm: false });

  const answer = await stopAndCancelJob({ store: home.store, id: job.id, releaseWorktree: true, env: home.env, killImpl: kill.kill, ...FAST_STOP });

  assert.equal(answer.job.status, "cancelled");
  assert.equal(answer.runner.outcome, "alive");
  assert.equal(answer.runner.pid, OWNER_PID);
  assert.match(answer.runner.message, new RegExp(`job \`${job.id}\` is already cancelled`));
  assert.equal(answer.worktree, null, "a worktree was released while its runner may still write in it");
  assert.equal(existsSync(job.path), true);
  assert.equal(rawRow(home.env, job.id).status, "cancelled");
});

test("a registration of another user is refused: nothing is signalled or written and the file stays", async (t) => {
  const home = stopHome(t, "stop-cancel-foreign");
  const job = seedJob(home, { slug: "foreign" });
  const recordPath = registerRunner(home.env, OWNER_PID);
  const kill = fakeKill({ foreign: [OWNER_PID] });
  await assertRefused(home, { id: job.id, kill, recordPath, pattern: /names a process of another user; nightqueue will not signal it/ });
  assert.equal(existsSync(recordPath), true);
});

test("a pid with no registration is refused whether it answers or not", async (t) => {
  const home = stopHome(t, "stop-cancel-unregistered");
  const job = seedJob(home, { slug: "unregistered" });
  const pattern = /is held by pid 4242, which is not a live runner of this home \(no runner is registered with that pid\); nothing was signalled or written/;
  await assertRefused(home, { id: job.id, kill: fakeKill({ alive: [OWNER_PID] }), pattern });
  await assertRefused(home, { id: job.id, kill: fakeKill(), pattern });
});

test("a stale registration is refused and left on disk: nothing is written on a refusal", async (t) => {
  const home = stopHome(t, "stop-cancel-stale");
  const job = seedJob(home, { slug: "stale" });
  const pattern = /not a live runner of this home \(its registration is stale\)/;
  const goneRecord = registerRunner(home.env, OWNER_PID);
  await assertRefused(home, { id: job.id, kill: fakeKill(), recordPath: goneRecord, pattern });
  assert.equal(existsSync(goneRecord), true, "the refusal pruned the stale registration of a gone pid");

  const beforeBoot = JSON.stringify({ pid: OWNER_PID, startedAt: "2026-09-01T00:00:00.000Z", mode: "job", uptimeS: Math.round(uptime()) + 100000 });
  const bootRecord = writeRecordFile(home.env, OWNER_PID, `${beforeBoot}\n`);
  await assertRefused(home, { id: job.id, kill: fakeKill({ alive: [OWNER_PID] }), recordPath: bootRecord, pattern });
  assert.equal(existsSync(bootRecord), true, "the refusal pruned the registration written before this boot");
});

test("an unreadable registration is refused and left on disk", async (t) => {
  const home = stopHome(t, "stop-cancel-unreadable");
  const job = seedJob(home, { slug: "unreadable" });
  const recordPath = writeRecordFile(home.env, OWNER_PID, "{ not json");
  await assertRefused(home, { id: job.id, kill: fakeKill({ alive: [OWNER_PID] }), recordPath, pattern: /its registration cannot be read/ });
  assert.equal(existsSync(recordPath), true);
});

test("a worker of another host is refused, live lease or not, and the plain cancel is the way out of an orphan", async (t) => {
  const home = stopHome(t, "stop-cancel-other-host");
  const pattern = /is running on worker `other-host:4242`, a runner of host `other-host`; nightqueue only stops a runner of this host/;
  const live = seedJob(home, { slug: "other-live", worker: "other-host:4242" });
  await assertRefused(home, { id: live.id, kill: fakeKill({ alive: [OWNER_PID] }), pattern });

  const orphan = seedJob(home, { slug: "other-orphan", worker: "other-host:4242", lease: "-1 hour" });
  await assertRefused(home, { id: orphan.id, kill: fakeKill({ alive: [OWNER_PID] }), pattern });
  const plain = await cancelJobAndWorktree({ store: home.store, id: orphan.id, env: home.env });
  assert.equal(plain.job.status, "cancelled");
  assert.equal(plain.job.cancelled_from, "running");
});

test("a malformed worker is refused and the row is untouched", async (t) => {
  const home = stopHome(t, "stop-cancel-malformed");
  const job = seedJob(home, { slug: "malformed", worker: "no-pid-here" });
  await assertRefused(home, { id: job.id, kill: fakeKill(), pattern: /is running on worker `no-pid-here`, which does not name a process of this host/ });
});

test("an unknown job is refused", async (t) => {
  const home = stopHome(t, "stop-cancel-unknown");
  await assert.rejects(stopAndCancelJob({ store: home.store, id: 999, env: home.env, killImpl: fakeKill().kill, ...FAST_STOP }), /unknown job `999`/);
});

test("a job that is not running follows the plain cancel, with runner null and no signal", async (t) => {
  const home = stopHome(t, "stop-cancel-not-running");
  const kill = fakeKill({ alive: [OWNER_PID] });
  registerRunner(home.env, OWNER_PID);
  const expected = { pending: { from: "pending", released: false }, gate: { from: "gate", released: false }, done: { from: "done", released: true } };
  for (const [status, { from, released }] of Object.entries(expected)) {
    const job = seedJob(home, { status, slug: `plain-${status}`, prUrl: status === "done" ? PR_URL : null });
    const answer = await stopAndCancelJob({ store: home.store, id: job.id, releaseWorktree: true, env: home.env, killImpl: kill.kill, ...FAST_STOP });
    assert.equal(answer.runner, null);
    assert.equal(answer.job.status, "cancelled");
    assert.equal(answer.job.cancelled_from, from);
    assert.deepEqual(answer.worktree, released ? { path: job.path, status: "removed" } : null, `the ${status} cancel released by the wrong rule`);
    assert.equal(existsSync(job.path), !released);
  }
  assert.deepEqual(kill.terms(), []);
});

// A store whose first read of a job runs the given move right after it, so the row changes between the read and the write.
function storeMovingAfterFirstRead(store, move) {
  let moved = false;
  const getJob = async (id) => {
    const row = await store.jobs.getJob(id);
    if (!moved) {
      moved = true;
      await move(row);
    }
    return row;
  };
  return { ...store, jobs: { ...store.jobs, getJob } };
}

test("a job that finishes between the read and the write is cancelled as done on the next round, with no signal", async (t) => {
  const home = stopHome(t, "stop-cancel-finished");
  const job = seedJob(home, { slug: "finished" });
  registerRunner(home.env, OWNER_PID);
  const kill = fakeKill({ alive: [OWNER_PID] });
  const store = storeMovingAfterFirstRead(home.store, (row) => home.store.jobs.finishJob(row.id, { worker: row.worker, status: "done", prUrl: PR_URL }));

  const answer = await stopAndCancelJob({ store, id: job.id, env: home.env, killImpl: kill.kill, ...FAST_STOP });

  assert.equal(answer.runner, null);
  assert.equal(answer.job.cancelled_from, "done");
  assert.deepEqual(answer.worktree, { path: job.path, status: "removed" });
  assert.deepEqual(kill.terms(), []);
});

test("a job re-claimed by another live runner between rounds stops only its new owner", async (t) => {
  const home = stopHome(t, "stop-cancel-reclaimed");
  const job = seedJob(home, { slug: "reclaimed" });
  registerRunner(home.env, OWNER_PID);
  registerRunner(home.env, OTHER_PID);
  const kill = fakeKill({ alive: [OWNER_PID, OTHER_PID] });
  const reclaim = () => openDb(home.env).prepare("UPDATE jobs SET worker = ? WHERE id = ?").run(localWorker(OTHER_PID), job.id);
  const store = storeMovingAfterFirstRead(home.store, reclaim);

  const answer = await stopAndCancelJob({ store, id: job.id, env: home.env, killImpl: kill.kill, ...FAST_STOP });

  assert.equal(answer.job.status, "cancelled");
  assert.deepEqual({ outcome: answer.runner.outcome, pid: answer.runner.pid }, { outcome: "stopped", pid: OTHER_PID });
  assert.deepEqual(kill.terms(), [OTHER_PID], "the runner that lost the job was signalled");
});

test("a job that keeps changing hands is refused after the last round, with nothing cancelled or signalled", async (t) => {
  const home = stopHome(t, "stop-cancel-churn");
  const job = seedJob(home, { slug: "churn" });
  registerRunner(home.env, OWNER_PID);
  registerRunner(home.env, OTHER_PID);
  const kill = fakeKill({ alive: [OWNER_PID, OTHER_PID] });
  const swap = (row) => (row.worker === localWorker(OWNER_PID) ? localWorker(OTHER_PID) : localWorker(OWNER_PID));
  const getJob = async (id) => {
    const row = await home.store.jobs.getJob(id);
    openDb(home.env).prepare("UPDATE jobs SET worker = ? WHERE id = ?").run(swap(row), id);
    return row;
  };
  const store = { ...home.store, jobs: { ...home.store.jobs, getJob } };

  await assert.rejects(stopAndCancelJob({ store, id: job.id, env: home.env, killImpl: kill.kill, ...FAST_STOP }), /changed hands while it was being stopped; nothing was cancelled - call again/);
  assert.equal(rawRow(home.env, job.id).status, "running");
  assert.deepEqual(kill.terms(), []);
});

test("a stop that throws still answers the cancelled job, as `error`, and releases no worktree", async (t) => {
  const home = stopHome(t, "stop-cancel-error");
  const job = seedJob(home, { slug: "error" });
  registerRunner(home.env, OWNER_PID);
  const termError = Object.assign(new Error("kill EPERM on SIGTERM"), { code: "EPERM" });
  const kill = fakeKill({ alive: [OWNER_PID], termError });

  const answer = await stopAndCancelJob({ store: home.store, id: job.id, releaseWorktree: true, env: home.env, killImpl: kill.kill, ...FAST_STOP });

  assert.equal(answer.job.status, "cancelled");
  assert.equal(answer.runner.outcome, "error");
  assert.equal(answer.runner.pid, OWNER_PID);
  assert.match(answer.runner.message, /could not stop the runner \(pid 4242\)/);
  assert.equal(answer.worktree, null);
  assert.equal(existsSync(job.path), true);
  assert.equal(rawRow(home.env, job.id).status, "cancelled");
});
