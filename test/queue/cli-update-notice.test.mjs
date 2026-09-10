import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { runtimePackageDir } from "../../src/config/paths.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const NOTICE = "nightshift 0.4.0 is available (installed 0.1.0) - run `nightshift update`";

// A fetch double that records every call and answers the registry with a newer version.
function fakeFetch(calls, latest = "0.4.0") {
  return async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ latest }) };
  };
}

// A queue home whose update check is on, with a runtime that declares the installed version.
function makeNoticeHome(t, name) {
  const env = makeHome(t, name);
  delete env.NIGHTSHIFT_NO_UPDATE_CHECK;
  makeProject(t, env, "alpha");
  const dir = runtimePackageDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "@maykonv/nightshift", version: "0.1.0" }, null, 2)}\n`);
  return env;
}

// Runs the CLI in this process, with the fetch of the test injected and nothing else reachable.
async function runCli(env, argv, calls) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    fetchImpl: fakeFetch(calls),
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(argv, ctx);
  return { code, out, err };
}

test("queue status closes its text output with the update notice, once per invocation", async (t) => {
  const env = makeNoticeHome(t, "notice-status");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  const table = await runCli(env, ["queue", "status"], calls);
  assert.equal(table.code, 0, table.err.join("\n"));
  assert.equal(table.out.at(-1), NOTICE);
  assert.equal(table.out.filter((line) => line === NOTICE).length, 1);
  assert.equal(calls.length, 1);

  const detail = await runCli(env, ["queue", "status", String(id)], calls);
  assert.equal(detail.out.at(-1), NOTICE, detail.out.join("\n"));
  assert.equal(calls.length, 1, "the cached check asked the registry a second time");

  const empty = await runCli(makeNoticeHome(t, "notice-status-empty"), ["queue", "status"], calls);
  assert.deepEqual(empty.out, ["runner: stopped", "no jobs in the queue", NOTICE]);
});

test("queue status --json never carries the notice, on any of its branches", async (t) => {
  const env = makeNoticeHome(t, "notice-status-json");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  const calls = [];

  for (const argv of [["queue", "status", "--json"], ["queue", "status", String(id), "--json"]]) {
    const result = await runCli(env, argv, calls);
    assert.equal(result.code, 0, result.err.join("\n"));
    assert.equal(result.out.length, 1, result.out.join("\n"));
    assert.equal(result.out.join("\n").includes("is available"), false);
    assert.doesNotThrow(() => JSON.parse(result.out[0]));
  }
  assert.deepEqual(calls, [], "the json output asked the registry");

  const emptyJson = await runCli(makeNoticeHome(t, "notice-status-json-empty"), ["queue", "status", "--json"], calls);
  assert.equal(emptyJson.out.length, 1);
  assert.deepEqual(calls, []);
});

test("a home with the check off, or a session inside a job, gets the plain output back", async (t) => {
  const env = makeNoticeHome(t, "notice-status-off");
  addJob({ project: "alpha", prompt: "fix the worker" }, env);
  const calls = [];

  const off = await runCli({ ...env, NIGHTSHIFT_NO_UPDATE_CHECK: "1" }, ["queue", "status"], calls);
  assert.equal(off.out.join("\n").includes("is available"), false, off.out.join("\n"));

  const inJob = await runCli({ ...env, NIGHTSHIFT_JOB_ID: "7" }, ["queue", "status"], calls);
  assert.equal(inJob.out.join("\n").includes("is available"), false, inJob.out.join("\n"));
  assert.deepEqual(calls, [], "a silenced notice still reached the registry");
});
