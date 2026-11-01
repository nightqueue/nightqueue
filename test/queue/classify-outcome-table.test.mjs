import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { GATE_WITHOUT_NOTICE, IGNORED_RECORD_PREFIX, NO_CHANGE_NEXT_STEP_LINE, NOTHING_TO_CLOSE_LINE, SILENT_STOP_NOTICE, classifyJobResult, noChangeNotice, recordedConclusion } from "../../src/queue/classify.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { readRunState, recordsOfClaim, writeRunTerminal } from "../../src/queue/resume.mjs";
import { runOwnNotice } from "../../src/queue/run-notice.mjs";
import { consumeRunConclusion, recordOutcome, recordPrUrl, recordRunFields, recordTermination } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import {
  codeChangePublishedEvent,
  GATE_MARKER,
  noticeText,
  PR_URL,
  recordedDone,
  recordedGate,
  recordedNoChange,
  recordedTermination,
  resultEvent,
  SLUG,
  slugEvent,
  systemInitEvent,
  toNdjson,
} from "../../test-support/streams.mjs";

const QUIET = toNdjson([systemInitEvent(), resultEvent({ text: "" })]);
const REASON = "The ticket no longer applies.";
const DONE = recordedDone({ notice: "the pull request is open" });

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// The outcome of a clean attempt whose run recorded the given state, whatever the ending overrides.
function classifyClean(state, ending = {}, log = QUIET) {
  return classifyJobResult({ log, exitCode: 0, state, ...ending });
}

// A home with one job of project `alpha`, the fake `claude` replaying the given attempts.
function tableHome(t, name, attempts) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, `${name}-plan`), attempts);
  const projectId = ensureProject(env, "alpha");
  return { env, projectId, id: addJob({ projectId, prompt: "fix the worker" }, env).id };
}

// Runs the home's one job through a real cycle, with a fake worktree and a clean preflight.
function runJob({ env, id }) {
  return runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });
}

test("row 1: a stop cancels with its fixed reason, over every record and every other fact", () => {
  const outcome = classifyClean(DONE, { stopped: true, exitCode: 1, timedOut: true });
  assert.deepEqual([outcome.status, outcome.noticeMd], ["cancelled", "stopped by the operator"]);
});

test("row 2: a time or idle limit fails with a notice saying which, over every record", () => {
  const timed = classifyClean(DONE, { timedOut: true });
  assert.deepEqual([timed.status, timed.noticeMd], ["failed", "the run hit its time limit"]);
  const idle = classifyClean(DONE, { idleTimedOut: true });
  assert.deepEqual([idle.status, idle.noticeMd], ["failed", "the run went idle past its limit"]);
});

test("row 3: an exit other than zero fails naming the code, and a missing code says so", () => {
  const failed = classifyClean(DONE, { exitCode: 3 });
  assert.deepEqual([failed.status, failed.noticeMd, failed.prUrl], ["failed", "the session exited with code 3", PR_URL]);
  const lost = classifyClean(null, { exitCode: null });
  assert.deepEqual([lost.status, lost.noticeMd], ["failed", "the session ended with no exit code"]);
});

test("row 4: a recorded done with a pull request is done with the record's notice", () => {
  const outcome = classifyClean(DONE);
  assert.deepEqual([outcome.status, outcome.prUrl, outcome.noticeMd], ["done", PR_URL, "the pull request is open"]);
});

test("row 4: a recorded done whose pull request comes from the host's publication is done too", () => {
  const log = toNdjson([systemInitEvent(), codeChangePublishedEvent(), resultEvent({ text: "" })]);
  const outcome = classifyClean({ outcome: { status: "done", notice: "open" } }, {}, log);
  assert.deepEqual([outcome.status, outcome.prUrl], ["done", PR_URL]);
});

test("row 4: a recorded done with no pull request anywhere is not done", () => {
  const outcome = classifyClean({ outcome: { status: "done" } });
  assert.deepEqual([outcome.status, outcome.prUrl, outcome.noticeMd], ["failed", null, SILENT_STOP_NOTICE]);
});

test("row 5: a recorded gate with a notice waits with that notice, whatever its length", () => {
  const outcome = classifyClean(recordedGate({ notice: "Approved?" }));
  assert.deepEqual([outcome.status, outcome.noticeMd], ["gate", "Approved?"]);
});

