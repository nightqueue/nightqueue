import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { stateDir } from "../../src/config/paths.mjs";
import { buildDigest, defaultRunClaude, extractJson, runReflectWorker } from "../../src/hooks/reflect-worker.mjs";
import { recordInjected } from "../../src/hooks/state.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { getLesson, saveLesson } from "../../src/memory/lessons.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const LEAK_TITLE = "the worker leaks a file descriptor on failure";
const LEAK_PREVENTION = "always close the file descriptor in a finally block";
const FILLER_LESSONS = 20;

const LESSON_ANSWER = JSON.stringify({
  lessons: [
    {
      kind: "error",
      title: LEAK_TITLE,
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: LEAK_PREVENTION,
      target: "coder",
    },
  ],
});

// Writes a transcript file and returns its path.
function writeTranscript(t, lines) {
  const path = join(makeDir(t, "reflect-transcript"), "session.jsonl");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

// One readable message line of a transcript.
function message(type, text) {
  return JSON.stringify({ type, message: { content: [{ type: "text", text }] } });
}

// Transcript long enough to pass the digest floor.
function leakTranscript(t) {
  return writeTranscript(t, [
    message("user", "the worker leaks a file descriptor when the run fails and every retry burns one more ".repeat(6)),
    message("assistant", "the early return skipped the close, so the fix is a finally block around it ".repeat(6)),
  ]);
}

// Model double that records every call instead of spawning anything.
function fakeClaude(answer) {
  const calls = [];
  return {
    calls,
    run: async ({ prompt, input, model, timeoutMs }) => {
      calls.push({ prompt, input, model, timeoutMs });
      return typeof answer === "function" ? answer(calls.length) : answer;
    },
  };
}

// Parsed reflection state file of a home.
function readReflectState(env) {
  return JSON.parse(readFileSync(join(stateDir(env), "reflect.json"), "utf8"));
}

// Read offset stored for a session, or null when the session has no entry.
function offsetOf(env, sessionId) {
  return readReflectState(env).sessions[sessionId]?.offset ?? null;
}

// Opens the throttle window, so the next run is not skipped for being too soon.
function clearThrottle(env) {
  const state = readReflectState(env);
  for (const entry of Object.values(state.sessions)) entry.last_run = 0;
  writeFileSync(join(stateDir(env), "reflect.json"), JSON.stringify(state));
}

// Lessons stored in a home.
function lessonRows(env) {
  return openDb(env).prepare("SELECT * FROM lessons ORDER BY id").all();
}

// Unrelated lesson used only to fill the injection window of a long session.
function saveFiller(env, i) {
  return saveLesson(
    {
      project: "alpha",
      title: `filler lesson number ${i} about something unrelated`,
      root_cause: "unrelated root cause",
      solution: "unrelated solution",
      prevention: `unrelated prevention rule number ${i}`,
    },
    env,
  );
}

test("a fresh transcript becomes a lesson of the project of the session", async (t) => {
  const env = makeHome(t, "worker-save");
  const repo = makeProject(t, env, "alpha");
  const transcriptPath = leakTranscript(t);
  const claude = fakeClaude(LESSON_ANSWER);

  const result = await runReflectWorker({ transcriptPath, cwd: repo, sessionId: "s1" }, { env, runClaude: claude.run });
  assert.deepEqual({ saved: result.saved, skipped: result.skipped }, { saved: 1, skipped: null });
  const rows = lessonRows(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project, "alpha");
  assert.equal(rows[0].title, LEAK_TITLE);
  assert.equal(rows[0].target, "coder");
  assert.equal(rows[0].model, "reflect/haiku");
  assert.equal(claude.calls.length, 1);
  assert.match(claude.calls[0].prompt, /the worker leaks a file descriptor when the run fails/);
});

test("a repeated lesson merges through the judge instead of duplicating", async (t) => {
  const env = makeHome(t, "worker-merge");
  const repo = makeProject(t, env, "alpha");
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
  const claude = fakeClaude(LESSON_ANSWER.replace(LEAK_TITLE, `${LEAK_TITLE} again`));

  const result = await runReflectWorker(
    { transcriptPath: leakTranscript(t), cwd: repo, sessionId: "s1" },
    { env, runClaude: claude.run, judge: async (payload) => ({ [payload[0].ref]: existing.id }) },
  );
  assert.deepEqual({ saved: result.saved, merged: result.merged }, { saved: 0, merged: 1 });
  assert.equal(lessonRows(env).length, 1);
  assert.equal(getLesson(existing.id, env).attempts, 3);
});

test("a lesson injected in the session and broken again is counted as violated", async (t) => {
  const env = makeHome(t, "worker-violation");
  const repo = makeProject(t, env, "alpha");
  const existing = saveLesson(
    {
      project: "alpha",
      title: LEAK_TITLE,
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: LEAK_PREVENTION,
    },
    env,
  );
  recordInjected("s1", [`l${existing.id}`], env);
  const claude = fakeClaude(LESSON_ANSWER.replace(LEAK_TITLE, `${LEAK_TITLE} again`));

  const result = await runReflectWorker(
    { transcriptPath: leakTranscript(t), cwd: repo, sessionId: "s1" },
    { env, runClaude: claude.run, judge: async (payload) => ({ [payload[0].ref]: existing.id }) },
  );
  assert.equal(result.violations, 1);
  const row = getLesson(existing.id, env);
  assert.equal(row.violated, 1);
  assert.ok(row.last_violated_at);
  assert.match(claude.calls[0].prompt, new RegExp(`${existing.id}: ${LEAK_PREVENTION}`));
});

test("the lesson injected last is still counted as violated in a session past the injection window", async (t) => {
  const env = makeHome(t, "worker-violation-window");
  const repo = makeProject(t, env, "alpha");
  const fillers = [];
  for (let i = 0; i < FILLER_LESSONS; i += 1) {
    fillers.push(saveFiller(env, i));
  }
  const mostRecent = saveLesson(
    {
      project: "alpha",
      title: LEAK_TITLE,
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: LEAK_PREVENTION,
    },
    env,
  );
  recordInjected("s1", [...fillers.map((filler) => `l${filler.id}`), `l${mostRecent.id}`], env);
  const claude = fakeClaude(LESSON_ANSWER.replace(LEAK_TITLE, `${LEAK_TITLE} again`));

  const result = await runReflectWorker(
    { transcriptPath: leakTranscript(t), cwd: repo, sessionId: "s1" },
    { env, runClaude: claude.run, judge: async (payload) => ({ [payload[0].ref]: mostRecent.id }) },
  );
  assert.equal(result.violations, 1, "the most recently injected lesson was not counted as violated");
  assert.equal(getLesson(mostRecent.id, env).violated, 1);
  assert.match(claude.calls[0].prompt, new RegExp(`${mostRecent.id}: ${LEAK_PREVENTION}`));
});

test("a model failure leaves the offset untouched and the slice is processed again", async (t) => {
  const env = makeHome(t, "worker-offset");
  const repo = makeProject(t, env, "alpha");
  const transcriptPath = leakTranscript(t);
  const failed = await runReflectWorker(
    { transcriptPath, cwd: repo, sessionId: "s1" },
    {
      env,
      runClaude: async () => {
        throw new Error("the model exploded");
      },
    },
  );
  assert.equal(failed.skipped, "failed");
  assert.equal(offsetOf(env, "s1"), 0);
  assert.deepEqual(lessonRows(env), []);

  clearThrottle(env);
  const claude = fakeClaude(LESSON_ANSWER);
  const retried = await runReflectWorker({ transcriptPath, cwd: repo, sessionId: "s1" }, { env, runClaude: claude.run });
  assert.equal(retried.saved, 1);
  assert.match(claude.calls[0].prompt, /the worker leaks a file descriptor when the run fails/);
  assert.equal(offsetOf(env, "s1"), statSync(transcriptPath).size);
});

test("a second run is throttled, and once the window opens it finds no new content", async (t) => {
  const env = makeHome(t, "worker-throttle");
  const repo = makeProject(t, env, "alpha");
  const transcriptPath = leakTranscript(t);
  const claude = fakeClaude(LESSON_ANSWER);
  const call = () => runReflectWorker({ transcriptPath, cwd: repo, sessionId: "s1" }, { env, runClaude: claude.run });

  assert.equal((await call()).saved, 1);
  assert.equal((await call()).skipped, "throttled");
  assert.equal(claude.calls.length, 1);

  clearThrottle(env);
  assert.equal((await call()).skipped, "no new content");
  assert.equal(claude.calls.length, 1);
});

test("a malformed transcript never throws and never reaches the model", async (t) => {
  const env = makeHome(t, "worker-malformed");
  const repo = makeProject(t, env, "alpha");
  const claude = fakeClaude(LESSON_ANSWER);
  const broken = [
    writeTranscript(t, Array.from({ length: 20 }, (_, i) => `this line ${i} is not json at all, just prose`)),
    writeTranscript(
      t,
      Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: "user", message: { content: i } })),
    ),
  ];
  const binary = join(makeDir(t, "reflect-binary"), "session.jsonl");
  writeFileSync(binary, Buffer.from(Array.from({ length: 2000 }, (_, i) => i % 251)));
  broken.push(binary);

  for (const [index, transcriptPath] of broken.entries()) {
    const result = await runReflectWorker(
      { transcriptPath, cwd: repo, sessionId: `s${index}` },
      { env, runClaude: claude.run },
    );
    assert.equal(result.skipped, "digest too short", `transcript ${index}`);
  }
  assert.equal(claude.calls.length, 0);
  assert.deepEqual(lessonRows(env), []);
});

