import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StoreUnavailableError } from "../../src/config/errors.mjs";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { renameRunDir } from "../../src/queue/resume.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { provisionalSlug } from "../../src/queue/spawn.mjs";
import { createStoreOutage } from "../../src/queue/store-outage.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeCalls, useFakeClaude } from "../../test-support/queue-fake.mjs";
import { makeSickHome } from "../../test-support/sick-home.mjs";
import { assistantEvent, doneStream, noticeText, resultEvent, slugTypeEvent, systemInitEvent, toNdjson, transientFailureStream } from "../../test-support/streams.mjs";

const SESSION_SCRIPT = fileURLToPath(new URL("../../test-support/check-wait-session.mjs", import.meta.url));
const NEW_SLUG = "triaged-worker";

// A PROCEED triage whose Brief names the given slug line, or none.
function triageText({ slugLine = `**Slug:** ${NEW_SLUG}\n` } = {}) {
  return (
    "# Triage\n\n## Brief\n**Affected area:** src/worker.mjs\n**Context:** the worker\n**Objective:** fix the worker\n**Expected outcome:** the worker runs\n" +
    `**Type:** feature/refactor\n**Commit type:** fix\n${slugLine}\n## Verdict: PROCEED\n\nEvidence level: 1\n\n` +
    "## Validated brief\nFix the worker.\n\n## Out of scope\n- None.\n\n## Request gaps\n- None.\n"
  );
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => {
    const answer = answers[args[0]];
    if (answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
}

// Polls a condition until it holds, failing the test past the deadline.
async function until(check, what) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

// A home with project alpha, the triage file and the signal dir the session script reads.
function sessionHome(t, name, triage = triageText()) {
  const triagePath = join(makeDir(t, `${name}-triage`), "01-triage.md");
  writeFileSync(triagePath, triage);
  const signal = makeDir(t, `${name}-signal`);
  const env = makeHome(t, `${name}-home`);
  makeProject(t, env, "alpha");
  return { env, signal, exec: [SESSION_SCRIPT, triagePath, signal], projectId: ensureProject(env, "alpha") };
}

// The stream of a session that ends with a pull request, with its own session id.
function prStream(sessionId) {
  return toNdjson([systemInitEvent({ sessionId }), assistantEvent(noticeText(), { sessionId, messageId: "msg_notice" }), resultEvent({ text: "Done. Pull request: https://github.com/acme/api/pull/42", sessionId })]);
}

test("the retry attempt after an in-session rename is prompted with the NEW run dir, not the old one", async (t) => {
  const { env, signal, exec, projectId } = sessionHome(t, "retry-rundir");
  writeFileSync(join(signal, "go"), "1");
  const planPath = useFakeClaude(env, makeDir(t, "retry-rundir-plan"), [
    { exec, stdout: transientFailureStream(), exitCode: 1 },
    { exec, stdout: doneStream({ slug: NEW_SLUG }), exitCode: 0 },
  ]);
  const id = addJob({ projectId, prompt: "fix the worker", maxAttempts: 2 }, env).id;
  const provisional = provisionalSlug(getJob(id, env));

  await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });

  const calls = fakeCalls(planPath);
  assert.equal(calls.length, 2, "expected two attempts");
  const newDir = runDir(projectId, NEW_SLUG, env);
  const oldDir = runDir(projectId, provisional, env);
  const second = calls[1].argv.join("\n");
  assert.ok(second.includes(newDir), `attempt 2 prompt does not name the new run dir ${newDir}`);
  assert.ok(!second.includes(oldDir), `attempt 2 prompt still names the OLD run dir ${oldDir}`);
  assert.equal(existsSync(oldDir), false, "ghost dir at the old slug");
});

test("a run the check never renamed prompts its retry with exactly the first attempt's prompt", async (t) => {
  const { env, signal, exec, projectId } = sessionHome(t, "retry-same", triageText({ slugLine: "" }));
  writeFileSync(join(signal, "go"), "1");
  const planPath = useFakeClaude(env, makeDir(t, "retry-same-plan"), [
    { exec, stdout: transientFailureStream(), exitCode: 1 },
    { exec, stdout: doneStream(), exitCode: 0 },
  ]);
  const id = addJob({ projectId, prompt: "fix the worker", maxAttempts: 2 }, env).id;

  await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), sleepImpl: async () => {} } });

  const calls = fakeCalls(planPath);
  assert.equal(calls.length, 2, "expected two attempts");
  const prompt = (call) => call.argv.find((arg) => arg.includes("RUN_DIR:"));
  assert.ok(prompt(calls[0]), "the first attempt carries no RUN_DIR line");
  assert.equal(prompt(calls[1]), prompt(calls[0]));
});

