// Group H (QA prover): guards the hermeticity wiring the whole suite relies on, so a future
// edit to either home helper or to `latestVersion` cannot silently reopen a real network/host
// access. See 05a-qa-analyst.md (H1, H2): today's ad hoc test-spawn helpers never reach the
// vulnerable path (their args never touch updateNoticeLine), so this file proves the seam
// holds rather than reproducing a currently-nonexistent crash.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { updateCheckPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { latestVersion } from "../../src/host/update-check.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { isolatedHostVars, makeHostEnv } from "../../test-support/host.mjs";

test("makeHome bakes NIGHTQUEUE_NO_UPDATE_CHECK=1 into the env it hands out", (t) => {
  const env = makeHome(t, "hermeticity-make-home");
  assert.equal(env.NIGHTQUEUE_NO_UPDATE_CHECK, "1");
});

test("makeHostEnv bakes NIGHTQUEUE_NO_UPDATE_CHECK=1 into the env it hands out", (t) => {
  const host = makeHostEnv(t, "hermeticity-make-host-env");
  assert.equal(host.env.NIGHTQUEUE_NO_UPDATE_CHECK, "1");
});

test("isolatedHostVars bakes NIGHTQUEUE_NO_UPDATE_CHECK=1 into the vars it hands out", (t) => {
  const dir = makeDir(t, "hermeticity-isolated-host-vars");
  const vars = isolatedHostVars(dir);
  assert.equal(vars.NIGHTQUEUE_NO_UPDATE_CHECK, "1");
});

test("latestVersion with no fetchImpl never touches global fetch, even on a stale or missing cache", async (t) => {
  const env = makeHome(t, "hermeticity-no-fetch-impl");
  delete env.NIGHTQUEUE_NO_UPDATE_CHECK;
  assert.equal(existsSync(updateCheckPath(env)), false, "precondition: no cache file exists yet");

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = () => {
    calls += 1;
    throw new Error("HERMETICITY BREACH: latestVersion dialed global fetch with no fetchImpl");
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let result;
  await assert.doesNotReject(async () => {
    result = await latestVersion({ env });
  });
  assert.equal(result, null, "an absent cache with no fetchImpl answers null");
  assert.equal(calls, 0, "global fetch must never be called when no fetchImpl is threaded in");
});

test("NIGHTQUEUE_NO_UPDATE_CHECK=1 neither reads nor writes the cache file, nor calls a fetchImpl it is given", async (t) => {
  const env = makeHome(t, "hermeticity-opt-out");
  const cachePath = updateCheckPath(env);
  ensureHome(env);
  const cachedBody = `${JSON.stringify({ checkedAt: new Date(0).toISOString(), latest: "9.9.9" }, null, 2)}\n`;
  writeFileSync(cachePath, cachedBody);

  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok: true, json: async () => ({ latest: "9.9.9" }) };
  };

  const result = await latestVersion({ env, fetchImpl });

  assert.equal(result, null, "the opt-out must answer null directly, never the value the cache holds");
  assert.deepEqual(calls, [], "the opt-out must never call a fetchImpl it was given");
  assert.equal(readFileSync(cachePath, "utf8"), cachedBody, "the opt-out must leave the cache file byte-for-byte untouched");
});
