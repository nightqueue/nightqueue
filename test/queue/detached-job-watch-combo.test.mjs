import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// A spawn double: it records every call and answers with a child that has a pid and can be unreferenced.
function fakeSpawn(calls, { pid = 4242 } = {}) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return { pid, unref: () => calls.push({ unref: true }) };
  };
}

// A kill double: nothing is alive, so a stale pidfile of a previous run never blocks the command under test.
function fakeKill() {
  return (pid) => {
    const err = new Error(`kill ESRCH ${pid}`);
    err.code = "ESRCH";
    throw err;
  };
}

// A home with one registered project and one pending job, in-process so nothing real ever spawns.
function makeQueueHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

// Runs the CLI in this process, with the spawn and the kill of the test injected; never a real child, never a real signal.
async function runCli(env, argv, { calls = [] } = {}) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    spawnImpl: fakeSpawn(calls),
    killImpl: fakeKill(),
  };
  const code = await run(argv, ctx);
  return { code, out, err, stdout: out.join("\n"), stderr: err.join("\n"), calls };
}

test("`queue run --job <id> --watch <n>` is refused, the same way `--stop` next to another option is refused", async (t) => {
  const env = makeQueueHome(t, "job-watch-refused");
  const job = addJob({ project: "alpha", prompt: "fix it" }, env);
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--job", String(job.id), "--watch", "1"], { calls });

  assert.equal(result.code, 1, `expected the combo to be refused, got exit ${result.code}: ${result.stdout}`);
  assert.match(result.stderr, /--job.*--watch|--watch.*--job/, "expected a UserError naming the conflicting options");
  assert.equal(result.stdout, "", "a refused command must print nothing on stdout");
  assert.equal(calls.length, 0, "a refused command must never spawn the detached runner");
});

test("the same combo is refused on the foreground branch, so the watch loop is never entered scoped to one job", async (t) => {
  const env = makeQueueHome(t, "job-watch-refused-foreground");
  const job = addJob({ project: "alpha", prompt: "fix it" }, env);
  const calls = [];

  const result = await runCli(env, ["queue", "run", "--job", String(job.id), "--watch", "1", "--foreground"], { calls });

  assert.equal(result.code, 1, `expected the combo to be refused, got exit ${result.code}: ${result.stdout}`);
  assert.match(result.stderr, /--job.*--watch|--watch.*--job/, "expected a UserError naming the conflicting options");
  assert.equal(calls.length, 0, "a refused command must never spawn anything");
});