test("row 6: a recorded no_change is done with no pull request, whatever the phase and even with a stale URL", () => {
  const notice = `${recordedNoChange().outcome.notice}\n\n${NO_CHANGE_NEXT_STEP_LINE}`;
  for (const state of [recordedNoChange(), { ...recordedTermination({ phase: "qa" }), ...recordedNoChange() }, { outcome: { ...recordedNoChange().outcome, prUrl: PR_URL } }]) {
    const outcome = classifyClean(state);
    assert.deepEqual([outcome.status, outcome.prUrl, outcome.resolution, outcome.noticeMd], ["done", null, "no-change", notice], JSON.stringify(state));
  }
});

test("row 6: a no_change with no notice is not a conclusion", () => {
  const outcome = classifyClean({ outcome: { status: "no_change" } });
  assert.deepEqual([outcome.status, outcome.resolution, outcome.noticeMd], ["failed", undefined, SILENT_STOP_NOTICE]);
});

test("row 7: a termination cancels with its reason and the nothing-to-close line, or only the reason when a pull request exists", () => {
  const none = classifyClean(recordedTermination({ reason: REASON }));
  assert.deepEqual([none.status, none.noticeMd], ["cancelled", `${REASON}\n\n${NOTHING_TO_CLOSE_LINE}`]);
  const withPr = classifyClean({ ...recordedTermination({ reason: REASON }), outcome: { prUrl: PR_URL } });
  assert.deepEqual([withPr.status, withPr.prUrl, withPr.noticeMd], ["cancelled", PR_URL, REASON]);
});

test("row 7: a termination that says no reason does not stand in for an outcome", () => {
  for (const termination of [{ phase: "qa" }, { phase: "qa", reason: "   " }, { phase: "qa", reason: 7 }, "qa", []]) {
    assert.deepEqual([classifyClean({ termination }).status, classifyClean({ termination }).noticeMd], ["failed", SILENT_STOP_NOTICE], JSON.stringify(termination));
  }
});

test("row 8: nothing recorded fails naming the missing outcome, and a gate with no notice names the missing question", () => {
  const nothing = classifyClean(null);
  assert.deepEqual([nothing.status, nothing.noticeMd], ["failed", SILENT_STOP_NOTICE]);
  assert.ok(SILENT_STOP_NOTICE.includes("no outcome recorded"), SILENT_STOP_NOTICE);
  const gate = classifyClean({ outcome: { status: "gate" } });
  assert.deepEqual([gate.status, gate.noticeMd], ["failed", GATE_WITHOUT_NOTICE]);
});

test("row 8: a pull request published with no recorded status fails and the row keeps its URL", () => {
  const log = toNdjson([systemInitEvent(), codeChangePublishedEvent(), resultEvent({ text: "" })]);
  const outcome = classifyClean(null, {}, log);
  assert.deepEqual([outcome.status, outcome.prUrl, outcome.noticeMd], ["failed", PR_URL, SILENT_STOP_NOTICE]);
});

test("acceptance: a run that calls run_terminate and never runs `run report` ends cancelled with the reason as its notice", async (t) => {
  const home = tableHome(t, "table-terminate", [{ stdout: toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "Stopped." })]), runState: recordedTermination({ reason: REASON }), exitCode: 0 }]);

  const cycle = await runJob(home);

  assert.equal(cycle.processed[0].status, "cancelled", JSON.stringify(cycle.processed));
  assert.ok(getJob(home.id, home.env).notice_md.startsWith(`${REASON}\n\n${NOTHING_TO_CLOSE_LINE}`), getJob(home.id, home.env).notice_md);
});

test("acceptance: a run that prints the gate heading and never calls run_outcome ends failed, not gate", async (t) => {
  const printed = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: noticeText(`${GATE_MARKER}\n\nDecide.`) })]);
  const home = tableHome(t, "table-heading", [{ stdout: printed, exitCode: 0 }]);

  const cycle = await runJob(home);

  assert.equal(cycle.processed[0].status, "failed", JSON.stringify(cycle.processed));
  assert.ok(getJob(home.id, home.env).notice_md.startsWith(SILENT_STOP_NOTICE), getJob(home.id, home.env).notice_md);
});

test("a publish survives the next attempt: the pull request stays on the row, and the attempt is done only if it records done again", async (t) => {
  const silent = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
  const home = tableHome(t, "table-keep-publish", [{ stdout: silent, runState: DONE, exitCode: 1 }, { stdout: silent, exitCode: 0 }]);
  await runJob(home);
  await applyRetry({ id: home.id, env: home.env });

  const cycle = await runJob(home);

  assert.deepEqual([cycle.processed[0].status, cycle.processed[0].prUrl], ["failed", PR_URL], JSON.stringify(cycle.processed));
});

