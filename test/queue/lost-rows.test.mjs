import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { dbPath, dbWalPath, homeDir, jobLogPath, logsDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { addIssueComment, queueIssue, saveIssue } from "../../src/memory/issues.mjs";
import { findLostJobs } from "../../src/queue/lost-rows.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { recoverFromDisk } from "../../src/queue/repair.mjs";
import { recordJobBlock } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { openStore } from "../../src/store/open.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { dropJobRows, jobRow, issueSnapshot } from "../../test-support/lost-rows.mjs";
import { ensureProject, makeDir, makeHome, registerCheckout } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { makeSickHome } from "../../test-support/sick-home.mjs";
import { doneStream, gateStream, PR_URL } from "../../test-support/streams.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const DONE_SLUG = "done-run";
const GATE_SLUG = "gate-run";

// Git configuration that reads nothing of the machine's own ignore rules, so only each repository decides what is ignored.
const ISOLATED_GIT_VARS = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.excludesFile",
  GIT_CONFIG_VALUE_0: "/dev/null",
};

// Runs real git in the isolated configuration, in the shape the runner's preflight takes.
function isolatedGit({ args, cwd }) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...ISOLATED_GIT_VARS }, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

// Runs one cycle on one job with real git and the real worktree step.
async function runOnce(env, jobId) {
  const cycle = await runCycle({ jobId, env, deps: { gitImpl: isolatedGit, sleepImpl: async () => {} } });
  return cycle.processed[0];
}

// A home where a done job and an issue gate job ran through the runner, then lost their rows; the rows as they were are kept for comparison.
async function seedLostJobs(t, name) {
  const env = { ...makeHome(t, name), ...ISOLATED_GIT_VARS };
  registerCheckout(env, { path: initGitRepo(makeDir(t, `${name}-repo`)), name: "alpha" });
  useFakeClaude(env, makeDir(t, `${name}-plan`), [
    { stdout: doneStream({ slug: DONE_SLUG }), exitCode: 0 },
    { stdout: gateStream({ slug: GATE_SLUG }), exitCode: 0 },
  ]);
  const projectId = ensureProject(env, "alpha");
  const doneId = addJob({ projectId, prompt: "fix the worker", slug: DONE_SLUG }, env).id;
  const item = saveIssue({ type: "feature", projectId, title: "drop the column" }, env);
  const gateId = (await queueIssue({ id: item.id }, env)).job.id;
  assert.equal((await runOnce(env, doneId)).status, "done");
  assert.equal((await runOnce(env, gateId)).status, "gate");
  addIssueComment({ id: item.id, body: "the operator reads this" }, env);
  const before = { done: getJob(doneId, env), gate: getJob(gateId, env) };
  dropJobRows(env, [doneId, gateId]);
  return { env, projectId, doneId, gateId, before };
}

// Runs the CLI in a child process, started at once and answered once it exits.
function cliAsync(env, args) {
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Runs the CLI in a child process and requires a clean exit.
function cli(env, args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// The `lost jobs` row of `doctor --db --json`, run in process.
async function lostJobsRow(env) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }) };
  await run(["doctor", "--db", "--json"], ctx);
  const row = JSON.parse(out[0]).checks.find((entry) => entry.name === "lost jobs");
  assert.ok(row, "no `lost jobs` row in doctor --db");
  return row;
}

// The `result` column of a row as an object.
function resultOf(row) {
  return JSON.parse(row.result);
}

test("doctor --db lists the done and the gate job whose rows are gone, with project, slug, last status and PR", async (t) => {
  const { env, doneId, gateId } = await seedLostJobs(t, "lost-doctor");

  const row = await lostJobsRow(env);

  assert.equal(row.status, "warn");
  assert.equal(row.detail, `J-${doneId} AP/${DONE_SLUG} last=done pr=${PR_URL}; J-${gateId} AP/${GATE_SLUG} last=gate pr=-`);
  assert.equal(row.hint, "nightqueue queue repair --from-disk");
  const found = await findLostJobs(env, openStore(env));
  assert.deepEqual(
    found.lost.map(({ jobId, hasLog, hasWorktree }) => ({ jobId, hasLog, hasWorktree })),
    [
      { jobId: doneId, hasLog: true, hasWorktree: false },
      { jobId: gateId, hasLog: true, hasWorktree: true },
    ],
  );
});

