import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { runnerRegistryPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject, seedClosedJob } from "../../test-support/memory.mjs";
import { fakeCloseDeps, mergedPr, openPr, CLOSE_PR_URL } from "../../test-support/close.mjs";

const CHILD_PID = 4242;
const PR_URL = CLOSE_PR_URL;
const RED_CHECKS = { ok: true, checks: [{ name: "lint", bucket: "fail" }], failing: ["lint"], pending: [] };

// Close doubles whose pull request is open with a failing check, the stop every test of this file resumes from.
function redChecksDeps() {
  return fakeCloseDeps({ checks: RED_CHECKS }).deps;
}

// A spawn double: it records every call and answers with a child that has a pid, or throws the failure it was given.
function fakeSpawn(calls, { pid = CHILD_PID, fail = null } = {}) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    if (fail) throw fail;
    return { pid, unref: () => {} };
  };
}

// A kill double that answers only for the pids the test says are alive, and never signals a real process.
function fakeKill(alive) {
  return (pid) => {
    if (!alive.has(pid)) throw Object.assign(new Error(`kill ESRCH ${pid}`), { code: "ESRCH" });
    return true;
  };
}

// Runs the CLI in this process with the spawn and the kill of the test injected.
async function runCli(env, argv, { calls = [], spawnImpl = null, alive = new Set(), closeDeps = redChecksDeps() } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    spawnImpl: spawnImpl ?? fakeSpawn(calls),
    killImpl: fakeKill(alive),
    closeDeps,
  };
  const code = await run(argv, ctx);
  return { code, out, err, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

// A home with the project `alpha` registered, the one every job of this file belongs to.
function makeCloseHome(t, name) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  return { env, checkout };
}