test("an answered gate is consumed: the resumed run that terminates ends cancelled, its URL kept, never the old question", async (t) => {
  const silent = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
  const gate = { outcome: { status: "gate", prUrl: PR_URL, notice: "Old question?" } };
  const home = tableHome(t, "table-answered-gate", [{ stdout: silent, runState: gate, exitCode: 0 }, { stdout: silent, runState: recordedTermination({ reason: REASON, by: "qa-guardian" }), exitCode: 0 }]);
  const first = await runJob(home);
  assert.equal(first.processed[0].status, "gate", JSON.stringify(first.processed));

  await applyRetry({ id: home.id, note: "go on", env: home.env });
  const state = readRunState({ projectId: home.projectId, slug: SLUG, env: home.env });
  assert.equal(state.outcome.status, undefined, "the answered gate stayed on the record");
  assert.equal(state.outcome.notice, undefined);
  assert.equal(state.outcome.prUrl, PR_URL, "the answer erased an earlier publish");

  const second = await runJob(home);
  assert.deepEqual([second.processed[0].status, second.processed[0].prUrl], ["cancelled", PR_URL], JSON.stringify(second.processed));
  const notice = getJob(home.id, home.env).notice_md;
  assert.ok(notice.startsWith(REASON), notice);
  assert.equal(notice.includes("Old question?"), false, notice);
  assert.ok(readFileSync(jobLogPath(home.id, home.env), "utf8").includes("=== attempt"), "the log of the job was not written");
});

test("a resumed run that ends with no new record fails with the no-outcome notice, never repeating an answered gate", async (t) => {
  const silent = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
  const home = tableHome(t, "table-gate-then-silence", [{ stdout: silent, runState: recordedGate({ notice: "Old question?" }), exitCode: 0 }, { stdout: silent, exitCode: 0 }]);
  await runJob(home);
  await applyRetry({ id: home.id, note: "go on", env: home.env });

  const cycle = await runJob(home);

  assert.equal(cycle.processed[0].status, "failed", JSON.stringify(cycle.processed));
  assert.equal(getJob(home.id, home.env).notice_md.includes("Old question?"), false);
});

test("a run directory another job stamped lends this run neither its record nor its termination", async (t) => {
  const silent = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
  const foreign = { outcome: { status: "gate", notice: "Somebody else's question" }, terminal: { status: "gate", jobId: 999999 } };
  const home = tableHome(t, "table-foreign", [{ stdout: silent, runState: foreign, exitCode: 0 }]);

  const cycle = await runJob(home);

  assert.equal(cycle.processed[0].status, "failed", JSON.stringify(cycle.processed));
  assert.equal(String(getJob(home.id, home.env).notice_md).includes("Somebody else's question"), false);
});

test("consumeRunConclusion takes every attempt's conclusion, a delivery too, and keeps the publication: a run with nothing to consume, one that never existed and an unsafe path answer absent", async (t) => {
  const env = makeHome(t, "table-consume");
  const projectId = ensureProject(env, "alpha");
  const run = { projectId, slug: SLUG, jobId: 1, env };
  recordRunFields({ projectId, slug: SLUG, fields: { branch: "b" }, env });
  assert.equal((await consumeRunConclusion(run)).status, "absent");

  for (const status of ["gate", "no_change", "done"]) {
    recordOutcome({ projectId, slug: SLUG, status, notice: "Old?", env });
    assert.equal((await consumeRunConclusion(run)).status, "written", status);
    const cleared = readRunState({ projectId, slug: SLUG, env });
    assert.deepEqual([cleared.outcome.status, cleared.outcome.notice, cleared.branch], [undefined, undefined, "b"], status);
  }

  recordPrUrl({ projectId, slug: SLUG, prUrl: PR_URL, prTitle: "fix: worker", env });
  assert.equal((await consumeRunConclusion(run)).status, "absent", "a record holding only a pull request has nothing to consume");
  recordOutcome({ projectId, slug: SLUG, status: "done", notice: "delivered", env });
  assert.equal((await consumeRunConclusion(run)).status, "written", "a delivery was kept");
  const delivery = readRunState({ projectId, slug: SLUG, env }).outcome;
  assert.deepEqual([delivery.status, delivery.notice, delivery.prUrl, delivery.prTitle], [undefined, undefined, PR_URL, "fix: worker"]);
  recordOutcome({ projectId, slug: SLUG, status: "done", env });
  assert.equal((await consumeRunConclusion(run)).status, "written", "a delivery with no notice and no witness was kept");
  assert.equal(readRunState({ projectId, slug: SLUG, env }).outcome.status, undefined);

  assert.equal((await consumeRunConclusion({ ...run, slug: "never-ran" })).status, "absent");
  assert.equal(existsSync(runDir(projectId, "never-ran", env)), false, "the consumption created a run directory");
  assert.equal((await consumeRunConclusion({ ...run, slug: "../../escape" })).status, "absent");
});

