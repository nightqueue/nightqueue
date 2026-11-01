import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, RECOVERED_PROMPT, retryJob, retryRefusalOf } from "../../src/memory/jobs.mjs";
import { SILENT_STOP_NOTICE } from "../../src/queue/classify.mjs";
import { decideResume, readRunState, writeRunTerminal } from "../../src/queue/resume.mjs";
import { applyRetry } from "../../src/queue/retry.mjs";
import { recordOutcome, recordPhaseDone, recordPrUrl, recordRunFields, recordTermination, recordWip } from "../../src/queue/run-state.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import {
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
  transientFailureStream,
} from "../../test-support/streams.mjs";

const SILENT = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: "" })]);
const OLD_NOTICE = "Old question?";
const CLOSED_WITHOUT_CHANGE = JSON.stringify({ data: { resolvedWithoutChange: true } });

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// A home with one job of project `alpha`, the fake `claude` replaying the given spawns.
function retryHome(t, name, spawns = []) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const planPath = useFakeClaude(env, makeDir(t, `${name}-plan`), spawns);
  const projectId = ensureProject(env, "alpha");
  return { env, planPath, projectId, id: addJob({ projectId, prompt: "fix the worker" }, env).id };
}

// Runs the home's one job through a real cycle, with a fake worktree, a clean preflight and no real backoff.
function runJob({ env, id }) {
  return runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });
}

// Puts a job straight into the given status, bound to the run's slug.
function seedRow({ env, id }, { status, blockedCode = null }) {
  const worker = status === "running" ? "host:1" : null;
  openDb(env).prepare("UPDATE jobs SET status = ?, blocked_code = ?, worker = ?, slug = ?, notice_md = ? WHERE id = ?").run(status, blockedCode, worker, SLUG, OLD_NOTICE, id);
}

// The bytes of the run's state.json.
function stateBytes({ env, projectId }) {
  return readFileSync(join(runDir(projectId, SLUG, env), "state.json"), "utf8");
}

// Runs one attempt that ends with the given record and exit code, sends the job back and runs a clean attempt that records nothing.
async function retriedThenSilent(t, name, { runState, exitCode = 1 }) {
  const home = retryHome(t, name, [{ stdout: SILENT, runState, exitCode }, { stdout: SILENT, exitCode: 0 }]);
  await runJob(home);
  await applyRetry({ id: home.id, note: "try again", env: home.env });
  const cycle = await runJob(home);
  assert.equal(fakeCalls(home.planPath).length, 2, "the retried attempt did not spawn");
  return { home, row: getJob(home.id, home.env), processed: cycle.processed[0] };
}

for (const [name, runState] of [
  ["no-change", recordedNoChange({ notice: "Nothing to do." })],
  ["gate", recordedGate({ notice: OLD_NOTICE })],
  ["done-without-url", { outcome: { status: "done", notice: "Done, no URL." } }],
]) {
  test(`a retried attempt that records nothing does not inherit a ${name} record: failed, with the no-outcome notice`, async (t) => {
    const { row } = await retriedThenSilent(t, `consume-${name}`, { runState });
    assert.equal(row.status, "failed");
    assert.equal(row.notice_md, SILENT_STOP_NOTICE);
  });
}

test("a delivery is consumed like any other record: a retried attempt that records nothing fails, with the pull request on the row", async (t) => {
  const { home, row } = await retriedThenSilent(t, "consume-delivery", { runState: recordedDone() });
  assert.deepEqual([row.status, row.pr_url, row.notice_md], ["failed", PR_URL, SILENT_STOP_NOTICE]);
  const outcome = readRunState({ projectId: home.projectId, slug: SLUG, env: home.env }).outcome;
  assert.deepEqual([outcome.status, outcome.notice, outcome.prUrl], [undefined, undefined, PR_URL]);
});

test("a delivery as `run publish` records it, with no notice, is consumed too", async (t) => {
  const { row } = await retriedThenSilent(t, "consume-delivery-no-notice", { runState: { outcome: { status: "done", prUrl: PR_URL } } });
  assert.deepEqual([row.status, row.pr_url, row.notice_md], ["failed", PR_URL, SILENT_STOP_NOTICE]);
});

test("a retried attempt that records done again is done with the pull request", async (t) => {
  const home = retryHome(t, "consume-delivery-again", [{ stdout: SILENT, runState: recordedDone(), exitCode: 1 }, { stdout: SILENT, runState: recordedDone(), exitCode: 0 }]);
  await runJob(home);
  await applyRetry({ id: home.id, note: "try again", env: home.env });

  await runJob(home);

  assert.deepEqual([getJob(home.id, home.env).status, getJob(home.id, home.env).pr_url], ["done", PR_URL]);
});

