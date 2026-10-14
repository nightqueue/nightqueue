import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { jobLogPath, logsDir, runDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, closeRefusal, finishJob, getJob, isNoChangeJob, reclassifyJob, recoverJob, repairJobFromWitness } from "../../src/memory/jobs.mjs";
import { NO_CHANGE_NEXT_STEP_LINE } from "../../src/queue/classify.mjs";
import { reclassifyFromLog } from "../../src/queue/repair.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { ensureProject, makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { noticeText, resultEvent, SLUG, slugEvent, systemInitEvent, toNdjson } from "../../test-support/streams.mjs";

const WORKER = "host:1000";
const CONCLUSION = "✅ Resolved — no code change needed\n\nThe cause is a CDN rule.";
const NOTHING_TO_CLOSE = "nothing to close: the job has no pull request";
const CONCLUDED = toNdjson([systemInitEvent(), slugEvent(SLUG), resultEvent({ text: noticeText(CONCLUSION) })]);

// A home with project `alpha` registered.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// A job of `alpha` claimed by the test worker, its run bound to the slug of the tests.
function runningJob(env) {
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the loop" }, env).id;
  claimJobById(id, { worker: WORKER, cap: 4 }, env);
  openDb(env).prepare("UPDATE jobs SET slug = ? WHERE id = ?").run(SLUG, id);
  return id;
}