test("consumeRunConclusion takes a termination and a witness in the same write, and answers moved and foreign without writing", async (t) => {
  const env = makeHome(t, "table-consume-all");
  const projectId = ensureProject(env, "alpha");
  const run = { projectId, slug: SLUG, jobId: 1, env };
  recordTermination({ projectId, slug: SLUG, phase: "qa", reason: REASON, by: "qa-guardian", env });
  writeRunTerminal({ projectId, slug: SLUG, terminal: { status: "cancelled", jobId: 2 }, env });
  const stamped = readFileSync(join(runDir(projectId, SLUG, env), "state.json"), "utf8");

  const foreign = await consumeRunConclusion(run);
  assert.deepEqual([foreign.status, foreign.stampedBy], ["foreign", 2]);
  assert.equal((await consumeRunConclusion({ ...run, jobId: 2, stillCurrent: async () => false })).status, "moved");
  const unreadable = await consumeRunConclusion({ ...run, jobId: 2, stillCurrent: async () => { throw new Error("the store is down"); } });
  assert.deepEqual([unreadable.status, unreadable.reason], ["kept", "the store is down"]);
  assert.equal(readFileSync(join(runDir(projectId, SLUG, env), "state.json"), "utf8"), stamped);

  assert.equal((await consumeRunConclusion({ ...run, jobId: 2 })).status, "written");
  const state = readRunState({ projectId, slug: SLUG, env });
  assert.deepEqual([state.termination, state.terminal], [undefined, undefined]);
  assert.equal(existsSync(`${runDir(projectId, SLUG, env)}.lock`), false, "the lock was left behind");
});

test("a stop and a recorded no_change never quote: the conclusion of a failed attempt is a gate or a termination", () => {
  const gate = recordedGate({ notice: "Old question?" });
  assert.equal(classifyClean(gate, { stopped: true }).noticeMd, "stopped by the operator");
  assert.equal(classifyClean(recordedNoChange(), { exitCode: 2 }).noticeMd, "the session exited with code 2");
  assert.equal(classifyClean(DONE, { exitCode: 2 }).noticeMd, "the session exited with code 2");
});

for (const [name, ending, notice] of [
  ["a non-zero exit", { exitCode: 2 }, "the session exited with code 2"],
  ["no exit code", { exitCode: null }, "the session ended with no exit code"],
  ["a time limit", { timedOut: true }, "the run hit its time limit"],
  ["an idle limit", { idleTimedOut: true }, "the run went idle past its limit"],
]) {
  test(`${name} after recording quotes the question or the reason in its notice`, () => {
    assert.equal(classifyClean(recordedGate({ notice: "Which branch?" }), ending).noticeMd, `${notice} after recording a gate: Which branch?`);
    assert.equal(classifyClean(recordedTermination({ reason: REASON }), ending).noticeMd, `${notice} after recording a termination: ${REASON}`);
    assert.equal(classifyClean({ outcome: { status: "gate" } }, ending).noticeMd, notice, "a gate with no question has nothing to quote");
  });
}

test("the quote goes before the abandoned-command line, and a terminal kill quotes too", () => {
  const kill = { type: "system", subtype: "task_updated", task_id: "task_kill", patch: { status: "killed" } };
  const abandoned = toNdjson([systemInitEvent(), kill, resultEvent({ text: "" })]);
  const line = classifyClean(recordedGate({ notice: "Which branch?" }), { exitCode: 1 }, abandoned).noticeMd;
  assert.ok(line.startsWith("the session exited with code 1 after recording a gate: Which branch?\n\n⚠️ a command was abandoned"), line);

  const terminal = classifyClean(recordedTermination({ reason: REASON }), {}, abandoned);
  assert.equal(terminal.status, "failed");
  assert.ok(terminal.noticeMd.endsWith(`after recording a termination: ${REASON}`), terminal.noticeMd);
});