// A job of `alpha` in the given status, carrying the given pull request.
function jobIn(env, { status = "done", prUrl = PR_URL, project = "alpha", branch = "fix/worker" } = {}) {
  const id = addJob({ project, prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = ?, pr_url = ?, branch = ?, worker = 'host:1' WHERE id = ?").run(status, prUrl, branch, id);
  return id;
}

test("queue close refuses every job it must not close, by name, and writes nothing", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-refusals");
  const cases = [
    [{ status: "pending" }, /is pending; it has not produced a pull request yet/],
    [{ status: "running" }, /is running with a live lease/],
    [{ status: "cancelled" }, /is cancelled; retry it before closing/],
    [{ status: "done", prUrl: null }, /nothing to close: the job has no pull request/],
    [{ status: "failed" }, /failed; retry it or cancel it - only a done job is closed/],
    [{ status: "gate" }, /is waiting at a gate/],
    [{ status: "done", project: "ghost" }, /belongs to project `ghost`, which is not registered/],
    [{ status: "done", prUrl: "https://gitlab.com/acme/api/-/merge_requests/7" }, /not a GitHub pull request URL/],
  ];
  for (const [spec, message] of cases) {
    const id = jobIn(env, spec);
    const calls = [];
    const ran = await runCli(env, ["queue", "close", String(id), "--force"], { calls });
    assert.equal(ran.code, 1, `${JSON.stringify(spec)}: ${ran.stdout}`);
    assert.match(ran.stderr, message, JSON.stringify(spec));
    assert.equal(calls.length, 0, `${JSON.stringify(spec)}: a refusal spawned something`);
    assert.equal(getJob(id, env).close_status, null, `${JSON.stringify(spec)}: a refusal wrote the close`);
  }
  assert.match((await runCli(env, ["queue", "close", "999"])).stderr, /unknown job `999`/);
  const closed = seedClosedJob(env, { prUrl: PR_URL });
  const again = await runCli(env, ["queue", "close", String(closed), "--force"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, new RegExp(`job \`${closed}\` is already closed`));
});

test("queue close refuses a job whose checkout is gone, and a call from inside an unattended job", async (t) => {
  const { env, checkout } = makeCloseHome(t, "close-cli-guards");
  const id = jobIn(env);
  const inside = await runCli({ ...env, NIGHTSHIFT_JOB_ID: "3" }, ["queue", "close", String(id)]);
  assert.equal(inside.code, 1);
  assert.match(inside.stderr, /an unattended run never closes/);
  rmSync(checkout, { recursive: true, force: true });
  const missing = await runCli(env, ["queue", "close", String(id)]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /the checkout of project `alpha` is missing/);
  assert.equal(getJob(id, env).close_status, null);
});

test("queue close starts detached: the child gets --foreground and the lease token, and registers as a close", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-detached");
  const id = jobIn(env);
  const calls = [];
  const ran = await runCli(env, ["queue", "close", String(id)], { calls });

  assert.equal(ran.code, 0, ran.stderr);
  const row = getJob(id, env);
  assert.equal(row.close_status, "closing");
  assert.equal(row.status, "done", "a start never moves the job status");
  const [spawned] = calls;
  assert.equal(spawned.file, process.execPath);
  assert.deepEqual(spawned.args.slice(1), ["queue", "close", String(id), "--foreground"]);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.env.NIGHTSHIFT_CLOSE_WORKER, row.close_worker, "the child never received the lease token");
  const record = JSON.parse(readFileSync(runnerRegistryPath(CHILD_PID, env), "utf8"));
  assert.equal(record.mode, "close");
  assert.equal(record.jobId, id);
  assert.equal(record.detached, true);
  assert.match(record.logPath, new RegExp(`close-${id}-\\d{8}T\\d{6}Z\\.log$`));
  assert.equal(
    ran.stdout,
    `close of job #${id} started (pid ${CHILD_PID}) - follow with: tail -f ${record.logPath} (log: ${record.logPath}), or nightshift queue status ${id}`,
  );

  const again = await runCli(env, ["queue", "close", String(id)]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /is already being closed by `close:/);
});

test("queue close --force hands --force to the detached child of a done job, and --json answers the start", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-force");
  const id = jobIn(env);
  const calls = [];
  const ran = await runCli(env, ["queue", "close", String(id), "--force"], { calls });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.out[0], `job #${id}: --force: pull request checks and the rebase suite are skipped; conflicts, attribution and status still stop the close`);
  assert.match(ran.out[1], new RegExp(`^close of job #${id} started`));
  assert.deepEqual(calls[0].args.slice(1), ["queue", "close", String(id), "--foreground", "--force"]);
  assert.equal(JSON.parse(getJob(id, env).close).forced, true, "the checklist does not say the close was forced");

  const other = jobIn(env);
  const json = await runCli(env, ["queue", "close", String(other), "--json"]);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual({ ...payload, logPath: typeof payload.logPath }, { started: true, jobId: other, pid: CHILD_PID, logPath: "string" });
});

test("a spawn that fails leaves the close failed at start, the lease cleared and no registration", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-spawn-fail");
  const id = jobIn(env);
  const ran = await runCli(env, ["queue", "close", String(id)], { spawnImpl: fakeSpawn([], { fail: new Error("spawn EACCES") }) });
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /could not start the close of job #\d+: spawn EACCES; run again with: nightshift queue close \d+/);
  const row = getJob(id, env);
  assert.equal(row.close_status, "failed");
  assert.equal(row.close_worker, null);
  assert.equal(row.close_lease_until, null);
  assert.deepEqual(JSON.parse(row.close).failed, { step: "start", reason: "spawn-failed" });
  assert.equal(existsSync(runnerRegistryPath(CHILD_PID, env)), false);
});

test("a dead close lease is reclaimed by the next queue close", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-reclaim");
  const id = jobIn(env);
  acquireClose(id, { worker: "close:gone:1:dead", leaseS: 660 }, env);
  openDb(env).prepare("UPDATE jobs SET close_lease_until = datetime('now', '-5 seconds') WHERE id = ?").run(id);
  const ran = await runCli(env, ["queue", "close", String(id)]);
  assert.equal(ran.code, 0, ran.stderr);
  const row = getJob(id, env);
  assert.notEqual(row.close_worker, "close:gone:1:dead");
  assert.equal(JSON.parse(row.close).attempts, 2);
});