test("queue repair --from-disk rebuilds both rows with the recovered marker and never writes the issues", async (t) => {
  const { env, projectId, doneId, gateId, before } = await seedLostJobs(t, "lost-repair");
  const issuesBefore = issueSnapshot(env);

  const answer = JSON.parse(cli(env, ["queue", "repair", "--from-disk", "--json"]));

  assert.deepEqual(answer.recovered.map((entry) => entry.result), ["recovered as done", "recovered as gate"]);
  const done = jobRow(env, doneId);
  const gate = jobRow(env, gateId);
  assert.deepEqual(
    { status: done.status, pr: done.pr_url, slug: done.slug, branch: done.branch, project: done.project_id },
    { status: "done", pr: PR_URL, slug: DONE_SLUG, branch: before.done.branch, project: projectId },
  );
  assert.deepEqual({ status: gate.status, notice: gate.notice_md, slug: gate.slug }, { status: "gate", notice: before.gate.notice_md, slug: GATE_SLUG });
  for (const row of [done, gate]) {
    assert.equal(resultOf(row).recovered.from, "disk");
    assert.ok(!Number.isNaN(Date.parse(resultOf(row).recovered.at)));
    assert.equal(row.worker, null);
  }
  assert.equal(issueSnapshot(env), issuesBefore, "the recovery wrote an issue row or comment");
  assert.match(readFileSync(jobLogPath(doneId, env), "utf8"), new RegExp(`recovered from disk: status=done prUrl=${PR_URL.replace(/[.]/g, "\\.")}\\n$`));
  assert.match(readFileSync(jobLogPath(gateId, env), "utf8"), /recovered from disk: status=gate prUrl=-\n$/);

  const again = JSON.parse(cli(env, ["queue", "repair", "--from-disk", `J-${doneId}`, "--json"]));
  assert.deepEqual(again.recovered.map((entry) => entry.result), ["exists"]);
  assert.equal(cli(env, ["queue", "repair", "--from-disk"]).trim(), "no job on disk is missing from the table");
  assert.equal((await lostJobsRow(env)).detail, "no job on disk is missing from the table");
});

test("two repair --from-disk processes fired concurrently leave one row per job", async (t) => {
  const { env, doneId, gateId } = await seedLostJobs(t, "lost-concurrent");

  const answers = await Promise.all([cliAsync(env, ["queue", "repair", "--from-disk", "--json"]), cliAsync(env, ["queue", "repair", "--from-disk", "--json"])]);

  for (const answer of answers) assert.equal(answer.code, 0, answer.stderr);
  const results = answers.flatMap((answer) => JSON.parse(answer.stdout).recovered);
  for (const id of [doneId, gateId]) {
    const outcomes = results.filter((entry) => entry.jobId === id).map((entry) => entry.result);
    assert.equal(outcomes.filter((result) => result.startsWith("recovered as ")).length, 1, JSON.stringify(results));
    assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs WHERE id = ?").get(id).n, 1);
    assert.equal(readFileSync(jobLogPath(id, env), "utf8").match(/recovered from disk:/g).length, 1);
  }
});

test("a job log with no run and no row is reported in the tail, never rebuilt", async (t) => {
  const { env, doneId, gateId } = await seedLostJobs(t, "lost-log-only");
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(999, env), "=== attempt 1 @ 2026-09-01T00:00:00.000Z ===\n");

  const row = await lostJobsRow(env);
  const output = cli(env, ["queue", "repair", "--from-disk"]).trim().split("\n");

  assert.equal(row.status, "warn");
  assert.equal(row.hint, "nightqueue queue repair --from-disk");
  assert.match(row.detail, /; and 1 job log with no run and no row \(J-999\)$/);
  assert.deepEqual(output, [
    `J-${doneId} AP/${DONE_SLUG}: recovered as done (${PR_URL})`,
    `J-${gateId} AP/${GATE_SLUG}: recovered as gate`,
    "and 1 job log with no run and no row (J-999)",
  ]);
  assert.equal(jobRow(env, 999), null);
});

test("on a database that cannot be read, the lost jobs row is unknown and still names the jobs on disk", async (t) => {
  const { env, doneId, gateId } = await seedLostJobs(t, "lost-sick");
  const sick = makeSickHome(env);
  t.after(() => sick.restore());

  const row = await lostJobsRow(env);

  assert.deepEqual(
    { status: row.status, detail: row.detail, hint: row.hint },
    { status: "warn", detail: `unknown: the table cannot be read; on disk: J-${doneId}, J-${gateId}`, hint: "nightqueue doctor --fix" },
  );
});

