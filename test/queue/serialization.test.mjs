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
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:1000";
const OTHER_WORKER = "host:2000";
const CAP = 4;

// Registers a REAL git repository (not the `.git` directory double of makeProject) as a project.
function makeRealGitProject(t, env, name) {
  const path = makeDir(t, `repo-${name}`);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", path]);
  execFileSync("git", ["-C", path, "commit", "--allow-empty", "-q", "-m", "init"]);
  saveConfig(addProject(loadConfig(env, { warn: () => {} }), { path, name }).config, env);
  return path;
}

// Writes a stand-in for the child pipeline: it runs a REAL `git worktree add` in the canonical checkout it
// was spawned into, records its start/end window, removes the worktree as the real pipeline does and reports a run.
function writeRealGitClaude(t) {
  const dir = makeDir(t, "serialization-bin");
  const bin = join(dir, "real-git-claude.mjs");
  const logPath = join(dir, "calls.jsonl");
  const source = [
    "#!/usr/bin/env node",
    'import { execFileSync } from "node:child_process";',
    'import { appendFileSync } from "node:fs";',
    "",
    "function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }",
    "",
    "async function main() {",
    '  const jobId = process.env.NIGHTSHIFT_JOB_ID ?? "unknown";',
    `  const logPath = ${JSON.stringify(logPath)};`,
    "  const branch = `nightshift/job-${jobId}`;",
    "  const dir = `worktree-${jobId}`;",
    "  const start = Date.now();",
    "  let result;",
    "  try {",
    '    execFileSync("git", ["worktree", "add", "-b", branch, dir], { stdio: ["ignore", "pipe", "pipe"] });',
    '    execFileSync("git", ["worktree", "remove", dir], { stdio: ["ignore", "pipe", "pipe"] });',
    "    result = { jobId, ok: true, dir, branch };",
    "  } catch (err) {",
    "    result = { jobId, ok: false, message: String(err?.stderr ?? err?.message ?? err) };",
    "  }",
    "  await sleep(300);",
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

test("a busy project is SKIPPED by the claim instead of blocking the whole queue behind it", (t) => {
  const env = makeHome(t, "serialization-claim");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const first = addJob({ project: "alpha", prompt: "fix the worker", priority: 1 }, env).id;
  const second = addJob({ project: "alpha", prompt: "fix the parser", priority: 2 }, env).id;
  const other = addJob({ project: "beta", prompt: "fix the linter", priority: 3 }, env).id;

  assert.equal(claimNextJob({ worker: WORKER, cap: CAP }, env).id, first);
  assert.equal(peekNextJob(env).id, other, "the dry report announced a job the next claim would refuse");
  assert.equal(claimNextJob({ worker: OTHER_WORKER, cap: CAP }, env).id, other, "a busy project blocked the jobs behind it");
  assert.equal(claimJobById(second, { worker: OTHER_WORKER, cap: CAP }, env), null, "two jobs of the same project ran at once");
  assert.equal(getJob(second, env).attempts, 0, "the refused claim spent an attempt");
  assert.deepEqual(acquire({ jobId: second, cap: CAP, env }), { job: null, reason: "project-busy" });
  assert.deepEqual(acquire({ cap: CAP, env }), { job: null, reason: "project-busy" });

  assert.equal(finishJob(first, { worker: WORKER, status: "done" }, env), true);
  assert.equal(claimNextJob({ worker: WORKER, cap: CAP }, env).id, second, "the project stayed busy after its job finished");
});

test("two jobs of the SAME project never overlap: their real children run one strictly after the other", async (t) => {
  const env = makeHome(t, "serialization-same-project");
  const project = makeRealGitProject(t, env, "alpha");
  const { bin, logPath } = writeRealGitClaude(t);
  env.NIGHTSHIFT_CLAUDE_BIN = bin;

  const job1 = addJob({ project: "alpha", prompt: "fix the worker", timeoutS: 120 }, env).id;
  const job2 = addJob({ project: "alpha", prompt: "fix the parser", timeoutS: 120 }, env).id;

  const cycle = await runCycle({ env });

  assert.deepEqual(
    cycle.processed.map((job) => job.id).sort((a, b) => a - b),
    [job1, job2],
    `both same-project jobs should have run, in series: ${JSON.stringify(cycle.processed)}`,
  );
  const calls = readCalls(logPath);
  assert.equal(calls.length, 2, `both children should have run their own real git worktree add: ${JSON.stringify(calls)}`);
  for (const call of calls) assert.equal(call.ok, true, `a real git worktree add failed: ${JSON.stringify(call)}`);
  const [first, second] = calls;
  assert.ok(
    first.end <= second.start,
    `two children of the same project overlapped in the same checkout: ${JSON.stringify(calls)}`,
  );
  assert.equal(existsSync(join(project, `worktree-${job1}`)), false, "the first child left its worktree in the checkout");

  const job3 = addJob({ project: "alpha", prompt: "fix the linter", timeoutS: 120 }, env).id;
  const third = await runCycle({ jobId: job3, env });
  assert.notEqual(third.processed[0]?.code, "dirty-checkout", `job 3 was blocked by what the other jobs left behind: ${JSON.stringify(third.processed)}`);
});

test("a job of ANOTHER project runs beside the busy one while maxConcurrent allows it", async (t) => {
  const env = makeHome(t, "serialization-other-project");
  makeRealGitProject(t, env, "alpha");
  makeRealGitProject(t, env, "beta");
  const { bin, logPath } = writeRealGitClaude(t);
  env.NIGHTSHIFT_CLAUDE_BIN = bin;

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
    alphaOne.end <= alphaTwo.start,
    `the two jobs of \`alpha\` overlapped: ${JSON.stringify([alphaOne, alphaTwo])}`,
  );
});