test("a retried attempt that fails silently keeps the record of a publish and can be retried again", async (t) => {
  const { home, row } = await retriedThenSilent(t, "consume-delivery-retry-again", { runState: recordedDone() });
  assert.equal(row.status, "failed");

  const { job } = await applyRetry({ id: home.id, note: "once more", env: home.env });

  assert.equal(job.status, "pending");
  assert.equal(readRunState({ projectId: home.projectId, slug: SLUG, env: home.env }).outcome.prUrl, PR_URL);
});

test("a retried attempt over a delivery that records a gate or a no_change speaks for itself", async (t) => {
  const gate = retryHome(t, "consume-delivery-new-gate", [{ stdout: SILENT, runState: recordedDone(), exitCode: 1 }, { stdout: SILENT, runState: recordedGate({ notice: "New question?" }), exitCode: 0 }]);
  await runJob(gate);
  await applyRetry({ id: gate.id, note: "add the test", env: gate.env });
  await runJob(gate);
  assert.deepEqual([getJob(gate.id, gate.env).status, getJob(gate.id, gate.env).notice_md], ["gate", "New question?"]);

  const noChange = retryHome(t, "consume-delivery-new-no-change", [{ stdout: SILENT, runState: recordedDone(), exitCode: 1 }, { stdout: SILENT, runState: recordedNoChange({ notice: "Nothing more." }), exitCode: 0 }]);
  await runJob(noChange);
  await applyRetry({ id: noChange.id, note: "add the test", env: noChange.env });
  await runJob(noChange);
  assert.equal(getJob(noChange.id, noChange.env).status, "done");
  assert.equal(getJob(noChange.id, noChange.env).notice_md.startsWith("Nothing more."), true);
});

test("a gate recorded over a publish is consumed alone: the retried attempt fails with the pull request on the row", async (t) => {
  const { row } = await retriedThenSilent(t, "consume-gate-over-publish", { runState: { outcome: { status: "gate", notice: OLD_NOTICE, prUrl: PR_URL } }, exitCode: 0 });
  assert.deepEqual([row.status, row.pr_url, row.notice_md], ["failed", PR_URL, SILENT_STOP_NOTICE]);
});

test("a termination the run wrote is consumed by a retry: a clean exit with no record fails, never cancelled with the old reason", async (t) => {
  const { home, row } = await retriedThenSilent(t, "stale-termination", { runState: recordedTermination({ reason: "The ticket no longer applies." }), exitCode: 0 });
  assert.deepEqual([row.status, row.notice_md], ["failed", SILENT_STOP_NOTICE]);
  assert.equal(readRunState({ projectId: home.projectId, slug: SLUG, env: home.env }).termination, undefined);
});

test("a consumed termination no longer stops the resume, and what the run built stays: phases, wip and the pull request", async (t) => {
  const home = retryHome(t, "consume-termination-resume");
  seedRow(home, { status: "cancelled" });
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  recordPrUrl({ ...run, prUrl: PR_URL });
  recordPhaseDone({ ...run, phase: "triage", verdict: "PROCEED" });
  recordTermination({ ...run, phase: "qa", reason: "The ticket no longer applies.", by: "qa-guardian" });
  recordWip({ ...run, wip: { sha: "abc", at: "2026-10-31T00:00:00Z" } });
  assert.equal(decideResume({ state: readRunState(run) }).reason, "terminated-by-verdict", "the fixture must stop the resume before the retry");

  await applyRetry({ id: home.id, env: home.env });

  const state = readRunState(run);
  assert.notEqual(decideResume({ state }).reason, "terminated-by-verdict");
  assert.equal(state.termination, undefined);
  assert.equal(state.wip.sha, "abc", "the retry consumed the wip record");
  assert.equal(state.outcome.prUrl, PR_URL);
});

test("a retried attempt over an old termination is not settled by it: a provider failure re-spawns it", async (t) => {
  const home = retryHome(t, "stale-termination-529", [
    { stdout: SILENT, runState: recordedTermination(), exitCode: 0 },
    { stdout: transientFailureStream({ status: 529 }), exitCode: 1 },
    { stdout: SILENT, exitCode: 0 },
  ]);
  await runJob(home);
  await applyRetry({ id: home.id, note: "try again", env: home.env });

  await runJob(home);

  assert.equal(fakeCalls(home.planPath).length, 3);
  assert.deepEqual([getJob(home.id, home.env).status, getJob(home.id, home.env).notice_md], ["failed", SILENT_STOP_NOTICE]);
});

