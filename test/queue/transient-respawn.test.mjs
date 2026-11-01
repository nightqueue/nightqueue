import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { transientFailureEvent, TRANSIENT_RESPAWNS } from "../../src/queue/classify.mjs";
import { narrateLog } from "../../src/queue/narrate.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import {
  assistantEvent,
  attemptMarker,
  doneStream,
  failureStream,
  PR_URL,
  providerErrorResult,
  rateLimitEvent,
  recordedDone,
  recordedGate,
  recordedNoChange,
  recordedTermination,
  resultEvent,
  systemInitEvent,
  toNdjson,
  transientFailureStream,
} from "../../test-support/streams.mjs";

const RESPAWN_LINE = /^=== respawn (\d)\/2 of attempt 1 \((.+)\) @ \S+ ===$/;

// A `result` event of the error arm, whose failure the CLI writes in `errors[]`.
function errorArmStream(errors) {
  return toNdjson([{ ...resultEvent({ subtype: "error_during_execution" }), errors }]);
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// A home with one job of project `alpha`, the fake `claude` replaying the given spawns.
function respawnHome(t, name, spawns) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), spawns);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  return { env, id, planPath };
}

// Runs the home's one job through a real cycle, keeping every backoff it asks for.
async function runJob({ env, id }, deps = {}) {
  const slept = [];
  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async (ms) => slept.push(ms), ...deps } });
  return { cycle, slept };
}

// The re-spawn lines of the job log, in order.
function respawnLines({ env, id }) {
  return readFileSync(jobLogPath(id, env), "utf8").split("\n").filter((line) => RESPAWN_LINE.test(line));
}

// The spawn counts of the job's attempt rows.
function spawnsOf({ env, id }) {
  return getJob(id, env).attempt_rows.map((row) => row.spawns);
}

test("the structured provider fields of a result are a transient failure", () => {
  assert.equal(TRANSIENT_RESPAWNS, 2);
  for (const status of [429, 500, 502, 503, 529]) {
    assert.equal(transientFailureEvent(transientFailureStream({ status })), `result api_error_status ${status}`);
  }
  assert.equal(transientFailureEvent(errorArmStream(["API Error: 529 Overloaded"])), "result error 529");
  assert.equal(transientFailureEvent(errorArmStream([null, "other", "API Error: 503"])), "result error 503");
});

test("a provider status outside the list, or without is_error, is not a transient failure", () => {
  assert.equal(transientFailureEvent(transientFailureStream({ status: 404 })), null);
  assert.equal(transientFailureEvent(toNdjson([{ ...providerErrorResult({ status: 529 }), is_error: false }])), null);
  assert.equal(transientFailureEvent(toNdjson([{ ...providerErrorResult(), api_error_status: "529" }])), null, "a status that is not a number was read as one");
  assert.equal(transientFailureEvent(errorArmStream("API Error: 529")), null, "`errors` that is not a list was read");
  assert.equal(transientFailureEvent(errorArmStream(["the tool said API Error: 529"])), null, "an unanchored error line was read");
  assert.equal(transientFailureEvent(toNdjson([{ ...resultEvent({ subtype: "success" }), errors: ["API Error: 529"] }])), null, "`errors` of another subtype was read");
});

test("text of any kind never makes a failure transient", () => {
  const texts = ["TypeError: fetch failed", "read ECONNRESET", "API Error: 529 Overloaded", "rate_limit_error", "HTTP 503"];
  for (const text of texts) {
    const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: text }] } };
    const stream = toNdjson([systemInitEvent(), assistantEvent(text), toolResult, resultEvent({ text, subtype: "error_during_execution" })]);
    assert.equal(transientFailureEvent(stream), null, `\`${text}\` in a stream re-spawned the run`);
    assert.equal(transientFailureEvent(text), null, `\`${text}\` as a raw line re-spawned the run`);
  }
  assert.equal(transientFailureEvent(failureStream()), null);
  assert.equal(transientFailureEvent(""), null);
  assert.equal(transientFailureEvent(null), null);
});

test("only the last rate limit of the orchestrator counts, and only a rejected one", () => {
  const rejected = rateLimitEvent({ status: "rejected", resetsAt: 2_000_000_000 });
  const allowed = rateLimitEvent({ status: "allowed", resetsAt: 2_000_000_000 });
  assert.equal(transientFailureEvent(toNdjson([rejected])), "rate_limit_event rejected");
  assert.equal(transientFailureEvent(toNdjson([rejected, allowed])), null);
  assert.equal(transientFailureEvent(toNdjson([allowed])), null);
  assert.equal(transientFailureEvent(toNdjson([{ ...rejected, parent_tool_use_id: "toolu_1" }])), null, "a subagent's limit spoke for the session");
});

