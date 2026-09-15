import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { persistLessons, saveLessonDeduped } from "../../src/memory/dedup.mjs";
import { getLesson, saveLesson } from "../../src/memory/lessons.mjs";
import { memoryByKey } from "../../src/memory/memory.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const LEAK_TITLE = "the worker leaks a file descriptor on failure";
const LEAK_PREVENTION = "always close the file descriptor in a finally block";

// Counts the lessons stored in a home.
function lessonCount(env) {
  return openDb(env).prepare("SELECT COUNT(*) AS total FROM lessons").get().total;
}

// Reflector item shaped the way the worker hands it over.
function item(overrides = {}) {
  return {
    kind: "error",
    title: LEAK_TITLE,
    root_cause: "the early return skipped the close",
    solution: "close it in a finally block",
    prevention: LEAK_PREVENTION,
    target: "coder",
    ...overrides,
  };
}

// Collects the diagnostic lines of a persistence run.
function makeLog() {
  const lines = [];
  return { lines, write: (line) => lines.push(line) };
}

test("the cheap dedup bumps the existing lesson instead of storing a twin", async (t) => {
  const env = makeHome(t, "dedup-cheap");
  makeProject(t, env, "alpha");
  const first = await saveLessonDeduped({ project: "alpha", ...item(), attempts: 2 }, env);
  assert.deepEqual({ deduped: first.deduped, attempts: first.attempts }, { deduped: false, attempts: 2 });

  const second = await saveLessonDeduped({ project: "alpha", ...item(), attempts: 2 }, env);
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);
  assert.equal(second.attempts, 3);
  assert.equal(lessonCount(env), 1);
  assert.equal(getLesson(first.id, env).attempts, 3);
});

test("the cheap dedup compares normalized titles", async (t) => {
  const env = makeHome(t, "dedup-normalize");
  makeProject(t, env, "alpha");
  const first = await saveLessonDeduped({ project: "alpha", ...item({ title: "fix the bug" }) }, env);
  const second = await saveLessonDeduped({ project: "alpha", ...item({ title: "Fix THE  bug!" }) }, env);
  assert.equal(second.deduped, true);
  assert.equal(second.id, first.id);
  assert.equal(lessonCount(env), 1);
});

test("the same title in another project is another lesson", async (t) => {
  const env = makeHome(t, "dedup-scope");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const first = await saveLessonDeduped({ project: "alpha", ...item() }, env);
  const second = await saveLessonDeduped({ project: "beta", ...item() }, env);
  assert.equal(second.deduped, false);
  assert.notEqual(second.id, first.id);
  assert.equal(lessonCount(env), 2);
});

test("a partial lesson is still stored, and the answer names exactly the fields left empty", async (t) => {
  const env = makeHome(t, "dedup-partial");
  makeProject(t, env, "alpha");
  const partial = await saveLessonDeduped(
    { project: "alpha", title: "the worker retries the same broken payload", root_cause: "the payload was never rebuilt" },
    env,
  );
  assert.equal(partial.deduped, false);
  assert.deepEqual(partial.incomplete, ["solution", "prevention"]);
  const stored = getLesson(partial.id, env);
  assert.equal(stored.solution, "");
  assert.equal(stored.prevention, "");

  const complete = await saveLessonDeduped({ project: "alpha", ...item({ title: "a fully described lesson" }) }, env);
  assert.deepEqual(complete.incomplete, []);
});

test("a follow-up call backfills only the fields still empty, never one that already has text", async (t) => {
  const env = makeHome(t, "dedup-backfill");
  makeProject(t, env, "alpha");
  const first = await saveLessonDeduped(
    { project: "alpha", title: LEAK_TITLE, root_cause: "the early return skipped the close" },
    env,
  );
  assert.deepEqual(first.incomplete, ["solution", "prevention"]);

  const second = await saveLessonDeduped(
    { project: "alpha", title: LEAK_TITLE, root_cause: "a different root cause", solution: "close it in a finally block", prevention: LEAK_PREVENTION },
    env,
  );
  assert.equal(second.id, first.id);
  assert.deepEqual(second.incomplete, []);
  const stored = getLesson(first.id, env);
  assert.equal(stored.root_cause, "the early return skipped the close", "an already-filled field was overwritten");
  assert.equal(stored.solution, "close it in a finally block");
  assert.equal(stored.prevention, LEAK_PREVENTION);
});

test("a batch deduplicates itself: the first item is stored and the twin is stationed for the judge", async (t) => {
  const env = makeHome(t, "dedup-batch");
  makeProject(t, env, "alpha");
  const log = makeLog();
  const judge = async (payload) => ({ [payload[0].ref]: payload[0].candidates[0].id });

  const result = await persistLessons([item(), item()], { project: "alpha", judge, log: log.write }, env);
  assert.deepEqual(
    { saved: result.saved, judged: result.judged, merged: result.merged },
    { saved: 1, judged: 1, merged: 1 },
  );
  assert.equal(lessonCount(env), 1);
});