for (const { status, note } of [
  { status: "running" },
  { status: "pending" },
  { status: "gate" },
  { status: "gate", note: "   " },
  { status: "done" },
]) {
  test(`a retry the row refuses (${status}, note ${JSON.stringify(note)}) leaves state.json byte for byte`, async (t) => {
    const home = retryHome(t, `refused-${status}-${note ? "blank" : "none"}`);
    seedRow(home, { status });
    recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });
    recordRunFields({ projectId: home.projectId, slug: SLUG, fields: { terminal: { status, jobId: home.id } }, env: home.env });
    const before = stateBytes(home);

    await assert.rejects(applyRetry({ id: home.id, note, env: home.env, prStateImpl: async () => ({}) }), UserError);

    assert.equal(stateBytes(home), before);
  });
}

test("retryRefusalOf answers null exactly when retryJob succeeds, and otherwise the words retryJob throws", (t) => {
  const statuses = ["pending", "running", "gate", "done", "failed", "cancelled", "closed"];
  const shapes = statuses.flatMap((status) => [null, "STORE_UNAVAILABLE"].map((blockedCode) => ({ status, blockedCode })));
  const notes = [undefined, "", "   ", "an answer"];
  const env = makeHome(t, "refusal-table");
  const projectId = ensureProject(env, "alpha");
  for (const shape of shapes) {
    for (const note of notes) {
      const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
      const close = shape.status === "closed" ? CLOSED_WITHOUT_CHANGE : null;
      openDb(env).prepare("UPDATE jobs SET status = ?, blocked_code = ?, worker = ?, close = ? WHERE id = ?").run(shape.status, shape.blockedCode, shape.status === "running" ? "host:1" : null, close, id);
      const label = JSON.stringify({ ...shape, note });
      const refusal = retryRefusalOf(id, { note }, env);
      assert.equal(getJob(id, env).status, shape.status, `the check moved the row: ${label}`);
      if (refusal === null) {
        assert.equal(retryJob(id, { note }, env).status, "pending", label);
      } else {
        assert.throws(() => retryJob(id, { note }, env), { message: refusal }, label);
      }
    }
  }
});

test("retryRefusalOf says the recovered prompt first and an unknown job by its id, as retryJob does", (t) => {
  const env = makeHome(t, "refusal-recovered");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'failed', prompt = ? WHERE id = ?").run(RECOVERED_PROMPT, id);

  const refusal = retryRefusalOf(id, {}, env);

  assert.match(refusal, /rebuilt from disk/);
  assert.throws(() => retryJob(id, {}, env), { message: refusal });
  assert.throws(() => retryJob(999999, {}, env), { message: retryRefusalOf(999999, {}, env) });
});

test("the record is consumed before the commit: nothing a claimed run records after the commit is erased", async (t) => {
  const home = retryHome(t, "consume-before-commit");
  seedRow(home, { status: "gate" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });
  recordTermination({ projectId: home.projectId, slug: SLUG, phase: "qa", reason: "Stopped.", by: "qa-guardian", env: home.env });
  writeRunTerminal({ projectId: home.projectId, slug: SLUG, terminal: { status: "gate", jobId: home.id }, env: home.env });
  const real = openStore(home.env);
  let atCommit = null;
  let stateAtCommit = null;
  const storeImpl = () => ({
    ...real,
    jobs: {
      ...real.jobs,
      retryJob: async (id, options) => {
        stateAtCommit = readRunState({ projectId: home.projectId, slug: SLUG, env: home.env });
        atCommit = stateAtCommit.outcome;
        const job = await real.jobs.retryJob(id, options);
        recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: "New question?", env: home.env });
        return job;
      },
    },
  });

  const { job } = await applyRetry({ id: home.id, note: "use main", env: home.env, storeImpl });

  assert.equal(job.status, "pending");
  assert.deepEqual([atCommit.status, atCommit.notice], [undefined, undefined], "the old record was still there at the commit");
  assert.deepEqual([stateAtCommit.termination, stateAtCommit.terminal], [undefined, undefined], "the termination or the witness was still there at the commit");
  const after = readRunState({ projectId: home.projectId, slug: SLUG, env: home.env }).outcome;
  assert.deepEqual([after.status, after.notice], ["gate", "New question?"], "the retry erased what the new run recorded");
});