test("a lost job a live runner still lists is skipped as still running", async (t) => {
  const { env, doneId, gateId } = await seedLostJobs(t, "lost-running");
  writeRunnerRecord({ pid: process.pid, mode: "once", jobId: doneId, startedAt: new Date().toISOString() }, env);

  const { results } = await recoverFromDisk({ env });

  assert.deepEqual(results.map((entry) => [entry.jobId, entry.result]), [
    [doneId, "skipped: still running"],
    [gateId, "recovered as gate"],
  ]);
  assert.equal(jobRow(env, doneId), null);
  assert.equal(jobRow(env, gateId).status, "gate");
});

test("(ii) a -wal truncated mid-frame drops rows silently, and the detector finds the jobs whose run is on disk", async (t) => {
  const source = makeHome(t, "lost-wal-source");
  const projectId = ensureProject(source, "alpha");
  const held = openDb(source);
  held.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  held.exec("PRAGMA wal_autocheckpoint = 0");
  const ids = [];
  for (let i = 0; i < 20; i += 1) ids.push(addJob({ projectId, prompt: `job ${i} ${"x".repeat(2000)}` }, source).id);
  const target = makeHome(t, "lost-wal-target");
  mkdirSync(homeDir(target), { recursive: true });
  copyFileSync(dbPath(source), dbPath(target));
  copyFileSync(dbWalPath(source), dbWalPath(target));
  truncateSync(dbWalPath(target), statSync(dbWalPath(target)).size - 2000);
  for (const id of ids) {
    const block = { id, ref: `J-${id}`, projectKey: "AP", itemRef: null, decisionRefs: [], createdAt: new Date().toISOString() };
    assert.equal(recordJobBlock({ projectId, slug: `run-${id}`, block, env: target }).status, "written");
  }

  const { lost } = await findLostJobs(target, openStore(target));

  const kept = new Set((await openStore(target).jobs.existingJobIds(ids)));
  const dropped = ids.filter((id) => !kept.has(id));
  assert.ok(dropped.length > 0, "the truncated WAL dropped no row");
  assert.deepEqual(lost.map((entry) => entry.jobId), dropped);
  assert.ok(lost.every((entry) => entry.lastStatus === "unknown" && entry.hasLog === false));
});

const RECOVERED_REFUSAL = (id) =>
  `J-${id} was rebuilt from disk by \`nightqueue queue repair --from-disk\` and its prompt was not kept, so it cannot run again; queue the task anew with \`nightqueue queue add\``;

// The fields a refused retry must leave exactly as they were.
function retryFields(env, id) {
  const row = jobRow(env, id);
  return { status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts, note: row.operator_note, prompt: row.prompt };
}

// Calls `queue_retry` on the real tool server, in process.
async function mcpRetry(t, env, id) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-recovered-retry", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return await client.callTool({ name: "queue_retry", arguments: { job_id: `J-${id}`, note: "go" } });
}

test("a row rebuilt by repair --from-disk is never retried, by the CLI or by MCP, and a normal gate still is", async (t) => {
  const { env, projectId, gateId } = await seedLostJobs(t, "lost-retry-recovered");
  cli(env, ["queue", "repair", "--from-disk"]);
  const before = retryFields(env, gateId);

  const refused = spawnSync(process.execPath, [CLI, "queue", "retry", `J-${gateId}`, "--note", "go"], { env, encoding: "utf8" });
  const answer = await mcpRetry(t, env, gateId);

  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(refused.stderr.trim(), `nightqueue: ${RECOVERED_REFUSAL(gateId)}`);
  assert.equal(answer.isError, true);
  assert.match(answer.content.map((block) => block.text).join("\n"), new RegExp(RECOVERED_REFUSAL(gateId).replace(/[.*+?^${}()|[\]\\`]/g, "\\$&")));
  assert.deepEqual(retryFields(env, gateId), before);

  const normal = addJob({ projectId, prompt: "a normal task" }, env).id;
  claimJobById(normal, { worker: "test:worker", cap: null }, env);
  finishJob(normal, { worker: "test:worker", status: "gate", noticeMd: "needs an answer" }, env);
  cli(env, ["queue", "retry", `J-${normal}`, "--note", "go"]);
  assert.equal(getJob(normal, env).status, "pending");
});

test("job logs with no run and no row alone leave lost jobs ok, named for reading only", async (t) => {
  const env = makeHome(t, "lost-log-only-ok");
  ensureProject(env, "alpha");
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(998, env), "=== attempt 1 @ 2026-09-01T00:00:00.000Z ===\n");

  const row = await lostJobsRow(env);

  assert.deepEqual(row, {
    name: "lost jobs",
    status: "ok",
    detail: "no job on disk is missing from the table; and 1 job log with no run and no row (J-998), kept for reading only",
    hint: null,
  });
});
