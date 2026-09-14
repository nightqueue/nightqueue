import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbShmPath, jobLogPath } from "../../src/config/paths.mjs";
import { closeDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// H1B: `queue log --follow`'s status reader goes through `openStore(env)`, whose eager `openDb(env)`
// (src/store/local.mjs:200) opens and caches a WRITE connection the very first time it runs in a process
// - where the pre-refactor reader called `openDbReadOnly(env)` fresh per poll and never touched the write
// cache. `closeDb(env)` only ever finds (and closes) a connection that is actually cached; closing a WAL
// write connection believed to be the last one deletes the `-shm` file (verified empirically: opening it
// leaves `-shm` behind but a readonly connection's own `.close()` never removes it). So: if the follow
// session left a write connection cached, a `closeDb(env)` call right after it ends will make `-shm`
// disappear; if it never opened one (the pre-refactor behaviour), `closeDb(env)` is a no-op and `-shm`
// (created by the per-poll readonly read itself) stays exactly where the reader put it.
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
  assert.equal(existsSync(dbShmPath(env)), false, "test setup itself left a write connection cached; the probe below would be meaningless");

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

  // The follow session itself must have read the job's status at least once (one poll, since the job was
  // already terminal): that per-poll readonly read is what creates `-shm` in the correct, pre-refactor
  // design, and its own `.close()` never removes it - so `-shm` existing here is expected either way.
  assert.equal(existsSync(dbShmPath(env)), true, "the follow session never read the job's status at all; this PoC's own precondition failed");

  // The real assertion: closing whatever this process's write-connection cache holds for this home must be
  // a no-op, because the follow session must never have opened (and cached) a write connection at all.
  closeDb(env);
  assert.equal(existsSync(dbShmPath(env)), true, "closeDb(env) removed the shared-memory file right after the follow ended: a long-lived WRITE connection was left cached for the whole session, where the pre-refactor per-poll reader (openDbReadOnly, closed every tick) never held one");
});

// The same probe, applied to `queue status --follow`: a session with nothing to merge (the job has no pull
// request) and nothing to repair (there is no state.json) must never open a write connection at all, so
// `closeDb(env)` right after it ends is a no-op and the `-shm` its read-only polls created stays on disk.
test("a queue status --follow session with nothing to merge and nothing to repair never opens a cached write connection", async (t) => {
  const env = makeHome(t, "follow-status-no-write-connection");
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: "host:1", cap: 4 }, env);
  finishJob(id, { worker: "host:1", status: "done" }, env);

  closeDb(env);
  assert.equal(existsSync(dbShmPath(env)), false, "test setup itself left a write connection cached; the probe below would be meaningless");

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

  assert.equal(existsSync(dbShmPath(env)), true, "the follow session never read the database at all; this PoC's own precondition failed");
  closeDb(env);
  assert.equal(existsSync(dbShmPath(env)), true, "closeDb(env) removed the shared-memory file right after the follow ended: the session left a cached WRITE connection behind although it had nothing to merge and nothing to repair");
});
