import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { openDb, sqliteToIso } from "../../src/memory/db.mjs";
import { addJob, claimJobById, getJob, sweepOrphans } from "../../src/memory/jobs.mjs";
import { getRoadmapItem, markRoadmapItemQueued, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { clearRunTerminal, readRunState, writeRunTerminal } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));
const REPAIRER = fileURLToPath(new URL("../../test-support/witness-repairer.mjs", import.meta.url));
const MCP_SRC = fileURLToPath(new URL("../../src/mcp/tools.mjs", import.meta.url));
const FIXED_TZ = "America/Sao_Paulo";
const WORKER = "host:1000";
const CAP = 4;
const SLUG = "fix-worker";
const PR_URL = "https://github.com/acme/api/pull/7";
const FINISHED_AT = "2026-09-11T03:15:00Z";
const WRITTEN_BY = "/tmp/runtime/versions/0.1.0-20260911T031500Z";

// A home with one registered project and the queue table ready.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// Starts the real CLI without waiting for it, so two commands can be in flight against one home at the same time.
function startCli(env, args) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((done) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => done({ code, stderr }));
  });
}

// Connects a real stdio client to `nightshift mcp`, closed at the end of the test.
async function connectMcp(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightshift-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// JSON payload of a tool result.
function payloadOf(result) {
  return JSON.parse(result.content.map((block) => block.text).join("\n"));
}

// Enqueues a job, claims it and records the slug of its run: the row a runner owns while it works.
function runningJob(env, { slug = SLUG } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: CAP }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(slug, id);
  return id;
}

// Moves the lease past the reclaim grace, which is how a runner that died looks from the outside.
function expireLease(env, id) {
  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-120 seconds') WHERE id = ?").run(id);
}

// Writes the witness a runner leaves next to the run once it has finished the job.
function witness(env, { slug = SLUG, status = "done", prUrl = PR_URL } = {}) {
  return writeRunTerminal({
    project: "alpha",
    slug,
    terminal: { status, prUrl, finishedAt: FINISHED_AT, writtenBy: WRITTEN_BY, pid: 4242 },
    env,
  });
}

// Records a roadmap item as queued under a job, the link the reconciliation has to close.
function linkedItem(env, id, title) {
  const item = saveRoadmapItem({ project: "alpha", horizon: "now", title }, env);
  assert.equal(markRoadmapItemQueued(item.id, id, env), true, "setup: the item was not linked to its job");
  return item.id;
}

// A job whose row still says `running` under a dead runner, with the witness of its real outcome on disk.
function lostFinish(env, options = {}) {
  const id = runningJob(env, options);
  expireLease(env, id);
  witness(env, options);
  return id;
}

test("the witness is merged into what the pipeline wrote, leaves no temporary file, and refuses an unsafe slug", (t) => {
  const env = makeQueue(t, "witness-write");
  const dir = runDir("alpha", SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 1, slug: SLUG, branch: "ns/fix", phases: [] }));

  const written = witness(env);
  assert.equal(written.status, "written");
  const state = readRunState({ project: "alpha", slug: SLUG, env });
  assert.equal(state.branch, "ns/fix", "the witness overwrote what the pipeline had written");
  assert.deepEqual(Object.keys(state.terminal), ["status", "prUrl", "finishedAt", "writtenBy", "pid"]);
  assert.deepEqual(state.terminal, { status: "done", prUrl: PR_URL, finishedAt: FINISHED_AT, writtenBy: WRITTEN_BY, pid: 4242 });
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp")), [], "a temporary file was left in the run directory");

  const unsafe = writeRunTerminal({ project: "alpha", slug: "../escape", terminal: { status: "done" }, env });
  assert.equal(unsafe.status, "kept");
  assert.equal(unsafe.reason, "unsafe project or slug");
});