test("a delta shorter than the floor is not worth a model call", async (t) => {
  const env = makeHome(t, "worker-small");
  const repo = makeProject(t, env, "alpha");
  const claude = fakeClaude(LESSON_ANSWER);
  const transcriptPath = writeTranscript(t, [message("user", "fix the worker please")]);
  const result = await runReflectWorker(
    { transcriptPath, cwd: repo, sessionId: "s1" },
    { env, runClaude: claude.run },
  );
  assert.equal(result.skipped, "digest too short");
  assert.equal(claude.calls.length, 0);
});

test("a session outside a registered project is not reflected upon", async (t) => {
  const env = makeHome(t, "worker-unregistered");
  const claude = fakeClaude(LESSON_ANSWER);
  const result = await runReflectWorker(
    { transcriptPath: leakTranscript(t), cwd: makeDir(t, "worker-loose"), sessionId: "s1" },
    { env, runClaude: claude.run },
  );
  assert.equal(result.skipped, "project not registered");
  assert.equal(claude.calls.length, 0);
});

test("a missing transcript is a clean skip", async (t) => {
  const env = makeHome(t, "worker-missing");
  const repo = makeProject(t, env, "alpha");
  const claude = fakeClaude(LESSON_ANSWER);
  const result = await runReflectWorker(
    { transcriptPath: join(makeDir(t, "worker-empty"), "gone.jsonl"), cwd: repo, sessionId: "s1" },
    { env, runClaude: claude.run },
  );
  assert.equal(result.skipped, "missing transcript");
  assert.equal(claude.calls.length, 0);
});

