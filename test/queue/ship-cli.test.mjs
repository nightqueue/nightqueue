import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { runnerRegistryPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireShip, addJob, getJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeShipDeps, mergedPr, openPr, SHIP_PR_URL } from "../../test-support/ship.mjs";

const CHILD_PID = 4242;
const PR_URL = SHIP_PR_URL;

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
async function runCli(env, argv, { calls = [], spawnImpl = null, alive = new Set(), shipDeps = fakeShipDeps({ pr: openPr({ state: "CLOSED" }) }).deps } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    spawnImpl: spawnImpl ?? fakeSpawn(calls),
    killImpl: fakeKill(alive),
    shipDeps,
  };
  const code = await run(argv, ctx);
  return { code, out, err, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

// A home with the project `alpha` registered, the one every job of this file belongs to.
function makeShipHome(t, name) {
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

test("queue ship refuses every job it must not ship, by name, and writes nothing", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-refusals");
  const cases = [
    [{ status: "pending" }, /is pending; it has not produced a pull request yet/],
    [{ status: "running" }, /is running with a live lease/],
    [{ status: "closed" }, /is already closed/],
    [{ status: "cancelled" }, /is cancelled/],
    [{ status: "done", prUrl: null }, /has no pull request to ship/],
    [{ status: "failed" }, /pass --force to ship its pull request anyway/],
    [{ status: "gate" }, /pass --force to ship its pull request anyway/],
    [{ status: "done", project: "ghost" }, /belongs to project `ghost`, which is not registered/],
    [{ status: "done", prUrl: "https://gitlab.com/acme/api/-/merge_requests/7" }, /not a GitHub pull request URL/],
  ];
  for (const [spec, message] of cases) {
    const id = jobIn(env, spec);
    const calls = [];
    const ran = await runCli(env, ["queue", "ship", String(id)], { calls });
    assert.equal(ran.code, 1, `${JSON.stringify(spec)}: ${ran.stdout}`);
    assert.match(ran.stderr, message, JSON.stringify(spec));
    assert.equal(calls.length, 0, `${JSON.stringify(spec)}: a refusal spawned something`);
    assert.equal(getJob(id, env).ship_status, null, `${JSON.stringify(spec)}: a refusal wrote the ship`);
  }
  assert.match((await runCli(env, ["queue", "ship", "999"])).stderr, /unknown job `999`/);
});

test("queue ship refuses a job whose checkout is gone, and a call from inside an unattended job", async (t) => {
  const { env, checkout } = makeShipHome(t, "ship-cli-guards");
  const id = jobIn(env);
  const inside = await runCli({ ...env, NIGHTSHIFT_JOB_ID: "3" }, ["queue", "ship", String(id)]);
  assert.equal(inside.code, 1);
  assert.match(inside.stderr, /an unattended run never ships/);
  rmSync(checkout, { recursive: true, force: true });
  const missing = await runCli(env, ["queue", "ship", String(id)]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /the checkout of project `alpha` is missing/);
  assert.equal(getJob(id, env).ship_status, null);
});

test("queue ship starts detached: the child gets --foreground and the lease token, and registers as a ship", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-detached");
  const id = jobIn(env);
  const calls = [];
  const ran = await runCli(env, ["queue", "ship", String(id)], { calls });

  assert.equal(ran.code, 0, ran.stderr);
  const row = getJob(id, env);
  assert.equal(row.ship_status, "shipping");
  assert.equal(row.status, "done", "a start never moves the job status");
  const [spawned] = calls;
  assert.equal(spawned.file, process.execPath);
  assert.deepEqual(spawned.args.slice(1), ["queue", "ship", String(id), "--foreground"]);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.env.NIGHTSHIFT_SHIP_WORKER, row.ship_worker, "the child never received the lease token");
  const record = JSON.parse(readFileSync(runnerRegistryPath(CHILD_PID, env), "utf8"));
  assert.equal(record.mode, "ship");
  assert.equal(record.jobId, id);
  assert.equal(record.detached, true);
  assert.match(record.logPath, new RegExp(`ship-${id}-\\d{8}T\\d{6}Z\\.log$`));
  assert.equal(
    ran.stdout,
    `ship of job #${id} started (pid ${CHILD_PID}) - follow with: tail -f ${record.logPath} (log: ${record.logPath}), or nightshift queue status ${id}`,
  );

  const again = await runCli(env, ["queue", "ship", String(id)]);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /already being shipped by `ship:/);
});

test("queue ship --force ships a failed job with a pull request, says so, and --json answers the start", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-force");
  const id = jobIn(env, { status: "failed" });
  const calls = [];
  const ran = await runCli(env, ["queue", "ship", String(id), "--force"], { calls });
  assert.equal(ran.code, 0, ran.stderr);
  assert.equal(ran.out[0], `job #${id} is \`failed\`; shipping its pull request anyway (--force)`);
  assert.deepEqual(calls[0].args.slice(1), ["queue", "ship", String(id), "--foreground", "--force"]);

  const other = jobIn(env);
  const json = await runCli(env, ["queue", "ship", String(other), "--json"]);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual({ ...payload, logPath: typeof payload.logPath }, { started: true, jobId: other, pid: CHILD_PID, logPath: "string" });
});