// Writes the state.json of the run of the tests with the outcome its pipeline recorded.
function writeOutcome(env, outcome) {
  const dir = runDir(ensureProject(env, "alpha"), SLUG, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ schemaVersion: 1, slug: SLUG, phases: [], outcome }));
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]]}\n`;
}

// The parsed `result` of a row.
function resultOf(env, id) {
  return JSON.parse(getJob(id, env).result);
}

test("a run that recorded no_change finishes done with the marker on its row and its witness, and the next-step line once", async (t) => {
  const env = makeQueue(t, "marker-finish");
  useFakeClaude(env, makeDir(t, "marker-finish-plan"), [{ stdout: CONCLUDED, exitCode: 0 }]);
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the loop" }, env).id;
  writeOutcome(env, { status: "no_change", notice: CONCLUSION });

  const cycle = await runCycle({ jobId: id, env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl: fakeGit() } });

  assert.equal(cycle.processed[0].status, "done", JSON.stringify(cycle.processed));
  const row = getJob(id, env);
  assert.equal(row.pr_url, null);
  assert.equal(resultOf(env, id).resolution, "no-change");
  assert.equal(row.notice_md.split(NO_CHANGE_NEXT_STEP_LINE).length - 1, 1, row.notice_md);
  assert.equal(isNoChangeJob(row), true);
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }).terminal.resolution, "no-change");
});

test("a witness done with no pull request and no resolution repairs into a done the close refuses; with the marker it repairs into a closable one", (t) => {
  const env = makeQueue(t, "marker-witness");
  const unmarked = runningJob(env);
  assert.equal(repairJobFromWitness(unmarked, { status: "done", prUrl: null, finishedAt: "2026-10-14T10:00:00Z" }, env), true);
  assert.equal(isNoChangeJob(getJob(unmarked, env)), false);
  assert.equal(closeRefusal(unmarked, getJob(unmarked, env)), NOTHING_TO_CLOSE);

  const marked = runningJob(env);
  assert.equal(repairJobFromWitness(marked, { status: "done", prUrl: null, resolution: "no-change", finishedAt: "2026-10-14T10:00:00Z" }, env), true);
  assert.equal(resultOf(env, marked).resolution, "no-change");
  assert.equal(resultOf(env, marked).repairedFrom, "state.json");
  assert.equal(closeRefusal(marked, getJob(marked, env)), null);

  const withPr = runningJob(env);
  repairJobFromWitness(withPr, { status: "done", prUrl: "https://github.com/acme/api/pull/7", resolution: "no-change" }, env);
  assert.equal(resultOf(env, withPr).resolution, undefined, "a pull request done kept the no-change marker");
});

test("a stale marker from an earlier attempt is removed when the witness repairs the row without one", (t) => {
  const env = makeQueue(t, "marker-stale");
  const id = runningJob(env);
  openDb(env).prepare(`UPDATE jobs SET result = '{"resolution":"no-change","retriedFrom":null}' WHERE id = ?`).run(id);
  assert.equal(repairJobFromWitness(id, { status: "done", prUrl: null }, env), true);
  assert.equal(resultOf(env, id).resolution, undefined);
  assert.equal(isNoChangeJob(getJob(id, env)), false);
  assert.equal(closeRefusal(id, getJob(id, env)), NOTHING_TO_CLOSE);
});

test("reclassifyJob writes the marker only for a done with no pull request that carries it, and removes a stale one", (t) => {
  const env = makeQueue(t, "marker-reclassify");
  const gated = runningJob(env);
  finishJob(gated, { worker: WORKER, status: "failed", result: { resolution: "no-change", exitCode: 0 } }, env);
  assert.equal(reclassifyJob(gated, { status: "done", prUrl: null, noticeMd: CONCLUSION }, env), true);
  assert.equal(resultOf(env, gated).resolution, undefined, "a stale marker survived a reclassify without one");

  const marked = runningJob(env);
  finishJob(marked, { worker: WORKER, status: "failed", result: { exitCode: 0 } }, env);
  assert.equal(reclassifyJob(marked, { status: "done", prUrl: null, noticeMd: CONCLUSION, resolution: "no-change" }, env), true);
  assert.equal(resultOf(env, marked).resolution, "no-change");
  assert.equal(isNoChangeJob(getJob(marked, env)), true);
});

test("reclassifyFromLog of a failed row whose state.json recorded no_change with its notice and a clean exit writes the marker", async (t) => {
  const env = makeQueue(t, "marker-reclassify-log");
  const id = runningJob(env);
  finishJob(id, { worker: WORKER, status: "failed", result: { status: "failed", exitCode: 0, timedOut: false, idleTimedOut: false }, noticeMd: "it failed" }, env);
  mkdirSync(logsDir(env), { recursive: true });
  writeFileSync(jobLogPath(id, env), CONCLUDED);
  writeOutcome(env, { status: "no_change", notice: CONCLUSION });

  const outcome = await reclassifyFromLog({ id, env });

  assert.deepEqual([outcome.from, outcome.to, outcome.changed], ["failed", "done", true]);
  const row = getJob(id, env);
  assert.equal(resultOf(env, id).resolution, "no-change");
  assert.equal(row.notice_md, `${CONCLUSION}\n\n${NO_CHANGE_NEXT_STEP_LINE}`);
  assert.equal(closeRefusal(id, row), null);
  assert.equal(readRunState({ projectId: ensureProject(env, "alpha"), slug: SLUG, env }).terminal.resolution, "no-change");
});

test("recoverJob writes the marker only when the recovered done has no pull request and carries it", (t) => {
  const env = makeQueue(t, "marker-recover");
  const projectId = ensureProject(env, "alpha");
  const recovered = { from: "disk" };
  assert.equal(recoverJob({ id: 41, projectId, slug: SLUG, status: "done", noticeMd: CONCLUSION, prUrl: null, recovered, resolution: "no-change" }, env), "recovered");
  assert.deepEqual(resultOf(env, 41), { recovered, resolution: "no-change" });
  assert.equal(recoverJob({ id: 42, projectId, slug: SLUG, status: "done", noticeMd: CONCLUSION, prUrl: null, recovered }, env), "recovered");
  assert.deepEqual(resultOf(env, 42), { recovered });
  assert.equal(closeRefusal(42, getJob(42, env)), NOTHING_TO_CLOSE);
  assert.equal(recoverJob({ id: 43, projectId, slug: SLUG, status: "failed", noticeMd: CONCLUSION, prUrl: null, recovered, resolution: "no-change" }, env), "recovered");
  assert.deepEqual(resultOf(env, 43), { recovered });
});
