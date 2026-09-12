import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
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

// Registers a REAL git repository (not the `.git` directory double of makeProject) as a project.
function makeRealGitProject(t, env, name) {
  const path = initGitRepo(makeDir(t, `repo-${name}`));
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// Writes a stand-in for the child pipeline: it runs a REAL `git worktree add` outside the canonical checkout it
// was spawned into, records its start/end window, removes the worktree as the real pipeline does and reports a run.
function writeRealGitClaude(t) {
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
    '  const jobId = process.env.NIGHTSHIFT_JOB_ID ?? "unknown";',
    `  const logPath = ${JSON.stringify(logPath)};`,
    `  const worktreeRoot = ${JSON.stringify(worktreeRoot)};`,
    "  const branch = `nightshift/job-${jobId}`;",
    "  const dir = join(worktreeRoot, `worktree-${jobId}`);",
    "  const start = Date.now();",
    "  let result;",
    "  try {",
    '    execFileSync("git", ["worktree", "add", "-b", branch, dir], { stdio: ["ignore", "pipe", "pipe"] });',
    "    await sleep(300);",
    '    execFileSync("git", ["worktree", "remove", dir], { stdio: ["ignore", "pipe", "pipe"] });',
    "    result = { jobId, ok: true, dir, branch };",
    "  } catch (err) {",
    "    result = { jobId, ok: false, message: String(err?.stderr ?? err?.message ?? err) };",
    "  }",
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

test("two jobs of the same project are claimed together, bounded only by the concurrency cap", (t) => {
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
  assert.equal(acquire({ cap: CAP, env }).job.id, other);

  assert.deepEqual(acquire({ cap: CAP, env }), { job: null, reason: "empty-queue" });
  const fourth = addJob({ project: "alpha", prompt: "fix the docs", priority: 4 }, env).id;
  assert.deepEqual(acquire({ cap: 3, env }), { job: null, reason: "cap-reached" }, "the ceiling is the only limit left");
  assert.deepEqual(acquire({ jobId: fourth, cap: 3, env }), { job: null, reason: "cap-reached" });

  assert.equal(finishJob(first, { worker: WORKER, status: "done" }, env), true);
  assert.equal(claimNextJob({ worker: WORKER, cap: 3 }, env).id, fourth, "the freed slot was not spent on the next pending job");
});

test("two jobs of the SAME project run at the same time: their real children OVERLAP", async (t) => {
  const env = makeHome(t, "parallel-same-project");
  makeRealGitProject(t, env, "alpha");
  const { bin, logPath } = writeRealGitClaude(t);
  env.NIGHTSHIFT_CLAUDE_BIN = bin;

  const job1 = addJob({ project: "alpha", prompt: "fix the worker", timeoutS: 120 }, env).id;
  const job2 = addJob({ project: "alpha", prompt: "fix the parser", timeoutS: 120 }, env).id;

  const cycle = await runCycle({ env });

  assert.deepEqual(
    cycle.processed.map((job) => job.id).sort((a, b) => a - b),
    [job1, job2],
    `both same-project jobs should have run: ${JSON.stringify(cycle.processed)}`,
  );
  const calls = readCalls(logPath);
  assert.equal(calls.length, 2, `both children should have run their own real git worktree add: ${JSON.stringify(calls)}`);
  for (const call of calls) assert.equal(call.ok, true, `a real git worktree add failed: ${JSON.stringify(call)}`);
  const [first, second] = calls;
  assert.ok(
    first.start < second.end && second.start < first.end,
    `two children of the same project ran one strictly after the other: ${JSON.stringify(calls)}`,
  );
});

test("a job of ANOTHER project runs beside them while maxConcurrent allows it", async (t) => {
  const env = makeHome(t, "parallel-other-project");
  makeRealGitProject(t, env, "alpha");
  makeRealGitProject(t, env, "beta");
  const { bin, logPath } = writeRealGitClaude(t);
  env.NIGHTSHIFT_CLAUDE_BIN = bin;
  saveConfig({ ...loadConfig(env, { warn: () => {} }), queue: { maxConcurrent: 3 } }, env);

  const alphaFirst = addJob({ project: "alpha", prompt: "fix the worker", priority: 1, timeoutS: 120 }, env).id;
  const alphaSecond = addJob({ project: "alpha", prompt: "fix the parser", priority: 2, timeoutS: 120 }, env).id;
  const betaJob = addJob({ project: "beta", prompt: "fix the linter", priority: 3, timeoutS: 120 }, env).id;

  const cycle = await runCycle({ env });

  assert.deepEqual(
    cycle.processed.map((job) => job.id).sort((a, b) => a - b),
    [alphaFirst, alphaSecond, betaJob],
    `every job should have run: ${JSON.stringify(cycle.processed)}`,
  );
  const byJob = new Map(readCalls(logPath).map((call) => [Number(call.jobId), call]));
  const alphaOne = byJob.get(alphaFirst);
  const alphaTwo = byJob.get(alphaSecond);
  const beta = byJob.get(betaJob);
  assert.ok(
    alphaOne.start < beta.end && beta.start < alphaOne.end,
    `the job of the other project waited instead of running beside the first one: ${JSON.stringify([alphaOne, beta])}`,
  );
  assert.ok(
    alphaOne.start < alphaTwo.end && alphaTwo.start < alphaOne.end,
    `the two jobs of \`alpha\` did not overlap: ${JSON.stringify([alphaOne, alphaTwo])}`,
  );
});

test("a same-project job whose canonical checkout another job dirtied is blocked, keeps its attempt and stays pending", async (t) => {
  const env = makeHome(t, "parallel-dirty-checkout");
  const project = makeRealGitProject(t, env, "alpha");
  const { bin } = writeRealGitClaude(t);
  env.NIGHTSHIFT_CLAUDE_BIN = bin;
  // What a project that does NOT ignore the pipeline's worktree directory looks like while a first job runs:
  // the worktree of that job sits inside the canonical checkout the next job would branch from.
  execFileSync("git", ["-C", project, "worktree", "add", "-b", "nightshift/job-in-flight", join(project, "worktree-in-flight")], { stdio: "ignore" });
  const id = addJob({ project: "alpha", prompt: "fix the parser", timeoutS: 120 }, env).id;

  const cycle = await runCycle({ jobId: id, env });

  assert.deepEqual(cycle.processed, [{ id, status: "blocked", code: "dirty-checkout" }]);
  const row = getJob(id, env);
  assert.equal(row.status, "pending", "a job blocked by the preflight was lost instead of staying in the queue");
  assert.equal(row.attempts, 0, "the blocked job spent an attempt it never used");
  assert.match(String(row.result), /dirty-checkout/);
});
