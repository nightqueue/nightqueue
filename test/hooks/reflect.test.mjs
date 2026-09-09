import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { homeDir } from "../../src/config/paths.mjs";
import { runReflect } from "../../src/hooks/reflect.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

// Spawn double that records the call instead of starting a process.
function fakeSpawn() {
  const calls = [];
  return {
    calls,
    impl: (command, args, options) => {
      calls.push({ command, args, options });
      return { unref: () => calls.push({ unrefed: true }) };
    },
  };
}

// Payload the hook handed to the detached worker.
function payloadOf(call) {
  return JSON.parse(Buffer.from(call.args[1], "base64").toString("utf8"));
}

// Captures what the hook writes to stderr, so a failing spawn does not pollute the test output.
function captureStderr(t) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => {
    lines.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stderr.write = original;
  });
  return lines;
}

test("the hook answers immediately and starts the worker detached", (t) => {
  const env = makeHome(t, "hook-reflect-spawn");
  const spawn = fakeSpawn();
  const transcriptPath = join(makeDir(t, "hook-reflect-transcript"), "session.jsonl");

  const answer = runReflect({
    input: { session_id: "s1", cwd: "/tmp/repo", transcript_path: transcriptPath },
    env,
    spawnImpl: spawn.impl,
  });
  assert.equal(answer, "{}");

  const started = spawn.calls.filter((call) => call.command);
  assert.equal(started.length, 1);
  assert.equal(started[0].command, process.execPath);
  assert.match(started[0].args[0], /reflect-worker\.mjs$/);
  assert.equal(started[0].options.detached, true);
  assert.equal(started[0].options.env.NIGHTSHIFT_REFLECT, "1");
  assert.deepEqual(payloadOf(started[0]), {
    transcript_path: transcriptPath,
    cwd: "/tmp/repo",
    session_id: "s1",
  });
  assert.ok(spawn.calls.some((call) => call.unrefed));
});

test("an event without a transcript starts nothing", (t) => {
  const env = makeHome(t, "hook-reflect-no-transcript");
  const spawn = fakeSpawn();
  assert.equal(runReflect({ input: { session_id: "s1", cwd: "/tmp/repo" }, env, spawnImpl: spawn.impl }), "{}");
  assert.deepEqual(spawn.calls, []);
});

test("the reflection process never starts another reflection", (t) => {
  const env = { ...makeHome(t, "hook-reflect-guard"), NIGHTSHIFT_REFLECT: "1" };
  const spawn = fakeSpawn();
  const answer = runReflect({
    input: { session_id: "s1", cwd: "/tmp/repo", transcript_path: "/tmp/session.jsonl" },
    env,
    spawnImpl: spawn.impl,
  });
  assert.equal(answer, "{}");
  assert.deepEqual(spawn.calls, []);
});

test("a spawn that fails still answers the host", (t) => {
  const env = makeHome(t, "hook-reflect-fails");
  const errors = captureStderr(t);
  const answer = runReflect({
    input: { session_id: "s1", cwd: "/tmp/repo", transcript_path: "/tmp/session.jsonl" },
    env,
    spawnImpl: () => {
      throw new Error("no process for you");
    },
  });
  assert.equal(answer, "{}");
  assert.ok(errors.join("").includes("the reflection worker could not be started"));
});

test("a spawn failure that only arrives later goes to the reflection log instead of crashing the hook process", (t) => {
  const env = makeHome(t, "hook-reflect-async-failure");
  const child = new EventEmitter();
  child.unref = () => {};

  const answer = runReflect({
    input: { session_id: "s1", cwd: "/tmp/repo", transcript_path: "/tmp/session.jsonl" },
    env,
    spawnImpl: () => child,
  });
  assert.equal(answer, "{}");
  assert.equal(child.listenerCount("error"), 1, "without an error listener a later EMFILE/ENOENT becomes an uncaught exception in the hook");

  child.emit("error", new Error("no process for you"));
  assert.match(readFileSync(join(homeDir(env), "reflect.log"), "utf8"), /the reflection worker could not be started: no process for you/);
});