test("queue close --foreground runs the engine here, prints where it stopped and leaves no registration behind", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-foreground");
  const id = jobIn(env);
  const calls = [];
  const ran = await runCli(env, ["queue", "close", String(id), "--foreground"], { calls });
  assert.equal(ran.code, 1, "only a closed job exits 0");
  assert.equal(calls.length, 0, "--foreground spawned a child");
  assert.match(ran.out[0], /^✗ preflight\s+checks-red - failing checks: lint$/);
  assert.equal(ran.out.at(-1), `⛔ close stopped at preflight: checks-red - run again with: nightshift queue close ${id}`);
  const row = getJob(id, env);
  assert.equal(row.close_status, "failed");
  assert.equal(row.close_worker, null);
  assert.equal(row.status, "done", "a stopped close moved the job status");
  assert.equal(JSON.parse(row.close).steps.preflight.status, "failed", "the engine never recorded the step it stopped at");
  assert.equal(existsSync(runnerRegistryPath(process.pid, env)), false, "the foreground close left its registration behind");

  const json = await runCli(env, ["queue", "close", String(id), "--foreground", "--json"]);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(payload.outcome, { status: "failed", step: "preflight", reason: "checks-red", mergeSha: null });
  assert.equal(payload.job.close.attempts, 2);
});

test("queue close --foreground --force goes past red checks, says so first, and records the ignored checks and `forced`", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-force-red");
  const id = jobIn(env);
  const fake = fakeCloseDeps({ checks: RED_CHECKS });
  const ran = await runCli(env, ["queue", "close", String(id), "--foreground", "--force"], { closeDeps: fake.deps });
  assert.equal(ran.code, 0, ran.stdout);
  assert.equal(ran.out[0], `job #${id}: --force: pull request checks and the rebase suite are skipped; conflicts, attribution and status still stop the close`);
  assert.match(ran.out[1], /^✓ preflight\s+PR #7 open; checks ignored with --force: failing: lint; canonical checkout clean$/);
  assert.equal(ran.out.at(-1), `job #${id} closed: PR #7 merged as abc1234`);
  const checklist = JSON.parse(getJob(id, env).close);
  assert.equal(checklist.forced, true);
  assert.equal(checklist.data.mergedBy, "nightshift");
  assert.equal(getJob(id, env).status, "closed");
});

test("queue close --foreground of a pull request closed without merge cancels the job and says there is nothing to close", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-pr-closed");
  const id = jobIn(env);
  const ran = await runCli(env, ["queue", "close", String(id), "--foreground"], { closeDeps: fakeCloseDeps({ pr: openPr({ state: "CLOSED" }) }).deps });
  assert.equal(ran.code, 1, "a cancelled close exited 0");
  assert.match(ran.out[0], /^✗ preflight\s+pr-closed - PR #7 was closed without being merged$/);
  assert.equal(ran.out.at(-1), `job #${id} cancelled: PR #7 was closed without being merged; nothing to close`);
  const row = getJob(id, env);
  assert.equal(row.status, "cancelled");
  assert.equal(row.operator_note, "pull request closed without merge");
  assert.equal(row.close_status, null);
  assert.equal(row.close_worker, null);
  assert.equal(row.close_lease_until, null);
  assert.deepEqual(JSON.parse(row.close).failed, { step: "preflight", reason: "pr-closed" });

  const again = await runCli(env, ["queue", "close", String(id), "--foreground"]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /is cancelled; retry it before closing/);
});

