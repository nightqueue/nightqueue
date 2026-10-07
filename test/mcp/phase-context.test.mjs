import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { sessionStatePath } from "../../src/hooks/state.mjs";
import { phaseContextBlock } from "../../src/mcp/phase-context.mjs";
import { saveProjectIndex } from "../../src/memory/index.mjs";
import { addJob, claimJobById, persistRunFacts } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { saveMemory } from "../../src/memory/memory.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { ensureProject, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const WORKER = "host:4242";
const SESSION = "session-of-the-run";

// A home with the project `alpha` and one claimed job whose row already names its run and its session.
function makeRunningJob(t, name, { sessionId = SESSION } = {}) {
  const env = makeHome(t, name);
  const repo = makeProject(t, env, "alpha");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "rewrite the runner" }, env);
  claimJobById(job.id, { worker: WORKER, cap: 4 }, env);
  persistRunFacts(job.id, { worker: WORKER, slug: "rewrite-the-runner", sessionId }, env);
  return { env: { ...env, NIGHTQUEUE_JOB_ID: String(job.id) }, home: env, repo };
}

// Stores one lesson of the project.
function addLesson(env, title) {
  return saveLesson(
    { projectId: projectIdOf(env, "alpha"), title, root_cause: `${title} happened`, solution: "fix it", prevention: `prevention of ${title}` },
    env,
  ).id;
}

// The lesson ids a block injected, in the order they appear.
function lessonIdsOf(block) {
  return [...block.matchAll(/\[L(\d+)\]/g)].map((match) => Number(match[1]));
}

test("a fresh phase gets a block, and the next phase of the same run gets other lessons", async (t) => {
  const { env } = makeRunningJob(t, "phase-context-fresh");
  for (let i = 0; i < 8; i += 1) addLesson(env, `the worker leaks a descriptor number ${i}`);
  saveMemory({ projectId: projectIdOf(env, "alpha"), key: "worker", value: "the worker runs from the pipeline" }, env);

  const first = await phaseContextBlock({ target: "coder", query: "worker descriptor" }, env);
  assert.equal(first.project, "alpha");
  assert.match(first.block, /^## Applicable lessons\n- \[L\d+\] prevention of /);
  assert.match(first.block, /## Project memory\n- \[M\d+\] worker: the worker runs from the pipeline/);
  assert.equal(first.block.includes("## Structural index"), false);

  const second = await phaseContextBlock({ target: "qa", query: "worker descriptor" }, env);
  const repeated = lessonIdsOf(second.block).filter((id) => lessonIdsOf(first.block).includes(id));
  assert.deepEqual(repeated, [], "a phase was handed a lesson another phase of the same run already got");
});

test("a run that already saw everything gets the lessons again instead of an empty block", async (t) => {
  const { env } = makeRunningJob(t, "phase-context-retry");
  const ids = [addLesson(env, "the runner drops the lease"), addLesson(env, "the runner renews the lease too late")];

  const first = await phaseContextBlock({ target: "coder", query: "runner lease" }, env);
  assert.deepEqual(lessonIdsOf(first.block).sort(), [...ids].sort());

  const again = await phaseContextBlock({ target: "verifier", query: "runner lease" }, env);
  assert.notEqual(again.block, "", "the exclusion emptied the block instead of retrying without it");
  assert.deepEqual(lessonIdsOf(again.block).sort(), [...ids].sort());
});

test("outside a job nothing is excluded and no session is written", async (t) => {
  const env = makeHome(t, "phase-context-outside");
  makeProject(t, env, "alpha");
  const ids = [addLesson(env, "the runner drops the lease"), addLesson(env, "the runner renews the lease too late")];

  const first = await phaseContextBlock({ target: "coder", query: "runner lease", project: "alpha" }, env);
  const second = await phaseContextBlock({ target: "coder", query: "runner lease", project: "alpha" }, env);
  assert.deepEqual(lessonIdsOf(first.block).sort(), [...ids].sort());
  assert.deepEqual(lessonIdsOf(second.block).sort(), [...ids].sort());
  assert.equal(existsSync(sessionStatePath(SESSION, env)), false);
});

test("only the explore carries the structural index, with the files the checkout moved under marked", async (t) => {
  const { env, repo } = makeRunningJob(t, "phase-context-index");
  addLesson(env, "the runner drops the lease");
  saveProjectIndex(
    {
      projectId: projectIdOf(env, "alpha"),
      repoRoot: repo,
      files: [{ path: "src/queue/runner.mjs", responsibility: "runs one job from claim to finalize" }],
      libs: [{ lib: "zod", version: "4.5.4" }],
    },
    env,
  );

  const explore = await phaseContextBlock({ target: "explore", query: "runner", repoRoot: repo }, env);
  assert.match(explore.block, /## Structural index\n- src\/queue\/runner\.mjs — runs one job from claim to finalize \(REVALIDATE\)/);
  assert.match(explore.block, /- libs: zod@4\.5\.4/);

  const coder = await phaseContextBlock({ target: "coder", query: "runner", repoRoot: repo }, env);
  assert.equal(coder.block.includes("## Structural index"), false);
});

test("a project with nothing to say produces an empty block, not a header", async (t) => {
  const { env } = makeRunningJob(t, "phase-context-empty");
  const answer = await phaseContextBlock({ target: "architect", query: "nothing was ever recorded here" }, env);
  assert.equal(answer.block, "");
});

// A home with the project `alpha` whose first job is already done, with a notice and a pull request.
function makeDoneJob(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const job = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the runner lease renewal" }, env);
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', notice_md = ?, pr_url = ?, finished_at = ? WHERE id = ?")
    .run("the lease is renewed before it expires", "https://github.com/o/r/pull/42", "2026-09-30 10:00:00", job.id);
  return env;
}

test("the triager gets the related jobs of its project, in the ref-title-status line", async (t) => {
  const env = makeDoneJob(t, "phase-context-jobs-triager");
  const triager = await phaseContextBlock({ target: "triager", query: "runner lease", project: "alpha" }, env);
  assert.ok(
    triager.block.includes("## Related jobs\n- [J-1] fix the runner lease renewal [done · PR #42 · 2026-09-30]"),
    triager.block,
  );
});

test("a phase other than the triager gets no related jobs", async (t) => {
  const env = makeDoneJob(t, "phase-context-jobs-coder");
  const coder = await phaseContextBlock({ target: "coder", query: "runner lease", project: "alpha" }, env);
  assert.equal(coder.block.includes("## Related jobs"), false);
});

test("the triager of a job never sees its own job among the related ones", async (t) => {
  const { env, home } = makeRunningJob(t, "phase-context-jobs-own");
  addJob({ projectId: projectIdOf(home, "alpha"), prompt: "the runner drops its lease" }, home);
  const triager = await phaseContextBlock({ target: "triager", query: "runner lease" }, env);
  assert.ok(triager.block.includes("## Related jobs\n- [J-2] the runner drops its lease [pending]"), triager.block);
  assert.equal(triager.block.includes("[J-1]"), false);
});
