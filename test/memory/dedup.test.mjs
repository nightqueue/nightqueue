import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveLessonDeduped } from "../../src/memory/dedup.mjs";
import { getLesson } from "../../src/memory/lessons.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const LEAK_TITLE = "the worker leaks a file descriptor on failure";
const LEAK_PREVENTION = "always close the file descriptor in a finally block";

// Counts the lessons stored in a home.
function lessonCount(env) {
  return openDb(env).prepare("SELECT COUNT(*) AS total FROM lessons").get().total;
}

// Lesson fields shared by the tests, with per-test overrides.
function item(overrides = {}) {
  return {
    title: LEAK_TITLE,
    root_cause: "the early return skipped the close",
    solution: "close it in a finally block",
    prevention: LEAK_PREVENTION,
    target: "coder",
    ...overrides,
  };
}

test("the cheap dedup bumps the existing lesson instead of storing a twin", async (t) => {
  const env = makeHome(t, "dedup-cheap");
  makeProject(t, env, "alpha");
  const first = await saveLessonDeduped({ projectId: projectIdOf(env, "alpha"), ...item(), attempts: 2 }, env);
  assert.deepEqual({ deduped: first.deduped, attempts: first.attempts }, { deduped: false, attempts: 2 });

  const second = await saveLessonDeduped({ projectId: projectIdOf(env, "alpha"), ...item(), attempts: 2 }, env);
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);
  assert.equal(second.attempts, 3);
  assert.equal(lessonCount(env), 1);
  assert.equal(getLesson(first.id, env).attempts, 3);
});

test("the cheap dedup compares normalized titles", async (t) => {
  const env = makeHome(t, "dedup-normalize");
  makeProject(t, env, "alpha");
  const first = await saveLessonDeduped({ projectId: projectIdOf(env, "alpha"), ...item({ title: "fix the bug" }) }, env);
  const second = await saveLessonDeduped({ projectId: projectIdOf(env, "alpha"), ...item({ title: "Fix THE  bug!" }) }, env);
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);
  assert.equal(lessonCount(env), 1);
});

test("the same title in another project is another lesson", async (t) => {
  const env = makeHome(t, "dedup-scope");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const first = await saveLessonDeduped({ projectId: projectIdOf(env, "alpha"), ...item() }, env);
  const second = await saveLessonDeduped({ projectId: projectIdOf(env, "beta"), ...item() }, env);
  assert.equal(second.deduped, false);
  assert.notEqual(second.id, first.id);
  assert.equal(lessonCount(env), 2);
});

test("a partial lesson is still stored, and the answer names exactly the fields left empty", async (t) => {
  const env = makeHome(t, "dedup-partial");
  makeProject(t, env, "alpha");
  const partial = await saveLessonDeduped(
    { projectId: projectIdOf(env, "alpha"), title: "the worker retries the same broken payload", root_cause: "the payload was never rebuilt" },
    env,
  );
  assert.equal(partial.deduped, false);
  assert.deepEqual(partial.incomplete, ["solution", "prevention"]);
  const stored = getLesson(partial.id, env);
  assert.equal(stored.solution, "");
  assert.equal(stored.prevention, "");

  const complete = await saveLessonDeduped({ projectId: projectIdOf(env, "alpha"), ...item({ title: "a fully described lesson" }) }, env);
  assert.deepEqual(complete.incomplete, []);
});

test("a follow-up call backfills only the fields still empty, never one that already has text", async (t) => {
  const env = makeHome(t, "dedup-backfill");
  makeProject(t, env, "alpha");
  const first = await saveLessonDeduped(
    { projectId: projectIdOf(env, "alpha"), title: LEAK_TITLE, root_cause: "the early return skipped the close" },
    env,
  );
  assert.deepEqual(first.incomplete, ["solution", "prevention"]);

  const second = await saveLessonDeduped(
    { projectId: projectIdOf(env, "alpha"), title: LEAK_TITLE, root_cause: "a different root cause", solution: "close it in a finally block", prevention: LEAK_PREVENTION },
    env,
  );
  assert.equal(second.id, first.id);
  assert.deepEqual(second.incomplete, []);
  const stored = getLesson(first.id, env);
  assert.equal(stored.root_cause, "the early return skipped the close", "an already-filled field was overwritten");
  assert.equal(stored.solution, "close it in a finally block");
  assert.equal(stored.prevention, LEAK_PREVENTION);
});