test("queue close re-runs a failed close keeping its checklist, reclaims a dead lease, and closes with one merge call", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-rerun");
  const id = jobIn(env);
  openDb(env).prepare("UPDATE jobs SET notice_md = 'A' WHERE id = ?").run(id);
  const fake = fakeCloseDeps({ merge: () => ({ ok: true, stderr: "" }) });

  const first = await runCli(env, ["queue", "close", String(id), "--foreground"], { closeDeps: fake.deps });
  assert.equal(first.code, 1);
  assert.equal(first.out.at(-1), `⛔ close stopped at merge: merge-without-sha - run again with: nightshift queue close ${id}`);
  assert.equal(getJob(id, env).status, "done");

  acquireClose(id, { worker: "close:gone:1:dead", leaseS: 660 }, env);
  openDb(env).prepare("UPDATE jobs SET close_lease_until = datetime('now', '-5 seconds') WHERE id = ?").run(id);
  fake.world.pr = mergedPr();
  const second = await runCli(env, ["queue", "close", String(id), "--foreground"], { closeDeps: fake.deps });

  assert.equal(second.code, 0, second.stderr);
  assert.match(second.out[0], /^✓ preflight\s+PR #7 open; 1 checks green; canonical checkout clean \(earlier attempt\)$/);
  assert.equal(second.out.at(-1), `job #${id} closed: PR #7 merged as abc1234`);
  assert.equal(fake.log.merges.length, 1, "the re-run merged again");
  const row = getJob(id, env);
  assert.equal(row.status, "closed");
  assert.equal(row.close_status, null);
  assert.equal(row.notice_md, "A\n\nClosed: PR #7 merged as abc1234 on 2026-09-21");
  const checklist = JSON.parse(row.close);
  assert.equal(checklist.attempts, 3);
  assert.equal(checklist.steps.preflight.status, "done");
});

test("queue close refuses a pull request on another branch at preflight, and the detached child of --force still refuses it", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-attribution");
  const id = jobIn(env, { branch: "worktree-feat+queue-close" });
  const foreign = () => fakeCloseDeps({ pr: openPr({ headRefName: "scratch/qa" }) });
  const refusal = /^✗ preflight\s+pr-not-the-job-branch - PR #7 is on branch `scratch\/qa`, but job `\d+` ran on `worktree-feat\+queue-close`; it is not this job's pull request\. Fix the job's pr_url before closing it$/;

  const refused = await runCli(env, ["queue", "close", String(id), "--foreground"], { closeDeps: foreign().deps });
  assert.equal(refused.code, 1);
  assert.match(refused.out[0], refusal);
  assert.equal(getJob(id, env).status, "done");

  const calls = [];
  await runCli(env, ["queue", "close", String(id), "--force"], { calls });
  assert.deepEqual(calls[0].args.slice(1), ["queue", "close", String(id), "--foreground", "--force"]);
  const fake = foreign();
  const child = await runCli({ ...env, NIGHTSHIFT_CLOSE_WORKER: calls[0].options.env.NIGHTSHIFT_CLOSE_WORKER }, calls[0].args.slice(1), { closeDeps: fake.deps });
  assert.equal(child.code, 1, child.stdout);
  assert.match(child.out[1], refusal);
  assert.equal(fake.log.merges.length, 0, "--force merged a pull request that is not the job's own");
  assert.equal(getJob(id, env).status, "done");
  assert.equal(getJob(id, env).close_status, "failed");
});

test("the detached child adopts the lease through its token, and a token that does not hold it writes nothing", async (t) => {
  const { env } = makeCloseHome(t, "close-cli-adopt");
  const id = jobIn(env);
  const calls = [];
  await runCli(env, ["queue", "close", String(id)], { calls });
  const token = calls[0].options.env.NIGHTSHIFT_CLOSE_WORKER;

  const stranger = await runCli({ ...env, NIGHTSHIFT_CLOSE_WORKER: "close:other:1:beef" }, ["queue", "close", String(id), "--foreground"]);
  assert.equal(stranger.code, 1);
  assert.match(stranger.stderr, /the close lease of job #\d+ is not held by this process any more/);
  assert.equal(getJob(id, env).close_status, "closing", "a stranger's token changed the close");

  const child = await runCli({ ...env, NIGHTSHIFT_CLOSE_WORKER: token }, ["queue", "close", String(id), "--foreground"]);
  assert.equal(child.code, 1);
  assert.equal(getJob(id, env).close_status, "failed", "the child never adopted the lease its parent took");
});
