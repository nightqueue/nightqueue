import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { FAKE_CLAUDE, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { GATE_NOTICE, PR_URL, recordedDone, recordedGate, recordedNoChange, recordedTermination, resultEvent, slugTypeEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const ENDED_QUIETLY = toNdjson([systemInitEvent(), resultEvent({ text: "Finished." })]);

// A git double answering the reads of the preflight with a clean checkout on its default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// Runs one job through the runner against one fake attempt, answering the home, the job id and the fake's plan.
async function runOneAttempt(t, name, attempt) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), [attempt]);
  const { id } = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env);
  await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });
  assert.equal(fakeCalls(planPath).length, 1, "the fake `claude` was never the binary that ran");
  return { env, id };
}

// Reads the state.json of a run of the test project.
function stateOf(env, slug) {
  return JSON.parse(readFileSync(join(runDir(projectIdOf(env, "alpha"), slug, env), "state.json"), "utf8"));
}

// Runs the fake directly with a prompt, the way the runner spawns it, answering how it exited and what it said.
function playFake(t, name, { prompt, attempt }) {
  const env = { ...process.env };
  useFakeClaude(env, makeDir(t, `${name}-plan`), [attempt]);
  return spawnSync(process.execPath, [FAKE_CLAUDE, "-p", prompt], { env, encoding: "utf8" });
}

test("the fake `claude` the seam depends on exists and is executable", () => {
  accessSync(FAKE_CLAUDE, constants.X_OK);
});

test("a recorded delivery reaches the row with no pull request in the stream", async (t) => {
  const { env, id } = await runOneAttempt(t, "seam-done", { runState: recordedDone({ notice: "recorded notice" }), stdout: ENDED_QUIETLY, exitCode: 0 });

  const row = getJob(id, env);
  assert.deepEqual([row.status, row.pr_url, row.notice_md], ["done", PR_URL, "recorded notice"]);
});

test("a recorded gate reaches the row with no heading in the stream", async (t) => {
  const { env, id } = await runOneAttempt(t, "seam-gate", { runState: recordedGate(), stdout: ENDED_QUIETLY, exitCode: 0 });

  const row = getJob(id, env);
  assert.deepEqual([row.status, row.notice_md], ["gate", GATE_NOTICE]);
});

test("a recorded conclusion of no change reaches the row with no pull request", async (t) => {
  const runState = { ...recordedNoChange(), ...recordedTermination({ phase: "triage", reason: "NO-CHANGE-NEEDED" }) };
  const { env, id } = await runOneAttempt(t, "seam-no-change", { runState, stdout: ENDED_QUIETLY, exitCode: 0 });

  const row = getJob(id, env);
  assert.deepEqual([row.status, row.pr_url], ["done", null]);
  assert.match(row.notice_md, /already does what the ticket asks/);
});

test("a recorded termination lands in the run's state.json next to the job block", async (t) => {
  const { env, id } = await runOneAttempt(t, "seam-termination", { runState: recordedTermination(), stdout: ENDED_QUIETLY, exitCode: 0 });

  const state = stateOf(env, getJob(id, env).slug);
  assert.deepEqual(state.termination, recordedTermination().termination);
  assert.equal(state.job.id, id);
});

test("a record follows the run when its stream renames the slug", async (t) => {
  const stdout = toNdjson([systemInitEvent(), slugTypeEvent("another-name"), resultEvent({ text: "Finished." })]);
  const { env, id } = await runOneAttempt(t, "seam-rename", { runState: recordedGate(), stdout, exitCode: 0 });

  const row = getJob(id, env);
  assert.deepEqual([row.slug, row.status], ["another-name", "gate"]);
  assert.equal(stateOf(env, "another-name").outcome.notice, GATE_NOTICE);
});

test("a record merges into the state.json the run already has", (t) => {
  const dir = makeDir(t, "seam-merge");
  writeFileSync(join(dir, "state.json"), JSON.stringify({ branch: "fix/the-worker", outcome: { prUrl: PR_URL, prTitle: "the title" } }));

  const played = playFake(t, "seam-merge", { prompt: `the job\nRUN_DIR: ${dir}\nmore`, attempt: { runState: recordedGate() } });

  assert.equal(played.status, 0, played.stderr);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  assert.equal(state.branch, "fix/the-worker");
  assert.deepEqual(state.outcome, { prUrl: PR_URL, prTitle: "the title", status: "gate", notice: GATE_NOTICE });
});

test("an attempt that records nothing writes no state.json", (t) => {
  const dir = makeDir(t, "seam-silent");

  const played = playFake(t, "seam-silent", { prompt: `RUN_DIR: ${dir}`, attempt: { stdout: ENDED_QUIETLY } });

  assert.equal(played.status, 0, played.stderr);
  assert.equal(existsSync(join(dir, "state.json")), false);
});

test("a record with no RUN_DIR in the prompt fails loudly instead of writing nothing", (t) => {
  const played = playFake(t, "seam-no-dir", { prompt: "the job", attempt: { runState: recordedGate() } });

  assert.equal(played.status, 97);
  assert.match(played.stderr, /FAKE_CLAUDE_ERROR: .*no RUN_DIR/);
});

test("a record refuses a run directory outside the system temp dir", (t) => {
  const outside = join(process.cwd(), "tmp", "seam-outside");
  // A checkout copied under the temp dir (the close's throwaway run of the suite) has no path outside it to try.
  if (realpathSync(process.cwd()).startsWith(realpathSync(tmpdir()) + sep)) {
    t.skip("the checkout itself is under the system temp dir");
    return;
  }
  mkdirSync(outside, { recursive: true });
  t.after(() => spawnSync("rm", ["-rf", outside]));

  const played = playFake(t, "seam-outside", { prompt: `RUN_DIR: ${outside}`, attempt: { runState: recordedGate() } });

  assert.equal(played.status, 97);
  assert.match(played.stderr, /refusing to write outside/);
  assert.equal(existsSync(join(outside, "state.json")), false);
});
