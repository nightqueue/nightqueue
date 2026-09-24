import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runtimePackageDir, updateCheckPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { updateNoticeLine } from "../../src/host/update-notice.mjs";
import { runSessionStart } from "../../src/hooks/session-start.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

// A home whose update check is on, with a runtime that declares the given installed version.
function makeNoticeHome(t, name, installed = "0.1.0") {
  const env = makeHome(t, name);
  delete env.NIGHTQUEUE_NO_UPDATE_CHECK;
  const dir = runtimePackageDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "nightqueue", version: installed }, null, 2)}\n`);
  return env;
}

// Stores a check answered a moment ago, so the notice needs no network at all.
function cachePublished(env, latest) {
  ensureHome(env);
  writeFileSync(updateCheckPath(env), `${JSON.stringify({ checkedAt: new Date(NOW).toISOString(), latest }, null, 2)}\n`);
  return env;
}

// A fetch double that records every call and answers with the given version.
function fakeFetch(calls, latest) {
  return async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ latest }) };
  };
}

test("the notice names the published version and the installed one, in the fixed wording", async (t) => {
  const env = cachePublished(makeNoticeHome(t, "notice-newer"), "0.4.0");
  assert.equal(
    await updateNoticeLine({ env, now: () => NOW }),
    "nightqueue 0.4.0 is available (installed 0.1.0) - run `nightqueue update`",
  );
});

test("nothing is said when the published version is not above the installed one", async (t) => {
  const same = cachePublished(makeNoticeHome(t, "notice-same"), "0.1.0");
  assert.equal(await updateNoticeLine({ env: same, now: () => NOW }), null);

  const older = cachePublished(makeNoticeHome(t, "notice-older"), "0.0.9");
  assert.equal(await updateNoticeLine({ env: older, now: () => NOW }), null, "a dist-tag rolled back announced an update");

  const garbage = cachePublished(makeNoticeHome(t, "notice-garbage"), "next");
  assert.equal(await updateNoticeLine({ env: garbage, now: () => NOW }), null);

  const noRuntime = cachePublished(makeHome(t, "notice-no-runtime"), "0.4.0");
  delete noRuntime.NIGHTQUEUE_NO_UPDATE_CHECK;
  assert.equal(await updateNoticeLine({ env: noRuntime, now: () => NOW }), null, "a home with no runtime got a notice");
});

test("an unattended job never reads the notice and never asks the registry", async (t) => {
  const env = { ...cachePublished(makeNoticeHome(t, "notice-in-job"), "0.4.0"), NIGHTQUEUE_JOB_ID: "7" };
  const calls = [];
  assert.equal(await updateNoticeLine({ env, fetchImpl: fakeFetch(calls, "0.4.0"), now: () => NOW }), null);
  assert.deepEqual(calls, []);
});

test("the opt-out silences the notice, whatever the cache holds", async (t) => {
  const env = { ...cachePublished(makeNoticeHome(t, "notice-off"), "0.4.0"), NIGHTQUEUE_NO_UPDATE_CHECK: "1" };
  const calls = [];
  assert.equal(await updateNoticeLine({ env, fetchImpl: fakeFetch(calls, "0.4.0"), now: () => NOW }), null);
  assert.deepEqual(calls, []);
});

test("the session block ends with the notice, and with nothing new when the check is off", async (t) => {
  const env = makeNoticeHome(t, "notice-session");
  const repo = makeProject(t, env, "alpha");
  saveLesson(
    { project: "alpha", title: "the worker leaks a file descriptor", root_cause: "it throws", solution: "fix it", prevention: "close it in a finally block" },
    env,
  );
  const calls = [];
  const input = { session_id: "s1", cwd: repo };

  const block = await runSessionStart({ input, env, fetchImpl: fakeFetch(calls, "0.4.0") });
  assert.equal(calls.length, 1, "the hook was not wired to the injected fetch");
  assert.equal(block.endsWith("\nnightqueue 0.4.0 is available (installed 0.1.0) - run `nightqueue update`"), true, block);

  const quiet = await runSessionStart({ input, env: { ...env, NIGHTQUEUE_NO_UPDATE_CHECK: "1" }, fetchImpl: fakeFetch(calls, "0.4.0") });
  assert.equal(quiet.includes("is available"), false, quiet);
  assert.equal(calls.length, 1, "the opt-out still reached the registry");
});