// The columns of the row a refused retry must leave as they were.
function rowFacts({ env, id }) {
  const { status, attempts, notice_md, finished_at } = getJob(id, env);
  return { status, attempts, notice_md, finished_at };
}

test("a record that cannot be written refuses the retry: retry again in a moment, the row and state.json as they were", async (t) => {
  const home = retryHome(t, "consume-kept");
  seedRow(home, { status: "failed" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });
  const dir = runDir(home.projectId, SLUG, home.env);
  const before = { row: rowFacts(home), state: stateBytes(home) };
  chmodSync(dir, 0o555);
  t.after(() => chmodSync(dir, 0o755));

  await assert.rejects(applyRetry({ id: home.id, env: home.env }), (err) => err instanceof UserError && /could not be consumed .*retry again in a moment; nothing was written/.test(err.message));

  assert.deepEqual({ row: rowFacts(home), state: stateBytes(home) }, before);
});

test("a run lock held past its timeout refuses the retry with nothing written, and once released the retry works", async (t) => {
  const home = retryHome(t, "consume-lock-held");
  seedRow(home, { status: "failed" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });
  const lock = `${runDir(home.projectId, SLUG, home.env)}.lock`;
  const before = { row: rowFacts(home), state: stateBytes(home) };
  mkdirSync(lock);
  t.after(() => rmSync(lock, { recursive: true, force: true }));

  await assert.rejects(applyRetry({ id: home.id, env: home.env }), /retry again in a moment/);
  assert.deepEqual({ row: rowFacts(home), state: stateBytes(home) }, before);

  rmSync(lock, { recursive: true, force: true });
  assert.equal((await applyRetry({ id: home.id, env: home.env })).job.status, "pending");
});

test("a row that moved after its check refuses the retry, even back at the same status, and the new gate stands", async (t) => {
  const home = retryHome(t, "consume-moved");
  seedRow(home, { status: "gate" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });
  const real = openStore(home.env);
  const storeImpl = () => ({
    ...real,
    jobs: {
      ...real.jobs,
      retryRefusalOf: async (id, options) => {
        const refusal = await real.jobs.retryRefusalOf(id, options);
        openDb(home.env).prepare("UPDATE jobs SET attempts = attempts + 1, notice_md = 'New question?' WHERE id = ?").run(id);
        recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: "New question?", env: home.env });
        return refusal;
      },
    },
  });

  await assert.rejects(applyRetry({ id: home.id, note: "use main", env: home.env, storeImpl }), (err) => err instanceof UserError && /changed while this retry was applied \(it is now `gate`\): nothing was written/.test(err.message));

  const outcome = readRunState({ projectId: home.projectId, slug: SLUG, env: home.env }).outcome;
  assert.deepEqual([outcome.status, outcome.notice], ["gate", "New question?"]);
  assert.equal(getJob(home.id, home.env).status, "gate");
});

test("a retry over a run another job stamped is refused naming that job and --fresh, with the file and the row untouched", async (t) => {
  const home = retryHome(t, "consume-foreign");
  seedRow(home, { status: "failed" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });
  recordTermination({ projectId: home.projectId, slug: SLUG, phase: "qa", reason: "Stopped.", by: "qa-guardian", env: home.env });
  writeRunTerminal({ projectId: home.projectId, slug: SLUG, terminal: { status: "gate", jobId: home.id + 1 }, env: home.env });
  const before = stateBytes(home);
  const row = getJob(home.id, home.env);

  await assert.rejects(applyRetry({ id: home.id, env: home.env }), (err) => {
    assert.ok(err instanceof UserError, String(err));
    assert.ok(err.message.includes(`stamped by J-${home.id + 1}`), err.message);
    assert.ok(err.message.includes(`nightqueue queue retry J-${home.id} --fresh`), err.message);
    assert.ok(err.message.includes("nothing was written"), err.message);
    return true;
  });

  assert.equal(stateBytes(home), before);
  assert.deepEqual(getJob(home.id, home.env), row);
});

