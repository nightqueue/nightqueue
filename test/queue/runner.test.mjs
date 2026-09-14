import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb, sqliteToIso } from "../../src/memory/db.mjs";
import { packageRoot } from "../../src/host/paths.mjs";
import { addJob, claimJobById, countsByStatus, getJob } from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { DRAIN_INTERVAL_S, runCycle, runDrain, runWatch, WATCH_INTERVAL_DEFAULT_S } from "../../src/queue/runner.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { argValue, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, failureStream, gateStream, PR_URL, resultEvent, SESSION_ID, SLUG, slugEvent, systemInitEvent, toNdjson, transientFailureStream } from "../../test-support/streams.mjs";

const PROMPT = "fix the worker";

// A git double for the preflight: a clean checkout of the default branch unless the test says otherwise.
function fakeGit({ status = "", branch = "main", originHead = "origin/main" } = {}) {
  const answers = { status, "rev-parse": branch, "symbolic-ref": originHead };
  const impl = ({ args }) => {
    const answer = answers[args[0]];
    if (answer === null || answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
  return impl;
}

// A git double that records, at every preflight, how many jobs of the home are running right then.
function countingGit(env, sink) {
  const git = fakeGit();
  return (call) => {
    if (call.args[0] === "status") sink.push(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'running'").get().n);
    return git(call);
  };
}

// A home with the registered projects, the fake `claude` and its plan of attempts.
function makeRunnerHome(t, name, attempts, { projects = ["alpha"] } = {}) {
  const env = makeHome(t, name);
  const repo = projects.map((project) => makeProject(t, env, project))[0];
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  return { env, repo, planPath };
}

// Enqueues one job of a test project.
function enqueue(env, { project = "alpha", prompt = PROMPT, maxAttempts, timeoutS } = {}) {
  return addJob({ project, prompt, maxAttempts, timeoutS }, env).id;
}

// Runs one cycle over a single job with the git reads injected.
function runJobCycle(env, jobId, deps = {}) {
  return runCycle({ jobId, env, deps: { gitImpl: fakeGit(), ...deps } });
}

// Waits the given number of milliseconds.
function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

// Polls a condition of the database while the runner is still working, instead of guessing a delay.
async function waitFor(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("a run that opens a pull request ends as done, with its facts, usage and pipeline run linked", async (t) => {
  const { env } = makeRunnerHome(t, "runner-done", [{ stdout: doneStream({ notice: "the pull request is open" }), exitCode: 0 }]);
  const id = enqueue(env);
  const logged = logPipelineRun({ project: "alpha", slug: SLUG, tier: "simple", outcome: "pr_opened", phases: [] }, env);

  const cycle = await runJobCycle(env, id);

  assert.deepEqual(cycle.processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }]);
  const row = getJob(id, env);
  assert.deepEqual(
    { status: row.status, pr: row.pr_url, slug: row.slug, session: row.session_id, notice: row.notice_md, worker: row.worker, lease: row.lease_until },
    { status: "done", pr: PR_URL, slug: SLUG, session: SESSION_ID, notice: "the pull request is open", worker: null, lease: null },
  );
  assert.deepEqual(
    { tokensIn: row.tokens_in, tokensOut: row.tokens_out, cacheRead: row.cache_read, cacheCreation: row.cache_creation, cost: row.cost_usd },
    { tokensIn: 1000, tokensOut: 200, cacheRead: 50, cacheCreation: 25, cost: 0.12 },
  );
  assert.deepEqual(JSON.parse(row.result), { status: "done", prUrl: PR_URL, logPath: jobLogPath(id, env), exitCode: 0, timedOut: false, idleTimedOut: false, attempts: 1 });
  assert.equal(openDb(env).prepare("SELECT job_id FROM pipeline_runs WHERE id = ?").get(logged.runId).job_id, id);
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /=== attempt 1 @ /);
});

test("the runner leaves the witness of the outcome next to the run, with its five keys and the tree it loaded from", async (t) => {
  const { env } = makeRunnerHome(t, "runner-witness", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);

  await runJobCycle(env, id);

  const state = JSON.parse(readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8"));
  assert.deepEqual(Object.keys(state.terminal), ["status", "prUrl", "finishedAt", "writtenBy", "pid"]);
  assert.deepEqual(
    { status: state.terminal.status, prUrl: state.terminal.prUrl, writtenBy: state.terminal.writtenBy, pid: state.terminal.pid },
    { status: "done", prUrl: PR_URL, writtenBy: packageRoot(), pid: process.pid },
  );
  assert.equal(state.terminal.finishedAt, sqliteToIso(getJob(id, env).finished_at));
});

test("a run that stops at the gate ends as gate and keeps the notice for the operator", async (t) => {
  const { env } = makeRunnerHome(t, "runner-gate", [{ stdout: gateStream(), exitCode: 0 }]);
  const id = enqueue(env);

  const cycle = await runJobCycle(env, id);

  assert.equal(cycle.processed[0].status, "gate");
  const row = getJob(id, env);
  assert.equal(row.status, "gate");
  assert.equal(row.pr_url, null);
  assert.equal(row.slug, SLUG);
});

test("a failure that no retry would fix ends the job at once, without a second attempt", async (t) => {
  const { env, planPath } = makeRunnerHome(t, "runner-failed", [{ stdout: failureStream(), exitCode: 1 }]);
  const id = enqueue(env, { maxAttempts: 3 });

  const cycle = await runJobCycle(env, id);

  assert.equal(cycle.processed[0].status, "failed");
  const row = getJob(id, env);
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 1, "a permanent failure was retried");
  assert.equal(JSON.parse(row.result).exitCode, 1);
  assert.equal(fakeCalls(planPath).length, 1);
});

test("a transient failure is retried after a backoff that the test injects instead of sleeping", async (t) => {
  const { env, planPath } = makeRunnerHome(t, "runner-retry", [
    { stdout: transientFailureStream(), exitCode: 1 },
    { stdout: doneStream(), exitCode: 0 },
  ]);
  const id = enqueue(env, { maxAttempts: 2 });
  const slept = [];

  const cycle = await runJobCycle(env, id, { sleepImpl: async (ms) => slept.push(ms) });

  assert.deepEqual(slept, [5000], "the runner did not back off exactly once between the two attempts");
  assert.equal(cycle.processed[0].status, "done");
  const row = getJob(id, env);
  assert.deepEqual({ status: row.status, attempts: row.attempts }, { status: "done", attempts: 2 });
  assert.equal(fakeCalls(planPath).length, 2);
  assert.equal(JSON.parse(row.result).attempts, 2);
});

test("a transient failure that exhausts the attempts of its own row stops there", async (t) => {
  const { env, planPath } = makeRunnerHome(t, "runner-retry-cap", [{ stdout: transientFailureStream(), exitCode: 1 }]);
  const id = enqueue(env, { maxAttempts: 1 });
  const slept = [];

  await runJobCycle(env, id, { sleepImpl: async (ms) => slept.push(ms) });

  assert.deepEqual(slept, []);
  assert.equal(getJob(id, env).status, "failed");
  assert.equal(fakeCalls(planPath).length, 1);
});

test("every preflight block returns the job to the queue without spending an attempt", async (t) => {
  const cases = [
    ["dirty-checkout", { gitImpl: fakeGit({ status: " M src/queue/runner.mjs" }) }],
    ["wrong-branch", { gitImpl: fakeGit({ branch: "feat/queue-runner" }) }],
    ["missing-checkout", { existsImpl: () => false }],
    ["claude-missing", { resolveBinImpl: () => ({ bin: null, via: "missing" }) }],
  ];
  for (const [code, deps] of cases) {
    const { env, planPath } = makeRunnerHome(t, `runner-block-${code}`, [{ stdout: doneStream(), exitCode: 0 }]);
    const id = enqueue(env);

    const cycle = await runJobCycle(env, id, deps);

    assert.deepEqual(cycle.processed, [{ id, status: "blocked", code }]);
    const row = getJob(id, env);
    assert.deepEqual({ status: row.status, attempts: row.attempts, worker: row.worker, note: row.operator_note }, { status: "pending", attempts: 0, worker: null, note: null });
    assert.equal(JSON.parse(row.result).blocked.code, code);
    assert.equal(fakeCalls(planPath).length, 0, `${code} still spawned the CLI`);
  }
});

test("a job blocked by the preflight is never claimed twice in the same cycle", async (t) => {
  const { env } = makeRunnerHome(t, "runner-block-loop", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);

  const cycle = await runCycle({ env, deps: { gitImpl: fakeGit({ status: " M file.mjs" }) } });

  assert.deepEqual(cycle.processed.map((job) => job.status), ["blocked"]);
  assert.equal(cycle.reason, "blocked", "a cycle that gave a job back to the operator must say so, so a drain waits instead of exiting");
  assert.equal(getJob(id, env).status, "pending");
});

test("an unknown project blocks the job with the code that names it", async (t) => {
  const { env } = makeRunnerHome(t, "runner-block-project", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  const config = loadConfig(env, { warn: () => {} });
  saveConfig({ ...config, projects: {} }, env);

  const cycle = await runJobCycle(env, id);

  assert.deepEqual(cycle.processed, [{ id, status: "blocked", code: "unknown-project" }]);
  assert.equal(getJob(id, env).status, "pending");
});

test("the slug and the session id are stored while the run is still going, not at the end", async (t) => {
  const { env } = makeRunnerHome(t, "runner-facts", [
    { stdout: toNdjson([systemInitEvent(), slugEvent()]), holdMs: 2500, tail: toNdjson([resultEvent({ text: `Pull request: ${PR_URL}` })]), exitCode: 0 },
  ]);
  const id = enqueue(env);

  const cycle = runJobCycle(env, id);
  const running = await waitFor(() => {
    const row = getJob(id, env);
    return row.slug && row.session_id ? row : null;
  }, "the slug and the session of a running job");
  assert.equal(running.status, "running", "the facts only appeared after the job finished");
  assert.deepEqual({ slug: running.slug, session: running.session_id }, { slug: SLUG, session: SESSION_ID });

  await cycle;
  assert.equal(getJob(id, env).status, "done");
});

test("the branch of the run comes from the state file the pipeline wrote", async (t) => {
  const { env } = makeRunnerHome(t, "runner-branch", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  mkdirSync(runDir("alpha", SLUG, env), { recursive: true });
  writeFileSync(join(runDir("alpha", SLUG, env), "state.json"), JSON.stringify({ schemaVersion: 1, slug: SLUG, branch: "fix/the-worker", phases: [] }));

  await runJobCycle(env, id);

  assert.equal(getJob(id, env).branch, "fix/the-worker");
});

test("a job that stops belonging to this runner is killed and closed as cancelled", async (t) => {
  const { env } = makeRunnerHome(t, "runner-cancel", [{ stdout: toNdjson([systemInitEvent()]), holdMs: 5000, exitCode: 0 }]);
  const id = enqueue(env);
  let polls = 0;

  const cycle = await runJobCycle(env, id, {
    stopPollMs: 300,
    stopSignalImpl: () => {
      polls += 1;
      return polls > 1;
    },
  });

  assert.equal(cycle.processed[0].status, "cancelled");
  const row = getJob(id, env);
  assert.equal(row.status, "cancelled");
  assert.ok(row.finished_at, "the cancelled job has no finished_at");
});

test("a runner that LOSES the job kills its child and writes nothing terminal about a row that is not its own", async (t) => {
  const { env, planPath } = makeRunnerHome(t, "runner-lost", [{ stdout: toNdjson([systemInitEvent()]), holdMs: 5000, exitCode: 0 }]);
  const id = enqueue(env);

  const cycle = runJobCycle(env, id, { stopPollMs: 200 });
  await waitFor(() => fakeCalls(planPath).length > 0, "the child of the first runner to start");
  openDb(env).prepare("UPDATE jobs SET worker = ? WHERE id = ?").run("host:9999", id);
  const done = await cycle;

  assert.deepEqual(done.processed, [{ id, status: "lost", attempts: 1 }]);
  const row = getJob(id, env);
  assert.deepEqual(
    { status: row.status, worker: row.worker, finished: row.finished_at, result: row.result },
    { status: "running", worker: "host:9999", finished: null, result: null },
    "the runner wrote a terminal state over a job that belongs to another worker",
  );
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /=== ownership lost @ /);
});

test("a shutdown signal stops the claiming and gives the running job back to the queue", async (t) => {
  const { env } = makeRunnerHome(t, "runner-shutdown", [{ stdout: toNdjson([systemInitEvent()]), holdMs: 5000, exitCode: 0 }]);
  const id = enqueue(env);

  const cycle = runJobCycle(env, id, { stopPollMs: 200 });
  await waitFor(() => getJob(id, env).status === "running", "the job to start running");
  process.emit("SIGINT");
  const done = await cycle;

  assert.equal(done.stopped, true);
  assert.deepEqual(done.processed, [{ id, status: "interrupted", attempts: 1 }]);
  const row = getJob(id, env);
  assert.deepEqual({ status: row.status, attempts: row.attempts, worker: row.worker }, { status: "pending", attempts: 0, worker: null });
  assert.deepEqual(JSON.parse(row.result), { interrupted: true });
});

test("one cycle runs two jobs of DIFFERENT projects at the same time while the ceiling allows it", async (t) => {
  const { env } = makeRunnerHome(t, "runner-parallel", [{ stdout: doneStream(), holdMs: 600, exitCode: 0 }], {
    projects: ["alpha", "beta"],
  });
  enqueue(env, { prompt: "fix the worker" });
  enqueue(env, { project: "beta", prompt: "fix the parser" });
  const active = [];

  const cycle = await runCycle({ env, deps: { gitImpl: countingGit(env, active) } });

  assert.deepEqual(cycle.processed.map((job) => job.status), ["done", "done"]);
  assert.deepEqual(active, [1, 2], "the second job waited for the first one instead of running beside it");
  assert.equal(countsByStatus(env).done, 2);
});

test("one cycle sweeps the merged pull requests exactly once, and `--dry` never sweeps at all", async (t) => {
  const { env } = makeRunnerHome(t, "runner-merge-sweep", [{ stdout: doneStream(), exitCode: 0 }], {
    projects: ["alpha", "beta"],
  });
  enqueue(env, { prompt: "fix the worker" });
  enqueue(env, { project: "beta", prompt: "fix the parser" });
  const sweeps = [];

  const cycle = await runCycle({ env, deps: { gitImpl: fakeGit(), refreshMergedImpl: (args) => sweeps.push(args) } });
  assert.deepEqual(cycle.processed.map((job) => job.status), ["done", "done"]);
  assert.equal(sweeps.length, 1, "the sweep ran once per claimed job instead of once per cycle");
  assert.equal(sweeps[0].env, env);

  const dry = await runCycle({ env, dry: true, deps: { refreshMergedImpl: () => sweeps.push("dry") } });
  assert.equal(dry.dry, true);
  assert.equal(sweeps.length, 1, "`queue run --dry` wrote through the sweep");
});

test("with a ceiling of one the same cycle runs the two jobs strictly one after the other", async (t) => {
  const { env } = makeRunnerHome(t, "runner-cap", [{ stdout: doneStream(), holdMs: 400, exitCode: 0 }], {
    projects: ["alpha", "beta"],
  });
  const config = loadConfig(env, { warn: () => {} });
  saveConfig({ ...config, queue: { maxConcurrent: 1, resumeSession: false } }, env);
  enqueue(env, { prompt: "fix the worker" });
  enqueue(env, { project: "beta", prompt: "fix the parser" });
  const activeRunning = [];

  const cycle = await runCycle({ env, deps: { gitImpl: countingGit(env, activeRunning) } });

  assert.equal(cycle.cap, 1);
  assert.deepEqual(activeRunning, [1, 1], "the runner crossed its own ceiling");
  assert.equal(countsByStatus(env).done, 2);
});

test("--resume is only added when the operator turned it on and the job already has a session", async (t) => {
  const { env, planPath } = makeRunnerHome(t, "runner-resume", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET session_id = ? WHERE id = ?").run(SESSION_ID, id);

  await runJobCycle(env, id);
  assert.equal(fakeCalls(planPath)[0].argv.includes("--resume"), false, "the resume was on with the switch off");

  const config = loadConfig(env, { warn: () => {} });
  saveConfig({ ...config, queue: { maxConcurrent: 2, resumeSession: true } }, env);
  const second = enqueue(env);
  openDb(env).prepare("UPDATE jobs SET session_id = ? WHERE id = ?").run(SESSION_ID, second);

  await runJobCycle(env, second);
  assert.equal(argValue(fakeCalls(planPath)[1].argv, "--resume"), SESSION_ID);
});

test("a cycle that has nothing to claim reports why, and a dry cycle never writes", async (t) => {
  const { env, planPath } = makeRunnerHome(t, "runner-dry", [{ stdout: doneStream(), exitCode: 0 }]);
  assert.equal((await runCycle({ env })).reason, "empty-queue");

  const id = enqueue(env);
  const report = await runCycle({ dry: true, env });
  assert.deepEqual({ dry: report.dry, paused: report.paused, cap: report.cap, active: report.active, next: report.next }, { dry: true, paused: false, cap: 2, active: 0, next: id });
  assert.equal(getJob(id, env).status, "pending", "the dry cycle claimed a job");
  assert.equal(fakeCalls(planPath).length, 0);

  claimJobById(id, { worker: "host:1", cap: 2 }, env);
  assert.equal((await runJobCycle(env, id)).reason, "not-pending");
});

test("the slug persisted is the pipeline's LAST declaration, not whichever QUEUE_SLUG line matched first", async (t) => {
  const spurious = "spurious-mention-of-slug";
  const real = "the-real-declared-slug";
  const stdout = toNdjson([
    systemInitEvent(),
    slugEvent(spurious),
    slugEvent(real),
    resultEvent({ text: `Done. Pull request: ${PR_URL}` }),
  ]);
  const { env } = makeRunnerHome(t, "runner-slug-last", [{ stdout, exitCode: 0 }]);
  const id = enqueue(env);

  await runJobCycle(env, id);

  assert.equal(getJob(id, env).slug, real, "an earlier, spurious QUEUE_SLUG line won over the real declaration");
});

test("a slug that is not a safe path segment is never persisted, because it becomes a run directory", async (t) => {
  const stdout = toNdjson([
    systemInitEvent(),
    { type: "assistant", session_id: SESSION_ID, message: { id: "msg_bad", role: "assistant", content: [{ type: "text", text: "QUEUE_SLUG: ../../etc\nQUEUE_SLUG: .." }] } },
    resultEvent({ text: `Done. Pull request: ${PR_URL}` }),
  ]);
  const { env } = makeRunnerHome(t, "runner-slug-unsafe", [{ stdout, exitCode: 0 }]);
  const id = enqueue(env);

  await runJobCycle(env, id);

  assert.equal(getJob(id, env).slug, null, "an unsafe slug reached the run directory of the job");
});

test("the watch loop repeats the cycle and hands each pass to the caller", async (t) => {
  const { env } = makeRunnerHome(t, "runner-watch", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  const seen = [];
  const slept = [];

  const passes = await runWatch({ intervalS: 7, env, cycles: 2, onCycle: (pass) => seen.push(pass.reason), deps: { gitImpl: fakeGit(), sleepImpl: async (ms) => slept.push(ms) } });

  assert.equal(passes.length, 2);
  assert.deepEqual(seen, ["empty-queue", "empty-queue"]);
  assert.equal(getJob(id, env).status, "done");
  assert.deepEqual(slept, [7000]);
  assert.equal(WATCH_INTERVAL_DEFAULT_S, 30);
});

test("the drain runs the job it can claim and stops by itself once the queue is empty, without sleeping", async (t) => {
  const { env } = makeRunnerHome(t, "runner-drain", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  const seen = [];
  const slept = [];

  const passes = await runDrain({ env, onCycle: (pass) => seen.push(pass.reason), deps: { gitImpl: fakeGit(), sleepImpl: async (ms) => slept.push(ms) } });

  assert.equal(getJob(id, env).status, "done");
  assert.equal(seen.at(-1), "empty-queue", seen.join(","));
  assert.ok(passes.length >= 1);
  assert.deepEqual(slept, [], "a drain that found the queue empty still went to sleep");
  assert.equal(DRAIN_INTERVAL_S, 15);
});

test("a drain held back by the concurrency cap waits and tries again instead of exiting", async (t) => {
  const { env } = makeRunnerHome(t, "runner-drain-cap", []);
  saveConfig({ ...loadConfig(env, { warn: () => {} }), queue: { maxConcurrent: 1 } }, env);
  const first = enqueue(env);
  claimJobById(first, { worker: "other-host:1", cap: 4 }, env);
  enqueue(env);
  const seen = [];
  const slept = [];

  const passes = await runDrain({ env, cycles: 2, onCycle: (pass) => seen.push(pass.reason), deps: { gitImpl: fakeGit(), sleepImpl: async (ms) => slept.push(ms) } });

  assert.equal(passes.length, 2);
  assert.deepEqual(seen, ["cap-reached", "cap-reached"], "a drain that hit the ceiling broke out of its loop instead of waiting");
  assert.deepEqual(slept, [DRAIN_INTERVAL_S * 1000]);
});

test("a finish the database refused to commit still leaves the witness, is reported, and the reconciliation restores the row from it", async (t) => {
  const { env } = makeRunnerHome(t, "runner-finish-refused", [{ stdout: doneStream(), exitCode: 0 }]);
  const id = enqueue(env);
  const refused = () => {
    throw new Error("the nightshift database is still locked by another process after 24 attempts");
  };

  const cycle = await runJobCycle(env, id, { finishJobImpl: refused });

  assert.deepEqual(cycle.processed, [{ id, status: "unrecorded", prUrl: PR_URL, attempts: 1, error: "the nightshift database is still locked by another process after 24 attempts" }]);
  assert.equal(getJob(id, env).status, "running", "the row kept the state the refused commit left it in");
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /finish verification failed\nthe finish of job #\d+ did not commit: the nightshift database is still locked/);
  const state = JSON.parse(readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8"));
  assert.deepEqual({ status: state.terminal.status, prUrl: state.terminal.prUrl }, { status: "done", prUrl: PR_URL }, "the witness was not written from the outcome in memory");

  openDb(env).prepare("UPDATE jobs SET lease_until = datetime('now', '-1 hour') WHERE id = ?").run(id);
  await reconcileFromWitness(env);
  const row = getJob(id, env);
  assert.deepEqual({ status: row.status, pr: row.pr_url, worker: row.worker, lease: row.lease_until }, { status: "done", pr: PR_URL, worker: null, lease: null }, "the reconciliation did not restore the row from the witness");
  assert.match(String(row.result), /repairedFrom/);
});

test("a drain waits on a job the preflight gave back instead of exiting, so the operator's fix is picked up", async (t) => {
  const { env } = makeRunnerHome(t, "runner-drain-blocked", []);
  const id = enqueue(env);
  const seen = [];
  const slept = [];

  const passes = await runDrain({ env, cycles: 2, onCycle: (pass) => seen.push(pass.reason), deps: { gitImpl: fakeGit({ status: " M src/a.mjs" }), sleepImpl: async (ms) => slept.push(ms) } });

  assert.equal(passes.length, 2, "the drain exited on a blocked job instead of waiting");
  assert.deepEqual(seen, ["blocked", "blocked"]);
  assert.deepEqual(slept, [DRAIN_INTERVAL_S * 1000]);
  assert.equal(getJob(id, env).status, "pending");
  assert.match(String(getJob(id, env).result), /dirty-checkout/);
});