test("a subagent's result and an older attempt's result never speak for the session", () => {
  const subagent = { ...providerErrorResult(), parent_tool_use_id: "toolu_1" };
  assert.equal(transientFailureEvent(toNdjson([subagent])), null);
  const older = `${attemptMarker(1)}\n${transientFailureStream()}${attemptMarker(2)}\n${failureStream()}`;
  assert.equal(transientFailureEvent(older), null);
});

test("a provider failure on a first attempt re-spawns inside the claim with one log line, and spends no attempt", async (t) => {
  const home = respawnHome(t, "respawn-recovers", [
    { stdout: transientFailureStream({ status: 529 }), exitCode: 1 },
    { stdout: doneStream(), runState: recordedDone(), exitCode: 0 },
  ]);

  const { cycle, slept } = await runJob(home);

  assert.equal(cycle.processed[0].status, "done");
  assert.equal(cycle.processed[0].attempts, 1);
  assert.deepEqual(slept, [5000]);
  assert.equal(fakeCalls(home.planPath).length, 2);
  assert.equal(getJob(home.id, home.env).attempts, 1);
  assert.deepEqual(spawnsOf(home), [2]);
  const lines = respawnLines(home);
  assert.equal(lines.length, 1);
  assert.deepEqual(RESPAWN_LINE.exec(lines[0]).slice(1), ["1", "result api_error_status 529"]);
});

test("a persistent provider failure stops after two re-spawns and fails with its exit code", async (t) => {
  const failing = { stdout: transientFailureStream({ status: 529 }), exitCode: 1 };
  const home = respawnHome(t, "respawn-cap", [failing, failing, failing, { stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);

  const { slept } = await runJob(home);

  const row = getJob(home.id, home.env);
  assert.equal(fakeCalls(home.planPath).length, 3, "the limit of two re-spawns was not kept");
  assert.deepEqual(slept, [5000, 15000]);
  assert.deepEqual({ status: row.status, attempts: row.attempts, notice: row.notice_md }, { status: "failed", attempts: 1, notice: "the session exited with code 1" });
  assert.deepEqual(spawnsOf(home), [3]);
  assert.deepEqual(respawnLines(home).map((line) => RESPAWN_LINE.exec(line)[1]), ["1", "2"]);
});

test("a tool result that says `fetch failed` does not re-spawn a failed run", async (t) => {
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "TypeError: fetch failed\nAPI Error: 529" }] } };
  const stdout = toNdjson([systemInitEvent(), toolResult, resultEvent({ text: "the tests failed", subtype: "error_during_execution" })]);
  const home = respawnHome(t, "respawn-tool-text", [{ stdout, exitCode: 1 }, { stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);

  const { slept } = await runJob(home);

  assert.equal(fakeCalls(home.planPath).length, 1);
  assert.deepEqual(slept, []);
  assert.equal(getJob(home.id, home.env).status, "failed");
  assert.deepEqual(respawnLines(home), []);
});

test("a run its record settled is not re-spawned by a provider error on its last result", async (t) => {
  const home = respawnHome(t, "respawn-settled", [
    { stdout: transientFailureStream(), runState: recordedTermination({ reason: "stopped on purpose" }), exitCode: 0 },
    { stdout: doneStream(), runState: recordedDone(), exitCode: 0 },
  ]);

  await runJob(home);

  assert.equal(fakeCalls(home.planPath).length, 1);
  assert.equal(getJob(home.id, home.env).status, "cancelled");
});

const SETTLED_AT_EXIT_1 = [
  ["row 4, done with its pull request", recordedDone(), { pr_url: PR_URL, notice: "the session exited with code 1" }],
  ["row 5, gate with its question", recordedGate(), { pr_url: null, notice: `the session exited with code 1 after recording a gate: ${recordedGate().outcome.notice}` }],
  ["row 6, no_change with its conclusion", recordedNoChange(), { pr_url: null, notice: "the session exited with code 1" }],
  ["row 7, a termination with its reason", recordedTermination(), { pr_url: null, notice: `the session exited with code 1 after recording a termination: ${recordedTermination().termination.reason}` }],
];

for (const [name, runState, row] of SETTLED_AT_EXIT_1) {
  test(`${name}, is not re-spawned by a 529 at exit 1: one spawn, failed by its exit code, the record untouched`, async (t) => {
    const home = respawnHome(t, `respawn-settled-${name.slice(0, 5).replace(" ", "")}`, [
      { stdout: transientFailureStream({ status: 529 }), runState, exitCode: 1 },
      { stdout: doneStream(), runState: recordedDone(), exitCode: 0 },
    ]);

    const { slept } = await runJob(home);

    const job = getJob(home.id, home.env);
    assert.equal(fakeCalls(home.planPath).length, 1, "a second session started on a settled run");
    assert.deepEqual(slept, []);
    assert.deepEqual({ status: job.status, notice: job.notice_md, pr_url: job.pr_url }, { status: "failed", ...row });
    const state = readRunState({ projectId: job.project_id, slug: job.slug, env: home.env });
    if (runState.outcome) assert.equal(state.outcome.status, runState.outcome.status);
    else assert.equal(state.termination.reason, runState.termination.reason);
  });
}