test("a spawn that fails leaves the ship failed at start, the lease cleared and no registration", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-spawn-fail");
  const id = jobIn(env);
  const ran = await runCli(env, ["queue", "ship", String(id)], { spawnImpl: fakeSpawn([], { fail: new Error("spawn EACCES") }) });
  assert.equal(ran.code, 1);
  assert.match(ran.stderr, /could not start the ship of job #\d+: spawn EACCES; run again with: nightshift queue ship \d+/);
  const row = getJob(id, env);
  assert.equal(row.ship_status, "failed");
  assert.equal(row.ship_worker, null);
  assert.equal(row.ship_lease_until, null);
  assert.deepEqual(JSON.parse(row.ship).failed, { step: "start", reason: "spawn-failed" });
  assert.equal(existsSync(runnerRegistryPath(CHILD_PID, env)), false);
});

test("a dead ship lease is reclaimed by the next queue ship", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-reclaim");
  const id = jobIn(env);
  acquireShip(id, { worker: "ship:gone:1:dead", leaseS: 660 }, env);
  openDb(env).prepare("UPDATE jobs SET ship_lease_until = datetime('now', '-5 seconds') WHERE id = ?").run(id);
  const ran = await runCli(env, ["queue", "ship", String(id)]);
  assert.equal(ran.code, 0, ran.stderr);
  const row = getJob(id, env);
  assert.notEqual(row.ship_worker, "ship:gone:1:dead");
  assert.equal(JSON.parse(row.ship).attempts, 2);
});

test("queue ship --foreground runs the engine here, prints where it stopped and leaves no registration behind", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-foreground");
  const id = jobIn(env);
  const calls = [];
  const ran = await runCli(env, ["queue", "ship", String(id), "--foreground"], { calls });
  assert.equal(ran.code, 1, "only a shipped job exits 0");
  assert.equal(calls.length, 0, "--foreground spawned a child");
  assert.match(ran.out[0], /^✗ preflight\s+pr-closed - PR #7 was closed without being merged$/);
  assert.equal(ran.out.at(-1), `⛔ ship stopped at preflight: pr-closed - run again with: nightshift queue ship ${id}`);
  const row = getJob(id, env);
  assert.equal(row.ship_status, "failed");
  assert.equal(row.ship_worker, null);
  assert.equal(row.status, "done", "a stopped ship moved the job status");
  assert.equal(JSON.parse(row.ship).steps.preflight.status, "failed", "the engine never recorded the step it stopped at");
  assert.equal(existsSync(runnerRegistryPath(process.pid, env)), false, "the foreground ship left its registration behind");

  const json = await runCli(env, ["queue", "ship", String(id), "--foreground", "--json"]);
  const payload = JSON.parse(json.stdout);
  assert.deepEqual(payload.outcome, { status: "failed", step: "preflight", reason: "pr-closed", mergeSha: null });
  assert.equal(payload.job.ship.attempts, 2);
});