test("clearRunTerminal drops the witness and keeps the rest of the state, and creates nothing when there is no state", (t) => {
  const env = makeQueue(t, "witness-clear");
  const dir = runDir("alpha", SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 1, slug: SLUG, phases: [] }));
  witness(env);

  assert.equal(clearRunTerminal({ project: "alpha", slug: SLUG, env }).status, "written");
  const state = readRunState({ project: "alpha", slug: SLUG, env });
  assert.equal(state.terminal, undefined, "the witness survived the clear");
  assert.equal(state.schemaVersion, 1, "clearing the witness threw away the state of the pipeline");

  assert.equal(clearRunTerminal({ project: "alpha", slug: "never-ran", env }).status, "absent");
  assert.equal(existsSync(join(runDir("alpha", "never-ran", env), "state.json")), false, "the clear created a state.json");
});

test("a job the database lost is restored from its witness, with repairedFrom in the result and one line in its log", async (t) => {
  const env = makeQueue(t, "reconcile-repair");
  const id = lostFinish(env);
  const before = readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8");

  assert.deepEqual(await reconcileFromWitness(env), { repaired: [id], error: null });

  const row = getJob(id, env);
  assert.equal(row.status, "done");
  assert.equal(row.pr_url, PR_URL);
  assert.equal(row.finished_at, "2026-09-11 03:15:00");
  assert.equal(row.worker, null);
  assert.equal(row.lease_until, null);
  assert.equal(JSON.parse(row.result).repairedFrom, "state.json");
  assert.equal(
    readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8"),
    before,
    "the reconciliation wrote the run directory: the witness must never be overwritten by the database",
  );
  assert.ok(
    readFileSync(jobLogPath(id, env), "utf8").includes(
      `repaired from state.json: status=done prUrl=${PR_URL} finishedAt=${FINISHED_AT} writtenBy=${WRITTEN_BY} pid=4242`,
    ),
    "the repair was not recorded in the log of the job",
  );

  assert.deepEqual(await reconcileFromWitness(env), { repaired: [], error: null }, "a job that already ended was repaired again");
});

test("the reconciliation closes the roadmap item of a job its witness says delivered, and leaves open the one of a failed witness", async (t) => {
  const env = makeQueue(t, "reconcile-roadmap");
  const delivered = lostFinish(env);
  const deliveredItem = linkedItem(env, delivered, "ship the delivery");

  const failedSlug = "never-delivered";
  const failed = lostFinish(env, { slug: failedSlug, status: "failed", prUrl: null });
  const failedItem = linkedItem(env, failed, "the one that failed");

  assert.deepEqual((await reconcileFromWitness(env)).repaired.sort(), [delivered, failed].sort());
  assert.equal(getJob(delivered, env).status, "done");
  assert.equal(getJob(failed, env).status, "failed");
  assert.equal(getRoadmapItem(deliveredItem, env).status, "done", "the reconciliation left the item of a delivered job queued forever");
  assert.equal(getRoadmapItem(failedItem, env).status, "queued", "a failed witness closed the item of a job that delivered nothing");
});

test("the reconciliation never touches a job a live runner owns, a row that already ended, or a job that never ran", async (t) => {
  const env = makeQueue(t, "reconcile-skips");
  const live = runningJob(env);
  witness(env);
  assert.deepEqual((await reconcileFromWitness(env)).repaired, [], "a job under a live lease was repaired under its runner");
  assert.equal(getJob(live, env).status, "running");

  expireLease(env, live);
  await reconcileFromWitness(env);
  assert.equal(getJob(live, env).status, "done");
  openDb(env).prepare("UPDATE jobs SET status = 'failed', pr_url = NULL WHERE id = ?").run(live);
  assert.deepEqual((await reconcileFromWitness(env)).repaired, [], "a job that already ended was rewritten by the witness");
  assert.equal(getJob(live, env).status, "failed");

  const pending = addJob({ project: "alpha", prompt: "another job" }, env).id;
  witness(env, { slug: "another-run" });
  assert.deepEqual((await reconcileFromWitness(env)).repaired, [], "a job with no slug was matched against somebody else's witness");
  assert.equal(getJob(pending, env).status, "pending");
});