for (const [name, runState] of [
  ["only a pull request", { outcome: { prUrl: PR_URL } }],
  ["a gate with no question", { outcome: { status: "gate" } }],
  ["a done with no pull request", { outcome: { status: "done" } }],
]) {
  test(`a state holding ${name} settles nothing: the 529 still re-spawns`, async (t) => {
    const home = respawnHome(t, `respawn-unsettled-${name.replaceAll(" ", "-")}`, [
      { stdout: transientFailureStream({ status: 529 }), runState, exitCode: 1 },
      { stdout: doneStream(), runState: recordedDone(), exitCode: 0 },
    ]);

    await runJob(home);

    assert.equal(fakeCalls(home.planPath).length, 2);
    assert.equal(getJob(home.id, home.env).status, "done");
  });
}

test("a settled record with a rejected limit last still parks, and the record survives the park", async (t) => {
  const limited = toNdjson([systemInitEvent(), rateLimitEvent({ status: "rejected", resetsAt: Math.floor(Date.now() / 1000) - 3600 })]);
  const home = respawnHome(t, "respawn-settled-parked", [{ stdout: limited, runState: recordedDone(), exitCode: 1 }, { stdout: toNdjson([systemInitEvent()]), exitCode: 0 }]);

  const first = await runJob(home);
  assert.equal(first.cycle.processed[0].status, "rate-limited", JSON.stringify(first.cycle.processed));

  const second = await runJob(home);

  assert.equal(second.cycle.processed[0].status, "done", JSON.stringify(second.cycle.processed));
  assert.equal(getJob(home.id, home.env).pr_url, PR_URL);
});

test("the shape of a real provider failure re-spawns: is_error with subtype success and api_error_status 529", () => {
  const captured = { ...resultEvent({ text: "API Error: 529", subtype: "success" }), is_error: true, api_error_status: 529 };
  assert.equal(transientFailureEvent(toNdjson([captured])), "result api_error_status 529");
});

test("a rejected limit with no known reset re-spawns, and the next spawn does not inherit it", async (t) => {
  const limited = toNdjson([systemInitEvent(), { type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, resultEvent({ text: "", subtype: "error_during_execution" })]);
  const home = respawnHome(t, "respawn-rejected", [{ stdout: limited, exitCode: 1 }, { stdout: failureStream(), exitCode: 1 }, { stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);

  await runJob(home);

  assert.equal(fakeCalls(home.planPath).length, 2, "the second spawn's plain failure was treated as transient");
  assert.deepEqual(respawnLines(home).map((line) => RESPAWN_LINE.exec(line)[2]), ["rate_limit_event rejected"]);
  assert.equal(getJob(home.id, home.env).status, "failed");
});

test("a re-spawn forgets the rejection of the spawn before it: the next non-zero exit is classified, not parked", async (t) => {
  const limited = toNdjson([systemInitEvent(), rateLimitEvent({ status: "rejected" })]);
  const home = respawnHome(t, "respawn-forgets-limit", [{ stdout: limited, exitCode: 0 }, { stdout: failureStream(), exitCode: 1 }]);

  const { cycle } = await runJob(home);

  assert.equal(cycle.processed[0].status, "failed", "the second spawn was parked on the first one's rejection");
  assert.equal(fakeCalls(home.planPath).length, 2);
  assert.equal(getJob(home.id, home.env).notice_md, "the session exited with code 1");
});

test("a job another runner took during the backoff is reported lost, with no spawn after it", async (t) => {
  const home = respawnHome(t, "respawn-lost", [{ stdout: transientFailureStream(), exitCode: 1 }, { stdout: doneStream(), runState: recordedDone(), exitCode: 0 }]);
  const takeOver = async () => {
    openDb(home.env).prepare("UPDATE jobs SET worker = 'another-runner' WHERE id = ?").run(home.id);
  };

  const { cycle } = await runJob(home, { sleepImpl: takeOver });

  assert.equal(cycle.processed[0].status, "lost");
  assert.equal(fakeCalls(home.planPath).length, 1);
});

test("the narration says the re-spawn", () => {
  const log = [
    attemptMarker(1),
    transientFailureStream().trimEnd(),
    "=== respawn 1/2 of attempt 1 (result api_error_status 529) @ 2026-09-07T19:51:00.000Z ===",
    attemptMarker(1, "2026-09-07T19:51:05.000Z"),
    doneStream().trimEnd(),
  ].join("\n");

  const narrated = narrateLog(log).map((event) => event.text ?? "");

  assert.ok(narrated.some((text) => text.includes("respawn 1/2 of attempt 1 (result api_error_status 529)")), `the re-spawn was not narrated: ${narrated.join(" | ")}`);
});
