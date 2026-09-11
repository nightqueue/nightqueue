import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { ensureHome } from "../../src/config/store.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { writeRunnerPidfile } from "../../src/queue/pidfile.mjs";
import { runCycle, runDrain } from "../../src/queue/runner.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const WARNING = /^runtime directory (.+) is gone - this runner finishes the job it is running and exits; start a new runner with: nightshift queue run$/m;

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit(onCall = () => {}) {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    onCall(args);
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// Collects what the runner writes on stderr for the length of the test.
function captureStderr(t) {
  const written = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return original(chunk, ...rest);
  };
  t.after(() => {
    process.stderr.write = original;
  });
  return () => written.join("");
}

// A home with the registered projects, the fake `claude`, and this process registered as the runner of a runtime directory of its own.
function makeRunnerHome(t, name, { projects = ["alpha"] } = {}) {
  const env = makeHome(t, name);
  for (const project of projects) makeProject(t, env, project);
  useFakeClaude(env, makeDir(t, `${name}-plan`), [{ stdout: doneStream(), exitCode: 0 }]);
  const runtimeDir = makeDir(t, `${name}-runtime`);
  ensureHome(env);
  writeRunnerPidfile({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain", intervalS: null, logPath: null, runtimeDir }, env);
  return { env, runtimeDir };
}

test("a runner whose runtime directory is gone claims nothing, says so and leaves the queue untouched", async (t) => {
  const { env, runtimeDir } = makeRunnerHome(t, "runtime-gone-idle");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const stderr = captureStderr(t);
  rmSync(runtimeDir, { recursive: true, force: true });

  const cycle = await runCycle({ env, deps: { gitImpl: fakeGit() } });

  assert.equal(cycle.reason, "runtime-gone");
  assert.deepEqual(cycle.processed, [], "a runner running from a tree that is gone claimed a job anyway");
  assert.equal(getJob(id, env).status, "pending");
  assert.match(stderr(), WARNING);
  assert.equal(stderr().includes(runtimeDir), true, `the warning does not name the directory that is gone: ${stderr()}`);
});

test("a runtime that disappears mid-run lets the job in flight finish, and stops the runner before the next one", async (t) => {
  const { env, runtimeDir } = makeRunnerHome(t, "runtime-gone-in-flight", { projects: ["alpha", "beta"] });
  const running = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const next = addJob({ project: "beta", prompt: "fix the parser" }, env).id;
  captureStderr(t);
  const gitImpl = fakeGit(() => rmSync(runtimeDir, { recursive: true, force: true }));

  const passes = await runDrain({ max: 1, env, deps: { gitImpl } });

  assert.deepEqual(
    passes.map((pass) => pass.reason),
    ["runtime-gone"],
    "the drain kept passing over the queue after the tree it runs from was gone",
  );
  assert.deepEqual(
    passes[0].processed.map((job) => ({ id: job.id, status: job.status })),
    [{ id: running, status: "done" }],
    "the job in flight was abandoned instead of being finished",
  );
  assert.equal(getJob(next, env).status, "pending", "the runner claimed another job after its runtime was gone");
});
