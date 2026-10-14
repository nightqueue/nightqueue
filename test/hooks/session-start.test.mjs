import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { stateDir } from "../../src/config/paths.mjs";
import { runSessionStart } from "../../src/hooks/session-start.mjs";
import { sessionStatePath } from "../../src/hooks/state.mjs";
import { getLesson, saveLesson } from "../../src/memory/lessons.mjs";
import { saveMemory } from "../../src/memory/memory.mjs";
import { makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

// Stores one lesson of the project, returning its id.
function addLesson(env, { project = "alpha", title, prevention = "always close the descriptor in a finally block" }) {
  return saveLesson({ projectId: projectIdOf(env, project), title, root_cause: `${title} happened`, solution: "fix it", prevention }, env).id;
}

// Parsed session state file of a session.
function readState(sessionId, env) {
  return JSON.parse(readFileSync(sessionStatePath(sessionId, env), "utf8"));
}

test("the session block lists the lessons and the memory of the project", async (t) => {
  const env = makeHome(t, "hook-start-block");
  const repo = makeProject(t, env, "alpha");
  const id = addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  saveMemory({ projectId: projectIdOf(env, "alpha"), key: "deploy", value: "the deployment runs from the pipeline" }, env);

  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  assert.match(block, /^# Nightqueue context/);
  assert.match(block, new RegExp(`\\[L${id}\\] the worker leaks a file descriptor on failure`));
  assert.match(block, /## Project memory \(alpha\)/);
  assert.match(block, /- deploy: the deployment runs from the pipeline/);
  assert.match(block, /Call `lesson_save` as soon as an error costs a second attempt/);
});

test("the session block registers what it injected, in the state and in the corpus", async (t) => {
  const env = makeHome(t, "hook-start-state");
  const repo = makeProject(t, env, "alpha");
  const id = addLesson(env, { title: "the worker leaks a file descriptor on failure" });

  await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  const state = readState("s1", env);
  assert.equal(state.session_id, "s1");
  assert.deepEqual(state.injected, [{ ref: `l${id}`, seq: 0 }]);
  const lesson = getLesson(id, env);
  assert.equal(lesson.injected, 1);
  assert.ok(lesson.last_injected_at);
});

test("a home with nothing to say produces no block at all", async (t) => {
  const env = makeHome(t, "hook-start-empty");
  const repo = makeProject(t, env, "alpha");
  assert.equal(await runSessionStart({ input: { session_id: "s1", cwd: repo }, env }), "");
  assert.equal(existsSync(sessionStatePath("s1", env)), false);
});

test("a session outside any checkout names the project nightqueue open preselected, even with no memory to recall", async (t) => {
  const env = makeHome(t, "hook-start-preselected");
  makeProject(t, env, "alpha");
  const session = { ...env, NIGHTQUEUE_MODE: "operator", NIGHTQUEUE_PROJECT: projectIdOf(env, "alpha") };
  const elsewhere = makeDir(t, "hook-start-home-cwd");

  const empty = await runSessionStart({ input: { session_id: "s1", cwd: elsewhere }, env: session });
  assert.equal(empty, "# Nightqueue context\n\nCurrent project (preselected by nightqueue open): alpha");

  const id = addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  const block = await runSessionStart({ input: { session_id: "s2", cwd: elsewhere }, env: session });
  assert.match(block, /^# Nightqueue context\n\nCurrent project \(preselected by nightqueue open\): alpha\n\n/);
  assert.match(block, new RegExp(`\\[L${id}\\]`));
});

test("the preselected project is ignored inside a job, for a non-id value, and when the session's directory names a project", async (t) => {
  const env = makeHome(t, "hook-start-preselected-ignored");
  const repo = makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const elsewhere = makeDir(t, "hook-start-ignored-cwd");
  const beta = projectIdOf(env, "beta");

  assert.equal(await runSessionStart({ input: { session_id: "s1", cwd: elsewhere }, env: { ...env, NIGHTQUEUE_PROJECT: beta, NIGHTQUEUE_JOB_ID: "7" } }), "");
  assert.equal(await runSessionStart({ input: { session_id: "s2", cwd: elsewhere }, env: { ...env, NIGHTQUEUE_PROJECT: "beta" } }), "");
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  const block = await runSessionStart({ input: { session_id: "s3", cwd: repo }, env: { ...env, NIGHTQUEUE_PROJECT: beta } });
  assert.doesNotMatch(block, /Current project/);
  assert.match(block, /the worker leaks a file descriptor/);
});

test("a corpus larger than the budget is cut at nine thousand characters", async (t) => {
  const env = makeHome(t, "hook-start-clip");
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < 12; i += 1) {
    addLesson(env, { title: `lesson number ${i}`, prevention: "always close the descriptor ".repeat(80) });
  }
  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  assert.equal(block.length, 9000);
});

test("the session block carries the lessons first and the memory after them, and no decision section", async (t) => {
  const env = makeHome(t, "hook-start-sections");
  const repo = makeProject(t, env, "alpha");
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });
  saveMemory({ projectId: projectIdOf(env, "alpha"), key: "deploy", value: "the deployment runs from the pipeline" }, env);

  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env });
  const headings = block.split("\n").filter((line) => line.startsWith("## "));
  assert.deepEqual(headings, ["## Lessons learned (do not repeat these mistakes)", "## Project memory (alpha)"]);
  assert.doesNotMatch(block, /decision/i);
});

test("a working directory outside every registered project leaks nothing into the session", async (t) => {
  const env = makeHome(t, "hook-start-outside");
  makeProject(t, env, "alpha");
  addLesson(env, { title: "the alpha worker leaks a file descriptor on failure" });
  saveMemory({ projectId: projectIdOf(env, "alpha"), key: "deploy", value: "the deployment runs from the pipeline" }, env);
  saveLesson(
    {
      projectId: null,
      title: "a global lesson about the fun\u00e7\u00e3o that never closes",
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: "always close the descriptor in a finally block",
    },
    env,
  );
  const outside = makeDir(t, "hook-start-outside-cwd");

  assert.equal(await runSessionStart({ input: { session_id: "s1", cwd: outside }, env }), "");
  assert.equal(existsSync(sessionStatePath("s1", env)), false);
});

test("a hostile session id cannot write outside the state directory", async (t) => {
  const env = makeHome(t, "hook-start-hostile");
  const repo = makeProject(t, env, "alpha");
  addLesson(env, { title: "the worker leaks a file descriptor on failure" });

  await runSessionStart({ input: { session_id: "../../evil", cwd: repo }, env });
  assert.deepEqual(readdirSync(stateDir(env)), [".._.._evil.json"]);
  assert.equal(readState("../../evil", env).session_id, ".._.._evil");
});