test("an answer without JSON teaches nothing and breaks nothing", async (t) => {
  const env = makeHome(t, "worker-no-json");
  const repo = makeProject(t, env, "alpha");
  const claude = fakeClaude("I could not find anything worth remembering in this session.");
  const lines = [];
  const result = await runReflectWorker(
    { transcriptPath: leakTranscript(t), cwd: repo, sessionId: "s1" },
    { env, runClaude: claude.run, log: (line) => lines.push(line) },
  );
  assert.deepEqual({ saved: result.saved, skipped: result.skipped }, { saved: 0, skipped: null });
  assert.deepEqual(lessonRows(env), []);
  assert.ok(lines.some((line) => line.startsWith("no JSON in the model answer")));
});

test("the JSON of the answer is scanned, not guessed by a greedy regex", () => {
  assert.deepEqual(extractJson('prefix {"a":"}"} suffix'), { a: "}" });
  assert.deepEqual(extractJson('```json\n{"lessons":[]}\n```'), { lessons: [] });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson('{"broken": '), null);
  assert.equal(buildDigest("not json\n{}\n"), "");
});

test("the default runner explains a missing claude binary and costs no lesson", async (t) => {
  const env = makeHome(t, "worker-no-claude");
  const repo = makeProject(t, env, "alpha");
  const previous = process.env.NIGHTSHIFT_CLAUDE_BIN;
  process.env.NIGHTSHIFT_CLAUDE_BIN = join(makeDir(t, "worker-bin"), "claude-that-does-not-exist");
  t.after(() => {
    if (previous === undefined) delete process.env.NIGHTSHIFT_CLAUDE_BIN;
    else process.env.NIGHTSHIFT_CLAUDE_BIN = previous;
  });

  assert.throws(
    () => defaultRunClaude({ prompt: "hello", model: "haiku", timeoutMs: 1000 }),
    /CLI not found in PATH; the reflection needs it/,
  );
  const lines = [];
  const result = await runReflectWorker(
    { transcriptPath: leakTranscript(t), cwd: repo, sessionId: "s1" },
    { env, log: (line) => lines.push(line) },
  );
  assert.equal(result.skipped, "failed");
  assert.equal(offsetOf(env, "s1"), 0);
  assert.ok(lines.some((line) => line.includes("CLI not found in PATH")));
});
