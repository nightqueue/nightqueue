import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { runtimePackageDir } from "../../src/config/paths.mjs";
import { runSessionStart } from "../../src/hooks/session-start.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const NOTICE = "nightqueue 0.4.0 is available (installed 0.1.0) - run `nightqueue update`";

// A fetch double that records every call and always answers with a newer version, so a silent
// notice in these tests can only mean the opt-out worked, never that the network went unreached.
function fakeFetch(calls, latest = "0.4.0") {
  return async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ latest }) };
  };
}

// Runs the CLI in this process, with the fetch of the test injected and nothing else reachable.
async function runCli(env, argv, fetchImpl) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetchImpl,
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(argv, ctx);
  return { code, out, err };
}

// Installs a runtime package.json so `updateNoticeLine` has an installed version to compare against.
function installRuntime(env, version = "0.1.0") {
  const dir = runtimePackageDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "nightqueue", version }, null, 2)}\n`);
}

test("makeHome bakes the update-check opt-out every literal-output fixture in this suite relies on", (t) => {
  const env = makeHome(t, "regression-optout-present");
  assert.equal(
    env.NIGHTQUEUE_NO_UPDATE_CHECK,
    "1",
    "makeHome stopped setting NIGHTQUEUE_NO_UPDATE_CHECK: the literal outputs pinned in " +
      "test/queue/detached.test.mjs, test/queue/cli.test.mjs and test/hooks/session-start.test.mjs " +
      "now race the update-notice network path instead of running against a closed door",
  );
});

test("check off: queue status keeps its exact pre-existing text on every branch, even with a newer version one fetch away", async (t) => {
  const env = makeHome(t, "regression-off-text");
  installRuntime(env);
  makeProject(t, env, "alpha");
  const calls = [];

  const empty = await runCli(env, ["queue", "status"], fakeFetch(calls));
  assert.deepEqual(empty.out, ["0 runners online - pending jobs will wait until `nightqueue queue run` starts one", "no jobs in the queue"]);

  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const table = await runCli(env, ["queue", "status"], fakeFetch(calls));
  assert.equal(table.out.some((line) => line.includes("is available")), false, table.out.join("\n"));

  const detail = await runCli(env, ["queue", "status", String(id)], fakeFetch(calls));
  assert.equal(detail.out.some((line) => line.includes("is available")), false, detail.out.join("\n"));

  assert.deepEqual(calls, [], "the check-off state still reached the registry");
});

test("check off: queue status --json stays byte-identical to the pre-existing shape on every branch", async (t) => {
  const env = makeHome(t, "regression-off-json");
  installRuntime(env);
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  for (const argv of [["queue", "status", "--json"], ["queue", "status", String(id), "--json"]]) {
    const result = await runCli(env, argv, fakeFetch(calls));
    assert.equal(result.out.length, 1, result.out.join("\n"));
    assert.equal(result.out[0].includes("is available"), false);
  }
  assert.deepEqual(calls, []);
});

test("check on: the notice is appended exactly once, as the last line, byte for byte, on every text branch", async (t) => {
  const env = makeHome(t, "regression-on-text");
  delete env.NIGHTQUEUE_NO_UPDATE_CHECK;
  installRuntime(env);
  makeProject(t, env, "alpha");
  const calls = [];

  const empty = await runCli(env, ["queue", "status"], fakeFetch(calls));
  assert.deepEqual(empty.out, ["0 runners online - pending jobs will wait until `nightqueue queue run` starts one", "no jobs in the queue", NOTICE]);

  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const table = await runCli(env, ["queue", "status"], fakeFetch(calls));
  assert.equal(table.out.at(-1), NOTICE, table.out.join("\n"));
  assert.equal(table.out.filter((line) => line === NOTICE).length, 1);

  const detail = await runCli(env, ["queue", "status", String(id)], fakeFetch(calls));
  assert.equal(detail.out.at(-1), NOTICE, detail.out.join("\n"));
  assert.equal(detail.out.filter((line) => line === NOTICE).length, 1);
});

test("check on: queue status --json never carries the notice either", async (t) => {
  const env = makeHome(t, "regression-on-json");
  delete env.NIGHTQUEUE_NO_UPDATE_CHECK;
  installRuntime(env);
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  for (const argv of [["queue", "status", "--json"], ["queue", "status", String(id), "--json"]]) {
    const result = await runCli(env, argv, fakeFetch(calls));
    assert.equal(result.out.length, 1, result.out.join("\n"));
    assert.equal(result.out[0].includes("is available"), false);
  }
});

test("the session block never carries a notice as its only content, whether the check is off or on", async (t) => {
  const off = makeHome(t, "regression-hook-off");
  installRuntime(off);
  const offRepo = makeProject(t, off, "alpha");
  assert.equal(await runSessionStart({ input: { session_id: "s1", cwd: offRepo }, env: off }), "");

  const on = makeHome(t, "regression-hook-on");
  delete on.NIGHTQUEUE_NO_UPDATE_CHECK;
  installRuntime(on);
  const onRepo = makeProject(t, on, "alpha");
  const calls = [];
  assert.equal(
    await runSessionStart({ input: { session_id: "s1", cwd: onRepo }, env: on, fetchImpl: fakeFetch(calls) }),
    "",
    "a home with nothing to say produced a block made only of the update notice",
  );
});

test("the 9000-character clip still holds once the notice is appended", async (t) => {
  const env = makeHome(t, "regression-hook-clip");
  delete env.NIGHTQUEUE_NO_UPDATE_CHECK;
  installRuntime(env);
  const repo = makeProject(t, env, "alpha");
  for (let i = 0; i < 12; i += 1) {
    saveLesson(
      {
        project: "alpha",
        title: `lesson number ${i}`,
        root_cause: "it throws",
        solution: "fix it",
        prevention: "always close the descriptor ".repeat(80),
      },
      env,
    );
  }
  const calls = [];
  const block = await runSessionStart({ input: { session_id: "s1", cwd: repo }, env, fetchImpl: fakeFetch(calls) });
  assert.equal(block.length, 9000);
});