test("a witness that says `closed` is never trusted: the row stays as it is", async (t) => {
  const env = makeQueue(t, "reconcile-closed-witness");
  const id = lostFinish(env, { status: "closed" });
  const before = getJob(id, env);

  assert.deepEqual((await reconcileFromWitness(env)).repaired, [], "a witness closed a job, which only the operator does");
  assert.deepEqual(getJob(id, env), before, "a `closed` witness rewrote the row");
});

test("a repair the database refuses only warns: `queue status` still prints the queue and exits 0", (t) => {
  const env = makeQueue(t, "reconcile-refused");
  const id = lostFinish(env);
  openDb(env).exec(
    `CREATE TRIGGER refuse_repair BEFORE UPDATE OF status ON jobs WHEN NEW.status = 'done'
     BEGIN SELECT RAISE(ABORT, 'attempt to write a readonly database'); END`,
  );

  const status = runCli(env, ["queue", "status"]);
  assert.equal(status.status, 0, status.stderr);
  assert.ok(status.stdout.includes(`#${id}`), `the queue table is missing:\n${status.stdout}`);
  assert.ok(
    status.stderr.includes(`warning: could not repair a job from state.json: job #${id}:`),
    `the refused repair did not warn:\n${status.stderr}`,
  );
});

test("a retried job is never closed again by the witness of its previous attempt", async (t) => {
  const env = makeQueue(t, "reconcile-retry");
  const id = lostFinish(env, { status: "failed", prUrl: null });
  await reconcileFromWitness(env);
  assert.equal(getJob(id, env).status, "failed");

  await applyRetry({ id, note: null, env });
  assert.equal(getJob(id, env).status, "pending");
  assert.equal(readRunState({ project: "alpha", slug: SLUG, env })?.terminal, undefined, "the retry kept the stale witness");

  assert.deepEqual((await reconcileFromWitness(env)).repaired, [], "the witness of the previous attempt finished the fresh one");
  assert.equal(getJob(id, env).status, "pending");
});

test("a pending job the orphan sweep requeued is still repaired from its witness: only a retry voids it", async (t) => {
  const env = makeQueue(t, "reconcile-requeued");
  const id = lostFinish(env);
  openDb(env).prepare("UPDATE jobs SET max_attempts = 3 WHERE id = ?").run(id);

  assert.equal(sweepOrphans(env).requeued, 1, "setup: the sweep did not requeue the job whose runner died");
  assert.equal(getJob(id, env).status, "pending");

  assert.deepEqual(
    (await reconcileFromWitness(env)).repaired,
    [id],
    "a job requeued by the sweep after its finish was lost stayed pending and would have run a second time",
  );
  assert.equal(getJob(id, env).status, "done");
  assert.equal(getJob(id, env).pr_url, PR_URL);
});

test("retry then `queue status` through the real CLI leaves the job pending, and a genuinely lost finish is repaired", (t) => {
  const env = makeQueue(t, "reconcile-cli");
  const id = lostFinish(env, { status: "failed", prUrl: null });

  const repaired = runCli(env, ["queue", "status"]);
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(getJob(id, env).status, "failed", `queue status did not repair the row:\n${repaired.stdout}`);

  assert.equal(runCli(env, ["queue", "retry", String(id)]).status, 0);
  assert.equal(getJob(id, env).status, "pending");
  const after = runCli(env, ["queue", "status"]);
  assert.equal(after.status, 0, after.stderr);
  assert.equal(getJob(id, env).status, "pending", "queue status finished the retried job from the witness of the previous attempt");
});

test("two `queue status` racing over the same home both exit 0 and the row is repaired once", async (t) => {
  const env = makeQueue(t, "reconcile-concurrent");
  const id = lostFinish(env);

  const [first, second] = await Promise.all([startCli(env, ["queue", "status"]), startCli(env, ["queue", "status"])]);

  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(getJob(id, env).status, "done");
  const log = readFileSync(jobLogPath(id, env), "utf8");
  assert.equal(log.split("repaired from state.json").length - 1, 1, `the job was repaired twice:\n${log}`);
});