test("a store outage after the in-session rename leaves no directory at the old slug", async (t) => {
  const { env, signal, exec, projectId } = sessionHome(t, "outage-rename");
  const planPath = useFakeClaude(env, makeDir(t, "outage-rename-plan"), [{ exec, stdout: prStream("sess-outage-1"), exitCode: 0 }]);
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  const oldDir = runDir(projectId, provisionalSlug(getJob(id, env)), env);

  const outage = createStoreOutage({ write: () => {}, sleepImpl: () => new Promise(() => {}), probeMs: 50 });
  let sick = null;
  t.after(() => sick?.restore());
  const cycle = runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit(), stopPollMs: 50, storeOutage: outage } });
  await until(() => existsSync(join(signal, "renamed")), "the rename");
  sick = makeSickHome(env);
  await until(() => outage.isActive(), "the outage");
  writeFileSync(join(signal, "go"), "1");
  const report = (await cycle).processed[0];
  sick.restore();

  const log = readFileSync(jobLogPath(id, env), "utf8");
  assert.equal(existsSync(oldDir), false, `ghost dir at the old slug ${oldDir}; report=${JSON.stringify(report)}\n${log}`);
  assert.equal(fakeCalls(planPath).length, 1);
});

test("a session record refused by an outage right after the run moved is queued in the run's new directory", async (t) => {
  const env = makeHome(t, "outage-mid-record-home");
  makeProject(t, env, "alpha");
  useFakeClaude(env, makeDir(t, "outage-mid-record-plan"), [{ stdout: prStream("sess-mid-1"), exitCode: 0 }]);
  const projectId = ensureProject(env, "alpha");
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  const provisional = provisionalSlug(getJob(id, env));
  const store = openStore(env);
  const realPersist = store.jobs.persistRunFacts;
  const realBind = store.jobs.bindRunSlug;
  t.after(() => {
    store.jobs.persistRunFacts = realPersist;
  });
  let moved = false;
  store.jobs.persistRunFacts = async (jobId, facts) => {
    if (moved || !facts?.lastSessionId) return realPersist(jobId, facts);
    moved = true;
    await realBind(jobId, { worker: getJob(jobId, env).worker, candidates: [NEW_SLUG] });
    renameRunDir({ projectId, from: provisional, to: NEW_SLUG, env });
    throw new StoreUnavailableError({ code: "SQLITE_BUSY", detail: "database is locked", home: env.NIGHTQUEUE_HOME, path: "nightqueue.db" });
  };

  await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });

  const log = readFileSync(jobLogPath(id, env), "utf8");
  assert.ok(moved, "the session record never reached the store");
  assert.ok(log.includes(`the session record waits in ${join(runDir(projectId, NEW_SLUG, env), "pending-writes.jsonl")}`), log);
  assert.equal(existsSync(runDir(projectId, provisional, env)), false, `ghost dir at the old slug\n${log}`);
});

test("a legacy SLUG: line after the check renamed the run renames from where the run lives, never from the vanished dir", async (t) => {
  const { env, signal, exec, projectId } = sessionHome(t, "legacy-slug");
  writeFileSync(join(signal, "go"), "1");
  const stream = toNdjson([systemInitEvent(), slugTypeEvent("legacy-name"), assistantEvent(noticeText(), { messageId: "msg_notice" }), resultEvent({ text: "Done. Pull request: https://github.com/acme/api/pull/42" })]);
  useFakeClaude(env, makeDir(t, "legacy-slug-plan"), [{ exec, stdout: stream, exitCode: 0 }]);
  const id = addJob({ projectId, prompt: "fix the worker" }, env).id;
  const provisional = provisionalSlug(getJob(id, env));

  await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });

  const log = readFileSync(jobLogPath(id, env), "utf8");
  const row = getJob(id, env);
  assert.equal(row.slug, "legacy-name", log);
  assert.ok(existsSync(runDir(projectId, row.slug, env)), `the row names a run directory that was never created\n${log}`);
  assert.equal(existsSync(runDir(projectId, NEW_SLUG, env)), false, "the run stayed at the check's slug as well");
  assert.equal(existsSync(runDir(projectId, provisional, env)), false, "ghost dir at the provisional slug");
});