// A log and a state where another attempt's record sits in the given slot, as the current claim's view reads it.
function viewOverStale(slot) {
  return recordsOfClaim({ schemaVersion: 1, slug: SLUG, phases: [], ...slot }, 2);
}

const ATTEMPT_ONE = { claim: { attempt: 1, session: "s-1" } };

for (const [name, slot] of [
  ["done", { outcome: { status: "done", notice: "Old delivery.", prUrl: PR_URL, ...ATTEMPT_ONE } }],
  ["gate", { outcome: { status: "gate", notice: "Old question?", ...ATTEMPT_ONE } }],
  ["no_change", { outcome: { status: "no_change", notice: "Old conclusion.", ...ATTEMPT_ONE } }],
  ["termination", { termination: { phase: "qa", reason: "Old stop.", ...ATTEMPT_ONE } }],
]) {
  test(`a stale ${name} of another attempt decides nothing: a clean exit fails, and the notice names the attempt it ignored`, () => {
    const outcome = classifyClean(viewOverStale(slot));
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.noticeMd, `${SILENT_STOP_NOTICE}\n\nignored a record of attempt 1`);
  });
}

test("the ignored line ends every kind of ending, one per attempt in ascending order, and a stale record is never quoted", () => {
  const stale = { outcome: { status: "gate", notice: "Old?", ...ATTEMPT_ONE } };
  assert.equal(classifyClean(viewOverStale(stale), { stopped: true }).noticeMd, "stopped by the operator\n\nignored a record of attempt 1");
  assert.equal(classifyClean(viewOverStale(stale), { timedOut: true }).noticeMd, "the run hit its time limit\n\nignored a record of attempt 1");
  assert.equal(classifyClean(viewOverStale(stale), { exitCode: 3 }).noticeMd, "the session exited with code 3\n\nignored a record of attempt 1");

  const own = { outcome: { status: "gate", notice: "New?", claim: { attempt: 2, session: "s-2" } } };
  const ignored = [{ kind: "phase", claim: { attempt: 3 } }, { kind: "outcome", claim: { attempt: 1 } }, { kind: "check", claim: { attempt: 3 } }];
  const gated = classifyClean(recordsOfClaim({ ...own, ignoredRecords: ignored }, 2));
  assert.equal(gated.status, "gate");
  assert.equal(gated.noticeMd, "New?\n\nignored a record of attempt 1\n\nignored a record of attempt 3");

  const done = classifyClean(recordsOfClaim({ outcome: { status: "done", prUrl: PR_URL, claim: { attempt: 2 } }, ignoredRecords: [{ claim: { attempt: 1 } }] }, 2));
  assert.deepEqual([done.status, done.noticeMd], ["done", "ignored a record of attempt 1"]);
});

test("a stale outcome keeps its pull request on the row, and an unstamped record reads as current", () => {
  const outcome = classifyClean(viewOverStale({ outcome: { status: "done", notice: "Old.", prUrl: PR_URL, prTitle: "fix", ...ATTEMPT_ONE } }));
  assert.deepEqual([outcome.status, outcome.prUrl], ["failed", PR_URL]);
  const unstamped = classifyClean(recordsOfClaim(recordedGate({ notice: "Parked question?" }), 2));
  assert.deepEqual([unstamped.status, unstamped.noticeMd], ["gate", "Parked question?"]);
});

test("the ignored line is a runtime line: what the origins are told never carries it", () => {
  const notice = `${noChangeNotice("The ticket no longer applies.")}\n\n${IGNORED_RECORD_PREFIX}1`;
  assert.equal(runOwnNotice(notice), "The ticket no longer applies.");
});

test("recordedConclusion names a gate before a termination, and nothing else speaks", () => {
  assert.equal(recordedConclusion({ ...recordedGate({ notice: "Which?" }), ...recordedTermination({ reason: REASON }) }), "a gate: Which?");
  assert.equal(recordedConclusion(recordedTermination({ reason: REASON })), `a termination: ${REASON}`);
  for (const state of [null, recordedDone(), recordedNoChange(), { outcome: { status: "gate" } }, { termination: { phase: "qa" } }]) {
    assert.equal(recordedConclusion(state), null, JSON.stringify(state));
  }
});