// The instant a finish would stamp on the row right now, in the shape the column stores it; no timestamp of this test is written by hand.
function storedNow(env) {
  return openDb(env).prepare("SELECT datetime('now') AS now").get().now;
}

// A job whose finish was lost, with a witness naming the given instant in the given shape.
function lostFinishAt(env, { slug, finishedAt }) {
  const id = runningJob(env, { slug });
  expireLease(env, id);
  writeRunTerminal({ project: "alpha", slug, terminal: { status: "done", prUrl: PR_URL, finishedAt, writtenBy: WRITTEN_BY, pid: 4242 }, env });
  return id;
}

// Reconciles the home in a child process pinned to a timezone that is not UTC, which is the only way `Date.parse` reads a local time.
function repairUnderTimezone(env) {
  const result = spawnSync(process.execPath, [REPAIRER], { env: { ...env, TZ: FIXED_TZ }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").pop());
}

test("a witness is restored to the instant it names, in both shapes, whatever the timezone of the process that repairs the row", (t) => {
  const env = makeQueue(t, "reconcile-timezone");
  const instant = storedNow(env);
  const isoId = lostFinishAt(env, { slug: "iso-witness", finishedAt: sqliteToIso(instant) });
  const legacyId = lostFinishAt(env, { slug: "legacy-witness", finishedAt: instant });

  const answer = repairUnderTimezone(env);

  assert.notEqual(answer.offsetMinutes, 0, `the child ran at UTC: TZ=${FIXED_TZ} was ignored and this test would prove nothing`);
  assert.equal(answer.error, null);
  assert.deepEqual([...answer.repaired].sort((a, b) => a - b), [isoId, legacyId]);
  for (const id of [isoId, legacyId]) {
    const row = answer.rows.find((job) => job.id === id);
    assert.equal(row.status, "done");
    assert.equal(
      row.finished_at,
      instant,
      `job #${id} was repaired to another instant than its witness names: the timezone of the repairing process shifted it`,
    );
  }
});

// Asks queue_status until the job reads `status`, within five seconds, and returns the last answer.
async function pollJobStatus(client, id, status) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const answer = payloadOf(await client.callTool({ name: "queue_status", arguments: {} }));
    if (answer.jobs.find((job) => job.id === id)?.status === status || Date.now() > deadline) return answer;
    await new Promise((done) => setTimeout(done, 100));
  }
}

// The definition of the `queue_status` tool, from its name to the name of the tool declared after it.
function queueStatusToolSource() {
  const text = readFileSync(MCP_SRC, "utf8");
  const start = text.indexOf('name: "queue_status"');
  const end = text.indexOf('name: "queue_run"', start + 1);
  assert.ok(start >= 0 && end > start, "the `queue_status` tool moved or was renamed; update this pin");
  return text.slice(start, end);
}

test("the MCP server's maintenance and the start of a runner cycle repair the same way `queue status` does", async (t) => {
  const env = makeQueue(t, "reconcile-mcp");
  const id = lostFinish(env);
  const client = await connectMcp(t, env);

  const answer = await pollJobStatus(client, id, "done");
  assert.equal(answer.jobs.find((job) => job.id === id).status, "done", "the maintenance of the MCP server did not repair the row");

  const source = queueStatusToolSource();
  const beforeRead = source.slice(0, source.indexOf("withReadOnlyStore("));
  for (const token of ["repairWarningLine", "runMaintenance", "pruneDeadRunners"]) {
    assert.equal(source.includes(token), false, `the queue_status handler calls \`${token}\`: a read writes again`);
  }
  assert.equal(beforeRead.includes("refresh("), false, "the queue_status handler refreshes the pull request states before it reads");

  const cycled = makeQueue(t, "reconcile-cycle");
  const cycledId = lostFinish(cycled);
  const pass = await runCycle({ env: cycled });
  assert.equal(getJob(cycledId, cycled).status, "done", `the runner cycle did not repair the row (reason ${pass.reason})`);
  assert.deepEqual(pass.processed, [], "the repaired job was claimed instead of being left alone");
});
