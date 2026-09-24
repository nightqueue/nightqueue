import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { addProject } from "../../src/config/projects.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { addJob, claimJobById, claimNextJob, finishJob, getJob, peekNextJob } from "../../src/memory/jobs.mjs";
import { acquire } from "../../src/queue/claim.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:1000";
const OTHER_WORKER = "host:2000";
const CAP = 4;
const CYCLE = fileURLToPath(new URL("../../test-support/queue-cycle.mjs", import.meta.url));
const CYCLE_BARRIER_MS = 1500;
const CROSS_PROCESS_HOLD_MS = 1500;

// Registers a REAL git repository (not the `.git` directory double of makeProject) as a project.
function makeRealGitProject(t, env, name) {
  const path = initGitRepo(makeDir(t, `repo-${name}`));
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// Writes a stand-in for the child pipeline: it runs a REAL `git worktree add` outside the canonical checkout it
// was spawned into, records its start/end window and runner pid, removes the worktree as the real pipeline does and reports a run.
function writeRealGitClaude(t, { holdMs = 300 } = {}) {
  const dir = makeDir(t, "parallel-bin");
  const bin = join(dir, "real-git-claude.mjs");
  const logPath = join(dir, "calls.jsonl");
  const worktreeRoot = makeDir(t, "parallel-worktrees");
  const source = [
    "#!/usr/bin/env node",
    'import { execFileSync } from "node:child_process";',
    'import { appendFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "",
    "function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }",
    "",
    "async function main() {",
    '  const jobId = process.env.NIGHTQUEUE_JOB_ID ?? "unknown";',
    `  const logPath = ${JSON.stringify(logPath)};`,
    `  const worktreeRoot = ${JSON.stringify(worktreeRoot)};`,
    "  const branch = `nightqueue/job-${jobId}`;",
    "  const dir = join(worktreeRoot, `worktree-${jobId}`);",
    "  const start = Date.now();",
    "  let result;",
    "  try {",
    '    execFileSync("git", ["worktree", "add", "-b", branch, dir], { stdio: ["ignore", "pipe", "pipe"] });',
    `    await sleep(${JSON.stringify(holdMs)});`,
    '    execFileSync("git", ["worktree", "remove", dir], { stdio: ["ignore", "pipe", "pipe"] });',
    "    result = { jobId, ok: true, dir, branch };",
    "  } catch (err) {",
    "    result = { jobId, ok: false, message: String(err?.stderr ?? err?.message ?? err) };",
    "  }",
    "  result.runnerPid = process.ppid;",
    "  result.start = start;",
    "  result.end = Date.now();",
    "  appendFileSync(logPath, `${JSON.stringify(result)}\\n`);",
    "  const events = [",
    '    { type: "system", subtype: "init", session_id: "sess-abc12345" },',
    '    { type: "result", subtype: "success", result: `Done. Pull request: https://github.com/acme/api/pull/${jobId}` },',
    "  ];",
    '  process.stdout.write(`${events.map((event) => JSON.stringify(event)).join("\\n")}\\n`);',
    "  process.exitCode = result.ok ? 0 : 1;",
    "}",
    "",
    "await main();",
    "",
  ].join("\n");
  writeFileSync(bin, source);
  chmodSync(bin, 0o755);
  return { bin, logPath };
}

// Every call the real-git double recorded, in the order the children finished.
function readCalls(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Runs one runner cycle as a real child process that starts at the shared barrier instant.
function cycleInProcess(env, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CYCLE, String(startAt)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Starts `count` runner processes over one home at the same instant and returns the cycle each one reported.
async function runCyclesInProcesses(env, count) {
  const startAt = Date.now() + CYCLE_BARRIER_MS;
  const results = await Promise.all(Array.from({ length: count }, () => cycleInProcess(env, startAt)));
  return results.map((result) => {
    assert.equal(result.code, 0, `runner process exited ${result.code}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  });
}

// The recorded calls of the given jobs, in job order, failing when a job has no call or more than one.
function callsOf(logPath, ids) {
  const calls = readCalls(logPath);
  return ids.map((id) => {
    const own = calls.filter((call) => Number(call.jobId) === id);
    assert.equal(own.length, 1, `job ${id} should have run exactly once: ${JSON.stringify(calls)}`);
    assert.equal(own[0].ok, true, `a real git worktree add failed: ${JSON.stringify(own[0])}`);
    return own[0];
  });
}

// Tells whether two recorded call windows overlap in time.
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

// Asserts that ONE runner cycle ran the given jobs strictly one after the other, in that order.
async function assertOneRunnerSerializes(env, logPath, ids) {
  const cycle = await runCycle({ env });
  assert.deepEqual(
    cycle.processed.map((job) => job.id),
    ids,
    `one runner should have run every job in queue order: ${JSON.stringify(cycle.processed)}`,
  );
  const calls = callsOf(logPath, ids);
  for (let index = 1; index < calls.length; index += 1) {
    assert.ok(calls[index - 1].end <= calls[index].start, `one runner ran two jobs at the same time: ${JSON.stringify(calls)}`);
  }
}

// Asserts that two runner processes each took one of the two jobs and ran them at the same time.
async function assertTwoRunnersOverlap(env, logPath, ids) {
  const cycles = await runCyclesInProcesses(env, 2);
  const processed = cycles.flatMap((cycle) => cycle.processed.map((job) => job.id));
  assert.deepEqual(
    [...processed].sort((a, b) => a - b),
    ids,
    `across both runner processes each job should have run exactly once: ${JSON.stringify(cycles)}`,
  );
  const [first, second] = callsOf(logPath, ids);
  assert.ok(overlaps(first, second), `two runner processes ran their jobs one strictly after the other: ${JSON.stringify([first, second])}`);
  assert.notEqual(first.runnerPid, second.runnerPid, `both jobs were run by the same runner process: ${JSON.stringify([first, second])}`);
}

test("two jobs of the same project are claimed together, bounded only by the concurrency cap", async (t) => {
  const env = makeHome(t, "parallel-claim");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const first = addJob({ project: "alpha", prompt: "fix the worker", priority: 1 }, env).id;
  const second = addJob({ project: "alpha", prompt: "fix the parser", priority: 2 }, env).id;
  const other = addJob({ project: "beta", prompt: "fix the linter", priority: 3 }, env).id;

  assert.equal(claimNextJob({ worker: WORKER, cap: CAP }, env).id, first);
  assert.equal(peekNextJob(env).id, second, "the dry report skipped the next pending job of a project already running one");
  assert.equal(claimJobById(second, { worker: OTHER_WORKER, cap: CAP }, env).id, second, "a second job of the same project was refused");
  assert.equal(getJob(second, env).attempts, 1);
  assert.equal((await acquire({ cap: CAP, env })).job.id, other);

  assert.deepEqual(await acquire({ cap: CAP, env }), { job: null, reason: "empty-queue" });
  const fourth = addJob({ project: "alpha", prompt: "fix the docs", priority: 4 }, env).id;
  assert.deepEqual(await acquire({ cap: 3, env }), { job: null, reason: "cap-reached" }, "the ceiling is the only limit left");
  assert.deepEqual(await acquire({ jobId: fourth, cap: 3, env }), { job: null, reason: "cap-reached" });

  assert.equal(finishJob(first, { worker: WORKER, status: "done" }, env), true);
  assert.equal(claimNextJob({ worker: WORKER, cap: 3 }, env).id, fourth, "the freed slot was not spent on the next pending job");
});

test("two jobs of the SAME project never overlap inside ONE runner, and do across TWO runner processes", async (t) => {
  const serialEnv = makeHome(t, "parallel-same-project-one-runner");
  makeRealGitProject(t, serialEnv, "alpha");
  const serial = writeRealGitClaude(t);
  serialEnv.NIGHTQUEUE_CLAUDE_BIN = serial.bin;
  const serialIds = [
    addJob({ project: "alpha", prompt: "fix the worker", priority: 1, timeoutS: 120 }, serialEnv).id,
    addJob({ project: "alpha", prompt: "fix the parser", priority: 2, timeoutS: 120 }, serialEnv).id,
  ];
  await assertOneRunnerSerializes(serialEnv, serial.logPath, serialIds);

  const parallelEnv = makeHome(t, "parallel-same-project-two-runners");
  makeRealGitProject(t, parallelEnv, "alpha");
  const parallel = writeRealGitClaude(t, { holdMs: CROSS_PROCESS_HOLD_MS });
  parallelEnv.NIGHTQUEUE_CLAUDE_BIN = parallel.bin;
  const parallelIds = [
    addJob({ project: "alpha", prompt: "fix the worker", timeoutS: 120 }, parallelEnv).id,
    addJob({ project: "alpha", prompt: "fix the parser", timeoutS: 120 }, parallelEnv).id,
  ];
  await assertTwoRunnersOverlap(parallelEnv, parallel.logPath, parallelIds);
});

test("a job of ANOTHER project never runs beside another inside ONE runner, and does across TWO runner processes", async (t) => {
  const serialEnv = makeHome(t, "parallel-other-project-one-runner");
  makeRealGitProject(t, serialEnv, "alpha");
  makeRealGitProject(t, serialEnv, "beta");
  const serial = writeRealGitClaude(t);
  serialEnv.NIGHTQUEUE_CLAUDE_BIN = serial.bin;
  saveConfig({ ...loadConfig(serialEnv, { warn: () => {} }), queue: { maxConcurrent: 3 } }, serialEnv);
  const serialIds = [
    addJob({ project: "alpha", prompt: "fix the worker", priority: 1, timeoutS: 120 }, serialEnv).id,
    addJob({ project: "beta", prompt: "fix the linter", priority: 2, timeoutS: 120 }, serialEnv).id,
  ];
  await assertOneRunnerSerializes(serialEnv, serial.logPath, serialIds);

  const parallelEnv = makeHome(t, "parallel-other-project-two-runners");
  makeRealGitProject(t, parallelEnv, "alpha");
  makeRealGitProject(t, parallelEnv, "beta");
  const parallel = writeRealGitClaude(t, { holdMs: CROSS_PROCESS_HOLD_MS });
  parallelEnv.NIGHTQUEUE_CLAUDE_BIN = parallel.bin;
  const parallelIds = [
    addJob({ project: "alpha", prompt: "fix the worker", timeoutS: 120 }, parallelEnv).id,
    addJob({ project: "beta", prompt: "fix the linter", timeoutS: 120 }, parallelEnv).id,
  ];
  await assertTwoRunnersOverlap(parallelEnv, parallel.logPath, parallelIds);
});

test("a same-project job whose canonical checkout another job dirtied is blocked, keeps its attempt and stays pending", async (t) => {
  const env = makeHome(t, "parallel-dirty-checkout");
  const project = makeRealGitProject(t, env, "alpha");
  const { bin } = writeRealGitClaude(t);
  env.NIGHTQUEUE_CLAUDE_BIN = bin;
  // What a project that does NOT ignore the pipeline's worktree directory looks like while a first job runs:
  // the worktree of that job sits inside the canonical checkout the next job would branch from.
  execFileSync("git", ["-C", project, "worktree", "add", "-b", "nightqueue/job-in-flight", join(project, "worktree-in-flight")], { stdio: "ignore" });
  const id = addJob({ project: "alpha", prompt: "fix the parser", timeoutS: 120 }, env).id;

  const cycle = await runCycle({ jobId: id, env });

  assert.deepEqual(cycle.processed, [{ id, status: "blocked", code: "dirty-checkout" }]);
  const row = getJob(id, env);
  assert.equal(row.status, "pending", "a job blocked by the preflight was lost instead of staying in the queue");
  assert.equal(row.attempts, 0, "the blocked job spent an attempt it never used");
  assert.match(String(row.result), /dirty-checkout/);
});