test("a merge bumps the kept lesson and logs the content it dropped", async (t) => {
  const env = makeHome(t, "dedup-merge-log");
  makeProject(t, env, "alpha");
  const existing = saveLesson(
    {
      project: "alpha",
      title: LEAK_TITLE,
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: LEAK_PREVENTION,
      attempts: 2,
    },
    env,
  );
  const log = makeLog();
  const judge = async (payload) => ({ [payload[0].ref]: existing.id });

  const result = await persistLessons(
    [item({ title: `${LEAK_TITLE} again`, prevention: `${LEAK_PREVENTION} every time` })],
    { project: "alpha", judge, log: log.write },
    env,
  );
  assert.deepEqual({ saved: result.saved, merged: result.merged }, { saved: 0, merged: 1 });
  assert.equal(getLesson(existing.id, env).attempts, 3);
  assert.equal(lessonCount(env), 1);
  const merged = log.lines.filter((line) => line.startsWith("merged:"));
  assert.equal(merged.length, 1);
  assert.match(merged[0], /title="the worker leaks a file descriptor on failure again"/);
  assert.match(merged[0], /prevention="always close the file descriptor in a finally block every time"/);
});

test("a verdict pointing at an id that is not a candidate of that ref stores the lesson as new", async (t) => {
  const env = makeHome(t, "dedup-wrong-id");
  makeProject(t, env, "alpha");
  saveLesson(
    {
      project: "alpha",
      title: LEAK_TITLE,
      root_cause: "root",
      solution: "fix",
      prevention: LEAK_PREVENTION,
    },
    env,
  );
  const result = await persistLessons(
    [item({ title: `${LEAK_TITLE} again` })],
    { project: "alpha", judge: async () => ({ n0: 9999 }) },
    env,
  );
  assert.deepEqual({ saved: result.saved, merged: result.merged }, { saved: 1, merged: 0 });
  assert.equal(lessonCount(env), 2);
});

test("a judge that fails is fail-open: every stationed item is stored as new", async (t) => {
  const env = makeHome(t, "dedup-judge-fails");
  makeProject(t, env, "alpha");
  saveLesson(
    { project: "alpha", title: LEAK_TITLE, root_cause: "root", solution: "fix", prevention: LEAK_PREVENTION },
    env,
  );
  const log = makeLog();
  const result = await persistLessons(
    [item({ title: `${LEAK_TITLE} again` })],
    {
      project: "alpha",
      log: log.write,
      judge: async () => {
        throw new Error("judge is down");
      },
    },
    env,
  );
  assert.deepEqual({ saved: result.saved, merged: result.merged }, { saved: 1, merged: 0 });
  assert.equal(lessonCount(env), 2);
  assert.ok(log.lines.some((line) => line.includes("judge failed")));
});

test("a verdict cannot merge through a reserved key, and pollutes no object", async (t) => {
  const env = makeHome(t, "dedup-proto");
  makeProject(t, env, "alpha");
  const existing = saveLesson(
    { project: "alpha", title: LEAK_TITLE, root_cause: "root", solution: "fix", prevention: LEAK_PREVENTION },
    env,
  );
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"polluted":true}}');
  const first = await persistLessons(
    [item({ title: `${LEAK_TITLE} again` })],
    { project: "alpha", judge: async () => hostile },
    env,
  );
  assert.deepEqual({ saved: first.saved, merged: first.merged }, { saved: 1, merged: 0 });
  assert.equal({}.polluted, undefined);

  const mixed = JSON.parse(`{"__proto__":{"polluted":true},"n0":${existing.id}}`);
  const second = await persistLessons(
    [item({ title: `${LEAK_TITLE} once more` })],
    { project: "alpha", judge: async () => mixed },
    env,
  );
  assert.equal(second.merged, 1);
  assert.equal({}.polluted, undefined);
});

test("a lesson injected in the session and broken again counts as a violation", async (t) => {
  const env = makeHome(t, "dedup-violation");
  makeProject(t, env, "alpha");
  const existing = saveLesson(
    { project: "alpha", title: LEAK_TITLE, root_cause: "root", solution: "fix", prevention: LEAK_PREVENTION },
    env,
  );
  const result = await persistLessons(
    [item({ title: `${LEAK_TITLE} again` })],
    { project: "alpha", injectedIds: [existing.id], judge: async () => ({ n0: existing.id }) },
    env,
  );
  assert.equal(result.violations, 1);
  const row = getLesson(existing.id, env);
  assert.equal(row.violated, 1);
  assert.ok(row.last_violated_at);
});

test("a decision becomes a memory and never a lesson", async (t) => {
  const env = makeHome(t, "dedup-decision");
  makeProject(t, env, "alpha");
  const result = await persistLessons(
    [
      item({
        kind: "decision",
        title: "the reports read from the replica",
        solution: "every report query goes to the replica",
      }),
    ],
    { project: "alpha" },
    env,
  );
  assert.deepEqual({ saved: result.saved, memories: result.memories }, { saved: 0, memories: 1 });
  assert.equal(lessonCount(env), 0);
  assert.equal(memoryByKey({ project: "alpha", key: "the reports read from the replica" }, env).value, "every report query goes to the replica");
});