test("queue ship re-runs a failed ship keeping its checklist, reclaims a dead lease, and ships with one merge call", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-rerun");
  const id = jobIn(env);
  openDb(env).prepare("UPDATE jobs SET notice_md = 'A' WHERE id = ?").run(id);
  const fake = fakeShipDeps({ merge: () => ({ ok: true, stderr: "" }) });

  const first = await runCli(env, ["queue", "ship", String(id), "--foreground"], { shipDeps: fake.deps });
  assert.equal(first.code, 1);
  assert.equal(first.out.at(-1), `⛔ ship stopped at merge: merge-without-sha - run again with: nightshift queue ship ${id}`);
  assert.equal(getJob(id, env).status, "done");

  acquireShip(id, { worker: "ship:gone:1:dead", leaseS: 660 }, env);
  openDb(env).prepare("UPDATE jobs SET ship_lease_until = datetime('now', '-5 seconds') WHERE id = ?").run(id);
  fake.world.pr = mergedPr();
  const second = await runCli(env, ["queue", "ship", String(id), "--foreground"], { shipDeps: fake.deps });

  assert.equal(second.code, 0, second.stderr);
  assert.match(second.out[0], /^✓ preflight\s+PR #7 open; 1 checks green; canonical checkout clean \(earlier attempt\)$/);
  assert.equal(second.out.at(-1), `job #${id} shipped: PR #7 merged as abc1234; job closed`);
  assert.equal(fake.log.merges.length, 1, "the re-run merged again");
  const row = getJob(id, env);
  assert.equal(row.status, "closed");
  assert.equal(row.ship_status, "shipped");
  assert.equal(row.notice_md, "A\n\nShipped: PR #7 merged as abc1234 on 2026-09-21");
  const checklist = JSON.parse(row.ship);
  assert.equal(checklist.attempts, 3);
  assert.equal(checklist.steps.preflight.status, "done");
});

test("queue ship refuses a pull request on another branch at preflight, and the detached child of --force ships it", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-attribution");
  const id = jobIn(env, { branch: "worktree-feat+queue-ship" });
  const foreign = () => fakeShipDeps({ pr: openPr({ headRefName: "scratch/qa" }) });

  const refused = await runCli(env, ["queue", "ship", String(id), "--foreground"], { shipDeps: foreign().deps });
  assert.equal(refused.code, 1);
  assert.match(refused.out[0], /^✗ preflight\s+pr-not-the-job-branch - PR #7 is on branch `scratch\/qa`, but job `\d+` ran on `worktree-feat\+queue-ship`;.* --force$/);
  assert.equal(getJob(id, env).status, "done");

  const calls = [];
  await runCli(env, ["queue", "ship", String(id), "--force"], { calls });
  assert.deepEqual(calls[0].args.slice(1), ["queue", "ship", String(id), "--foreground", "--force"]);
  const fake = foreign();
  const child = await runCli({ ...env, NIGHTSHIFT_SHIP_WORKER: calls[0].options.env.NIGHTSHIFT_SHIP_WORKER }, calls[0].args.slice(1), { shipDeps: fake.deps });
  assert.equal(child.code, 0, child.stdout);
  assert.match(child.out[0], /attribution overridden with --force \(PR on `scratch\/qa`, job on `worktree-feat\+queue-ship`\)$/);
  assert.equal(fake.log.merges.length, 1);
  assert.equal(getJob(id, env).status, "closed");
});

test("the detached child adopts the lease through its token, and a token that does not hold it writes nothing", async (t) => {
  const { env } = makeShipHome(t, "ship-cli-adopt");
  const id = jobIn(env);
  const calls = [];
  await runCli(env, ["queue", "ship", String(id)], { calls });
  const token = calls[0].options.env.NIGHTSHIFT_SHIP_WORKER;

  const stranger = await runCli({ ...env, NIGHTSHIFT_SHIP_WORKER: "ship:other:1:beef" }, ["queue", "ship", String(id), "--foreground"]);
  assert.equal(stranger.code, 1);
  assert.match(stranger.stderr, /the ship lease of job #\d+ is not held by this process any more/);
  assert.equal(getJob(id, env).ship_status, "shipping", "a stranger's token changed the ship");

  const child = await runCli({ ...env, NIGHTSHIFT_SHIP_WORKER: token }, ["queue", "ship", String(id), "--foreground"]);
  assert.equal(child.code, 1);
  assert.equal(getJob(id, env).ship_status, "failed", "the child never adopted the lease its parent took");
});
