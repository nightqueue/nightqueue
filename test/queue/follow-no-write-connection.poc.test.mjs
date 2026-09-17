import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { jobLogPath } from "../../src/config/paths.mjs";
import { closeDb, hasCachedWriteConnection } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// H1B: `queue log --follow`'s status reader goes through `openStore(env)`, whose eager `openDb(env)`
// (src/store/local.mjs:200) opens and caches a WRITE connection the very first time it runs in a process
// - where the pre-refactor reader called `openDbReadOnly(env)` fresh per poll and never touched the write
// cache. The probe is `hasCachedWriteConnection(env)`: it answers for the cache itself, where this PoC used
// to infer the answer from `-shm` disappearing on close - a side effect a read-only pin now prevents on
// purpose, and one that was only ever a proxy for the question actually being asked.
test("a queue log --follow session never opens a cached write connection to read a job's status", async (t) => {
  const env = makeHome(t, "follow-no-write-connection");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "done", prUrl: "https://github.com/acme/api/pull/7" }, env);

  mkdirSync(dirname(jobLogPath(id, env)), { recursive: true });
  writeFileSync(jobLogPath(id, env), "working on it\n");

  // Reset this process's state to exactly what a freshly started `queue log --follow` process would see:
  // no cached write connection, no leftover WAL side-file from the setup above.
  closeDb(env);
  assert.equal(hasCachedWriteConnection(env), false, "test setup itself left a write connection cached; the probe below would be meaningless");

  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 120, write: () => {} },
    sleep: async () => {},
  };
  const code = await run(["queue", "log", String(id), "--follow", "--raw"], ctx);
  assert.equal(code, 0, err.join("\n"));

  // The real assertion: the follow session must never have opened (and cached) a write connection at all.
  assert.equal(hasCachedWriteConnection(env), false, "a long-lived WRITE connection was left cached for the whole follow session, where the pre-refactor per-poll reader (openDbReadOnly, closed every tick) never held one");
});

// The same probe, applied to `queue status --follow`: a session with nothing to merge (the job has no pull
// request) and nothing to repair (there is no state.json) must never open a write connection at all.
test("a queue status --follow session with nothing to merge and nothing to repair never opens a cached write connection", async (t) => {
  const env = makeHome(t, "follow-status-no-write-connection");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "done" }, env);

  closeDb(env);
  assert.equal(hasCachedWriteConnection(env), false, "test setup itself left a write connection cached; the probe below would be meaningless");

  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdout: { isTTY: false, columns: 120, write: () => {} },
    sleep: async () => {},
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);
  assert.equal(code, 0, err.join("\n"));
  assert.ok(out.length, "the follow session never rendered the queue at all; this PoC's own precondition failed");

  assert.equal(hasCachedWriteConnection(env), false, "the session left a cached WRITE connection behind although it had nothing to merge and nothing to repair");
});
