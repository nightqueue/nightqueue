import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { loadConfig, saveConfig } from "../../src/config/store.mjs";
import { openDb, sqliteToIso } from "../../src/memory/db.mjs";
import { packageRoot } from "../../src/host/paths.mjs";
import { addJob, claimJobById, countsByStatus, getJob } from "../../src/memory/jobs.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { clearOwnPause, PAUSE_GRACE_S, readOwnPause } from "../../src/queue/rate-limit.mjs";
import { writeRunnerRecord } from "../../src/queue/registry.mjs";
import { agentRuns, DRAIN_INTERVAL_S, runCycle, runDrain, runWatch, WATCH_INTERVAL_DEFAULT_S } from "../../src/queue/runner.mjs";
import { provisionalSlug } from "../../src/queue/spawn.mjs";
import { reconcileFromWitness } from "../../src/queue/reconcile.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { argValue, fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { agentToolUseEvent, assistantEvent, codeChangePublishedEvent, doneStream, failureStream, gateStream, noticeText, PR_URL, rateLimitEvent, resultEvent, SESSION_ID, SLUG, slugEvent, slugTypeEvent, systemInitEvent, taskNotificationEvent, toNdjson, transientFailureStream } from "../../test-support/streams.mjs";

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

// A git double whose checkout is dirty at the first preflight only, as if the operator cleaned it while the drain waited.
function dirtyOnceGit() {
  const dirty = fakeGit({ status: " M src/a.mjs" });
  const clean = fakeGit();
  let first = true;
  return (call) => {
    if (call.args[0] !== "status") return clean(call);
    const git = first ? dirty : clean;
    first = false;
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

test("the runtime records in the state of the run the pull request the host published, which the agent never wrote", async (t) => {
  const published = toNdjson([
    systemInitEvent(),
    slugEvent(SLUG),
    codeChangePublishedEvent(),
    resultEvent({ text: "Telemetry recorded. I did not manage to print the link." }),
  ]);
  const { env } = makeRunnerHome(t, "runner-published-pr", [{ stdout: published, exitCode: 0 }]);
  const id = enqueue(env);

  const cycle = await runJobCycle(env, id);

  assert.deepEqual(cycle.processed, [{ id, status: "done", prUrl: PR_URL, attempts: 1 }]);
  assert.equal(getJob(id, env).pr_url, PR_URL);
  const state = JSON.parse(readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8"));
  assert.equal(state.outcome.prUrl, PR_URL, "the pull request of the host never reached the record of the run");
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.terminal.prUrl, PR_URL, "the witness lost the pull request the same write recorded");
});

test("the durations and the models of the telemetry come from the stream, and the agent's survive only where the runtime measured none", async (t) => {
  const at = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
  const stream = toNdjson([
    systemInitEvent(),
    assistantEvent("## Brief\nTier: simple\nTier raised: simple -> complex: a stack trace in the claim path", { timestamp: at(1) }),
    slugEvent(SLUG),
    agentToolUseEvent({ id: "toolu_t", subagentType: "nightshift:triager", model: "haiku", timestamp: at(2) }),
    taskNotificationEvent({ toolUseId: "toolu_t", durationMs: 61000 }),
    agentToolUseEvent({ id: "toolu_c", subagentType: "nightshift:coder", model: "opus", timestamp: at(63) }),
    taskNotificationEvent({ toolUseId: "toolu_c", durationMs: 420000 }),
    assistantEvent(noticeText(), { timestamp: at(65) }),
    resultEvent({ text: `Done. Pull request: ${PR_URL}` }),
  ]);
  const { env } = makeRunnerHome(t, "runner-telemetry", [{ stdout: stream, exitCode: 0 }]);
  const id = enqueue(env);
  const logged = logPipelineRun(
    {
      project: "alpha",
      slug: SLUG,
      tier: "simple",
      outcome: "pr_opened",
      durationS: 999,
      phases: [
        { phase: "triage", model: null, duration_s: null },
        { phase: "implementation", model: null, duration_s: null },
        { phase: "commit", model: null, duration_s: 12 },
      ],
    },
    env,
  );

  const cycle = await runJobCycle(env, id);
  assert.equal(cycle.processed[0].status, "done");

  const db = openDb(env);
  const measured = db.prepare("SELECT duration_s FROM pipeline_runs WHERE id = ?").get(logged.runId).duration_s;
  assert.notEqual(measured, 999, "the duration the agent sent survived a run the runtime measured itself");
  assert.ok(measured >= 60 && measured <= 80, `the measured duration of the attempt was ${measured}s`);
  assert.deepEqual(
    db.prepare("SELECT phase, model, duration_s FROM pipeline_phases WHERE run_id = ? ORDER BY seq").all(logged.runId).map((row) => [row.phase, row.model, row.duration_s]),
    [
      ["triage", "haiku", 61],
      ["implementation", "opus", 420],
      ["commit", null, 12],
    ],
  );

  const state = JSON.parse(readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8"));
  assert.deepEqual({ tier: state.tier, reason: state.tierRaiseReason }, { tier: "complex", reason: "a stack trace in the claim path" });
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

test("a child that ends on a rate limit parks the job for the reset, keeps its attempt and resumes its session on the next claim", async (t) => {
  const resetsAtS = Math.floor(Date.now() / 1000) + 3600;
  const limited = toNdjson([systemInitEvent({}), rateLimitEvent({ status: "rejected", resetsAt: resetsAtS })]);
  const { env, planPath } = makeRunnerHome(t, "runner-rate-limit", [
    { stdout: limited, exitCode: 1 },
    { stdout: doneStream(), exitCode: 0 },
  ]);
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "once" }, env);
  const id = enqueue(env, { maxAttempts: 2 });
  const notBefore = new Date(resetsAtS * 1000).toISOString();

  const parkCycle = await runJobCycle(env, id);

  assert.deepEqual(parkCycle.processed, [{ id, status: "rate-limited", attempts: 1, notBefore }], "the rate limit was taken by the generic transient retry");
  const parked = getJob(id, env);
  assert.deepEqual(
    { status: parked.status, attempts: parked.attempts, notBefore: sqliteToIso(parked.not_before) },
    { status: "pending", attempts: 0, notBefore: notBefore.replace(".000Z", "Z") },
    "the parked job did not go back to the queue due at the reset, with its attempt intact",
  );
  assert.equal(readOwnPause(env).pausedUntil, new Date((resetsAtS + PAUSE_GRACE_S) * 1000).toISOString(), "this runner did not arm its own pause");
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /=== rate limit until \S+ @ \S+ ===/, "the job log says nothing about the wait");

  assert.equal(loadConfig(env).queue?.resumeSession ?? false, false, "the home opted into resuming sessions, so the forced resume proves nothing");
  openDb(env).prepare("UPDATE jobs SET not_before = datetime('now', '-1 second') WHERE id = ?").run(id);
  await clearOwnPause(env, readOwnPause(env));

  const resumed = await runJobCycle(env, id);

  assert.equal(resumed.processed[0].status, "done");
  assert.equal(argValue(fakeCalls(planPath)[1].argv, "--resume"), SESSION_ID, "the claim of a parked job restarted the run instead of resuming it");
  assert.equal(getJob(id, env).not_before, null, "the schedule of the limit outlived the run it scheduled");
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
    assert.deepEqual(
      { status: row.status, attempts: row.attempts, worker: row.worker, note: row.operator_note, blockedCode: row.blocked_code },
      { status: "pending", attempts: 0, worker: null, note: null, blockedCode: code },
    );
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

test("a retried job resumes on its own slug and run directory, and the runtime counts the resume in the state", async (t) => {
  const { env, planPath } = makeRunnerHome(t, "runner-resume-handoff", [{ stdout: "", exitCode: 0 }]);
  const id = enqueue(env);
  mkdirSync(runDir("alpha", SLUG, env), { recursive: true });
  writeFileSync(
    join(runDir("alpha", SLUG, env), "state.json"),
    JSON.stringify({
      schemaVersion: 1,
      slug: SLUG,
      project: "alpha",
      branch: "fix/the-worker",
      worktree: "/tmp/worktrees/fix-the-worker",
      resumeCount: 0,
      phases: [{ phase: "triage", artifact: "01-triage.md", verdict: "ok" }],
    }),
  );
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);

  await runJobCycle(env, id);

  const prompt = argValue(fakeCalls(planPath)[0].argv, "-p");
  assert.ok(prompt.includes(`RESUME CANDIDATE (slug \`${SLUG}\`)`), prompt);
  assert.ok(prompt.includes(`RUN_DIR: ${runDir("alpha", SLUG, env)}`), prompt);
  assert.ok(prompt.includes("Branch: fix/the-worker"), prompt);
  assert.ok(prompt.includes("Resume from phase: explore"), prompt);
  assert.equal(getJob(id, env).slug, SLUG, "the retry lost the slug of the run it was resuming");
  assert.deepEqual(readdirSync(dirname(runDir("alpha", SLUG, env))), [SLUG], "the retry opened a second run directory");
  const state = JSON.parse(readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8"));
  assert.equal(state.resumeCount, 1, "the resume was not counted in the state of the run");
  assert.equal(state.phases.length, 1, "counting the resume rewrote the run instead of merging into it");
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

test("one cycle runs two jobs of DIFFERENT projects strictly one after the other, whatever the ceiling", async (t) => {
  for (const maxConcurrent of [null, 3]) {
    const name = `runner-one-job-${maxConcurrent ?? "default"}`;
    const { env } = makeRunnerHome(t, name, [{ stdout: doneStream(), holdMs: 600, exitCode: 0 }], {
      projects: ["alpha", "beta"],
    });
    if (maxConcurrent !== null) saveConfig({ ...loadConfig(env, { warn: () => {} }), queue: { maxConcurrent } }, env);
    enqueue(env, { prompt: "fix the worker" });
    enqueue(env, { project: "beta", prompt: "fix the parser" });
    const active = [];

    const cycle = await runCycle({ env, deps: { gitImpl: countingGit(env, active) } });

    assert.deepEqual(cycle.processed.map((job) => job.status), ["done", "done"]);
    assert.deepEqual(active, [1, 1], "the second job started before the first one finished");
    assert.equal(countsByStatus(env).done, 2);
  }
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
  assert.deepEqual(
    { dry: report.dry, paused: report.paused, cap: report.cap, max: report.max, active: report.active, next: report.next },
    { dry: true, paused: false, cap: null, max: null, active: 0, next: id },
  );
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

  assert.equal(getJob(id, env).slug, SLUG, "an unsafe slug reached the run directory of the job, over the provisional one the runtime assigned");
});

test("the run is opened before the spawn, and the ONE declaration of the pipeline renames it while a later one is ignored", async (t) => {
  const stdout = toNdjson([
    systemInitEvent(),
    slugTypeEvent("the-real-name", "bug/error"),
    slugTypeEvent("a-later-name"),
    resultEvent({ text: `Done. Pull request: ${PR_URL}` }),
  ]);
  const { env, planPath } = makeRunnerHome(t, "runner-slug-override", [{ stdout, exitCode: 0 }]);
  const id = enqueue(env);
  const provisional = runDir("alpha", SLUG, env);
  mkdirSync(provisional, { recursive: true });
  writeFileSync(join(provisional, "01-triage.md"), "the artifact of the provisional run\n");

  await runJobCycle(env, id);

  const prompt = argValue(fakeCalls(planPath)[0].argv, "-p");
  assert.equal(prompt.includes(`RUN_DIR: ${provisional}`), true, "the prompt did not hand over the run the runtime opened");
  assert.match(prompt, /\nProject: alpha\n/);

  assert.equal(getJob(id, env).slug, "the-real-name", "the row kept a slug the pipeline had renamed");
  assert.equal(existsSync(provisional), false, "the provisional run directory was left behind");
  const renamed = runDir("alpha", "the-real-name", env);
  assert.equal(readFileSync(join(renamed, "01-triage.md"), "utf8"), "the artifact of the provisional run\n");
  assert.equal(JSON.parse(readFileSync(join(renamed, "state.json"), "utf8")).type, "bug/error");
  assert.equal(existsSync(runDir("alpha", "a-later-name", env)), false, "a second `SLUG:` line renamed the run again");
});

test("a slug another run of the project already took is refused, and the job keeps the one the runtime gave it", async (t) => {
  const taken = "fix-the-worker-of-the-queue";
  assert.equal(
    provisionalSlug({ id: 1, prompt: "fix the worker of the queue right now" }),
    provisionalSlug({ id: 2, prompt: "fix the worker of the queue tomorrow instead" }),
    "two prompts sharing their first six words should produce the same provisional slug",
  );
  const stdout = toNdjson([systemInitEvent(), slugTypeEvent(taken, "bug/error"), resultEvent({ text: `Done. Pull request: ${PR_URL}` })]);
  const { env } = makeRunnerHome(t, "runner-slug-collision", [{ stdout, exitCode: 0 }]);
  const id = enqueue(env);
  const other = `{"schemaVersion":1,"slug":"${taken}","phases":[]}\n`;
  mkdirSync(runDir("alpha", taken, env), { recursive: true });
  writeFileSync(join(runDir("alpha", taken, env), "state.json"), other);

  await runJobCycle(env, id);

  assert.equal(getJob(id, env).slug, SLUG, "the job took over the run directory of another run");
  assert.equal(readFileSync(join(runDir("alpha", taken, env), "state.json"), "utf8"), other, "the run of the other job was written into");
  assert.equal(JSON.parse(readFileSync(join(runDir("alpha", SLUG, env), "state.json"), "utf8")).type, "bug/error");
  assert.match(readFileSync(jobLogPath(id, env), "utf8"), /the run keeps the slug `fix-the-worker`: it could not be renamed to `fix-the-worker-of-the-queue`/);
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

test("`--max` is a budget for the run: the drain stops after n jobs and leaves the rest pending", async (t) => {
  const attempts = [1, 2, 3].map(() => ({ stdout: doneStream(), exitCode: 0 }));
  const { env } = makeRunnerHome(t, "runner-max-drain", attempts);
  const ids = [1, 2, 3].map((n) => enqueue(env, { prompt: `fix the worker ${n}` }));
  const seen = [];
  const slept = [];

  await runDrain({ max: 2, env, onCycle: (pass) => seen.push(pass.reason), deps: { gitImpl: fakeGit(), sleepImpl: async (ms) => slept.push(ms) } });

  assert.deepEqual(ids.map((id) => getJob(id, env).status), ["done", "done", "pending"]);
  assert.equal(seen.at(-1), "max-reached", seen.join(","));
  assert.deepEqual(slept, [], "a drain that spent its budget still went to sleep");

  const home = makeRunnerHome(t, "runner-max-cycle", attempts);
  enqueue(home.env, { prompt: "fix the worker" });
  enqueue(home.env, { prompt: "fix the parser" });
  const cycle = await runCycle({ max: 1, env: home.env, deps: { gitImpl: fakeGit() } });
  assert.equal(cycle.processed.length, 1);
  assert.equal(cycle.reason, "max-reached");
});

test("a job the preflight releases spends no --max budget: the drain waits on it and still runs n jobs that reach the agent", async (t) => {
  const attempts = [1, 2, 3].map(() => ({ stdout: doneStream(), exitCode: 0 }));
  const { env } = makeRunnerHome(t, "runner-max-released", attempts);
  const [a, b, c] = ["a", "b", "c"].map((name) => enqueue(env, { prompt: `fix the worker ${name}` }));
  const seen = [];
  const slept = [];

  const passes = await runDrain({ max: 2, cycles: 3, env, onCycle: (pass) => seen.push(pass.reason), deps: { gitImpl: dirtyOnceGit(), sleepImpl: async (ms) => slept.push(ms) } });

  assert.deepEqual(seen, ["blocked", "max-reached"]);
  assert.deepEqual(passes[0].processed.map((result) => result.status), ["blocked"]);
  assert.deepEqual(passes[1].processed.map((result) => result.status), ["done", "done"]);
  assert.deepEqual(slept, [DRAIN_INTERVAL_S * 1000]);
  assert.deepEqual([a, b, c].map((id) => getJob(id, env).status), ["done", "done", "pending"]);
  assert.equal(getJob(a, env).attempts, 1, "a released job kept the attempt the preflight should have refunded");

  const dirty = makeRunnerHome(t, "runner-max-dirty", attempts);
  const id = enqueue(dirty.env);
  const dirtySeen = [];
  await runDrain({ max: 2, cycles: 2, env: dirty.env, onCycle: (pass) => dirtySeen.push(pass.reason), deps: { gitImpl: fakeGit({ status: " M src/a.mjs" }), sleepImpl: async () => {} } });
  assert.deepEqual(dirtySeen, ["blocked", "blocked"], "a dirty checkout spent the --max budget");
  assert.equal(getJob(id, dirty.env).status, "pending");
});

test("a watcher with --max exits once its budget is spent", async (t) => {
  const attempts = [1, 2].map(() => ({ stdout: doneStream(), exitCode: 0 }));
  const { env } = makeRunnerHome(t, "runner-max-watch", attempts);
  enqueue(env, { prompt: "fix the worker" });
  enqueue(env, { prompt: "fix the parser" });

  const passes = await runWatch({ max: 1, intervalS: 7, env, cycles: 5, deps: { gitImpl: fakeGit(), sleepImpl: async () => {} } });

  assert.equal(passes.at(-1).reason, "max-reached");
  assert.equal(countsByStatus(env).done, 1);
  assert.equal(countsByStatus(env).pending, 1);
  assert.ok(passes.length < 5, `the watcher kept going for ${passes.length} passes`);
});

test("only a job the preflight released stays out of the --max budget", () => {
  const results = ["done", "failed", "gate", "interrupted", "rate-limited", "lost", "error", "unrecorded", "blocked"].map((status, id) => ({ id, status }));

  assert.equal(agentRuns(results), 8);
});