test("a foreign witness with nothing else to consume and an older stamp still refuses, and --fresh, the way out, deletes the directory", async (t) => {
  const home = retryHome(t, "consume-foreign-old-stamp");
  seedRow(home, { status: "failed" });
  openDb(home.env).prepare("UPDATE jobs SET attempts = 5 WHERE id = ?").run(home.id);
  writeRunTerminal({ projectId: home.projectId, slug: SLUG, terminal: { status: "gate", jobId: home.id + 1, claim: { attempt: 1, session: null } }, env: home.env });

  await assert.rejects(applyRetry({ id: home.id, env: home.env }), /stamped by/);

  const { job, runDir: dropped } = await applyRetry({ id: home.id, fresh: true, env: home.env });
  assert.equal(job.status, "pending");
  assert.equal(dropped.status, "removed");
});

test("a retry consumes a stamp equal or higher than the row's attempt, a given-back stop included, and leaves an older one on disk", async (t) => {
  const home = retryHome(t, "consume-stamps");
  const run = { projectId: home.projectId, slug: SLUG, env: home.env };
  seedRow(home, { status: "failed" });
  openDb(home.env).prepare("UPDATE jobs SET attempts = 3 WHERE id = ?").run(home.id);

  recordOutcome({ ...run, status: "gate", notice: "Given back at 4?", claim: { attempt: 4, session: null } });
  await applyRetry({ id: home.id, env: home.env });
  const consumed = readRunState(run).outcome;
  assert.deepEqual([consumed.status, consumed.notice, consumed.claim], [undefined, undefined, undefined]);

  seedRow(home, { status: "failed" });
  recordOutcome({ ...run, status: "gate", notice: "Of attempt 1?", claim: { attempt: 1, session: null } });
  recordTermination({ ...run, phase: "qa", reason: "Stop of attempt 1.", claim: { attempt: 1, session: null } });
  const before = stateBytes(home);
  await applyRetry({ id: home.id, env: home.env });
  assert.equal(stateBytes(home), before, "only stale records were left, so nothing was to be written");
});

// A store whose commit throws the given error, and whose reads throw too from the commit on when `readsFail` is set.
function storeFailingCommit(env, error, { readsFail = false } = {}) {
  const real = openStore(env);
  let committed = false;
  return () => ({
    ...real,
    jobs: {
      ...real.jobs,
      getJob: async (id) => {
        if (committed && readsFail) throw new Error("the row cannot be read");
        return await real.jobs.getJob(id);
      },
      retryJob: async () => {
        committed = true;
        throw error;
      },
    },
  });
}

test("a commit that throws after a consumption says so, names the row's status and keeps its error class", async (t) => {
  class StoreDown extends Error {}
  const home = retryHome(t, "consume-commit-throws");
  seedRow(home, { status: "gate" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });

  await assert.rejects(applyRetry({ id: home.id, note: "go", env: home.env, storeImpl: storeFailingCommit(home.env, new StoreDown("the store is down")) }), (err) => {
    assert.ok(err instanceof StoreDown, "the error lost its class");
    assert.match(err.message, /^the store is down\nJ-\d+: the last attempt's record was already consumed and the job is `gate`, its notice still on the row; retry again$/);
    return true;
  });
  assert.equal(getJob(home.id, home.env).notice_md, OLD_NOTICE);
});

test("a commit that throws says when the row could not be read back, and says nothing when nothing was consumed", async (t) => {
  const home = retryHome(t, "consume-commit-unreadable");
  seedRow(home, { status: "gate" });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });
  const unreadable = storeFailingCommit(home.env, new Error("down"), { readsFail: true });
  await assert.rejects(applyRetry({ id: home.id, note: "go", env: home.env, storeImpl: unreadable }), /already consumed and the row could not be read; retry again/);

  const clean = retryHome(t, "consume-commit-nothing");
  seedRow(clean, { status: "failed" });
  await assert.rejects(applyRetry({ id: clean.id, env: clean.env, storeImpl: storeFailingCommit(clean.env, new Error("only this")) }), { message: "only this" });
});

test("a job failed by the sweep that recorded a gate loses the question on a retry, and its publish stays", async (t) => {
  const home = retryHome(t, "consume-swept");
  seedRow(home, { status: "failed" });
  recordPrUrl({ projectId: home.projectId, slug: SLUG, prUrl: PR_URL, env: home.env });
  recordOutcome({ projectId: home.projectId, slug: SLUG, status: "gate", notice: OLD_NOTICE, env: home.env });

  await applyRetry({ id: home.id, env: home.env });

  const outcome = readRunState({ projectId: home.projectId, slug: SLUG, env: home.env }).outcome;
  assert.deepEqual([outcome.status, outcome.notice, outcome.prUrl], [undefined, undefined, PR_URL]);
});
