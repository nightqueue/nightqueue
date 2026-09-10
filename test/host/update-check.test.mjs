import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { updateCheckPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { latestVersion, UPDATE_CHECK_TTL_MS } from "../../src/host/update-check.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");

// A home whose update check is switched on, unlike every other test of the suite.
function makeCheckHome(t, name) {
  const env = makeHome(t, name);
  delete env.NIGHTSHIFT_NO_UPDATE_CHECK;
  return env;
}

// A fetch double that records every call and answers with the given version, never touching the network.
function fakeFetch(calls, latest) {
  return async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ latest }) };
  };
}

// Writes the cache file of the update check with the given stamp and version.
function writeCache(env, { checkedAt, latest }) {
  ensureHome(env);
  writeFileSync(updateCheckPath(env), `${JSON.stringify({ checkedAt, latest }, null, 2)}\n`);
  return updateCheckPath(env);
}

// Parsed content of the cache file, or null when nothing was written.
function readCache(env) {
  const path = updateCheckPath(env);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

test("a cache checked less than a day ago answers alone, without one single request", async (t) => {
  const env = makeCheckHome(t, "update-check-fresh");
  writeCache(env, { checkedAt: new Date(NOW - 1000).toISOString(), latest: "0.3.0" });
  const calls = [];

  assert.equal(await latestVersion({ env, fetchImpl: fakeFetch(calls, "9.9.9"), now: () => NOW }), "0.3.0");
  assert.deepEqual(calls, [], "a fresh cache reached the registry");
  assert.equal(readCache(env).checkedAt, new Date(NOW - 1000).toISOString(), "a fresh cache was rewritten");
});

test("a stale or missing cache asks the registry exactly once and stores the answer", async (t) => {
  const env = makeCheckHome(t, "update-check-stale");
  writeCache(env, { checkedAt: new Date(NOW - UPDATE_CHECK_TTL_MS - 1000).toISOString(), latest: "0.1.0" });
  const calls = [];

  assert.equal(await latestVersion({ env, fetchImpl: fakeFetch(calls, "0.4.0"), now: () => NOW }), "0.4.0");
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/registry\.npmjs\.org\/-\/package\/.+\/dist-tags$/);
  assert.deepEqual(readCache(env), { checkedAt: new Date(NOW).toISOString(), latest: "0.4.0" });

  const fresh = makeCheckHome(t, "update-check-missing");
  const first = [];
  assert.equal(await latestVersion({ env: fresh, fetchImpl: fakeFetch(first, "0.4.0"), now: () => NOW }), "0.4.0");
  assert.equal(first.length, 1, "a missing cache did not ask the registry");
  assert.deepEqual(readCache(fresh), { checkedAt: new Date(NOW).toISOString(), latest: "0.4.0" });
});

test("a stamp in the future is stale, so a wrong clock costs a request instead of freezing the cache", async (t) => {
  const env = makeCheckHome(t, "update-check-future");
  writeCache(env, { checkedAt: new Date(NOW + UPDATE_CHECK_TTL_MS).toISOString(), latest: "0.1.0" });
  const calls = [];

  assert.equal(await latestVersion({ env, fetchImpl: fakeFetch(calls, "0.4.0"), now: () => NOW }), "0.4.0");
  assert.equal(calls.length, 1);
});

test("a registry that fails keeps the cached version, stamps the attempt and throws nothing", async (t) => {
  const failures = [
    async () => {
      throw new Error("network is unreachable");
    },
    async () => ({ ok: false, status: 503, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => ({ latest: 42 }) }),
    async () => ({ ok: true, json: async () => "not an object" }),
  ];
  for (const [index, fetchImpl] of failures.entries()) {
    const env = makeCheckHome(t, `update-check-fail-${index}`);
    writeCache(env, { checkedAt: new Date(NOW - UPDATE_CHECK_TTL_MS - 1000).toISOString(), latest: "0.3.0" });

    assert.equal(await latestVersion({ env, fetchImpl, now: () => NOW }), "0.3.0", `failure ${index}`);
    assert.deepEqual(readCache(env), { checkedAt: new Date(NOW).toISOString(), latest: "0.3.0" }, `failure ${index}`);
  }
});

test("a registry that never answers is abandoned at the timeout, with the cached version surviving", async (t) => {
  const env = makeCheckHome(t, "update-check-timeout");
  writeCache(env, { checkedAt: new Date(NOW - UPDATE_CHECK_TTL_MS - 1000).toISOString(), latest: "0.3.0" });
  const silent = (url, options) =>
    new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
    });

  assert.equal(await latestVersion({ env, fetchImpl: silent, now: () => NOW }), "0.3.0");
  assert.equal(readCache(env).latest, "0.3.0");
});

test("a home with no cache and a registry that fails answers null and never throws", async (t) => {
  const env = makeCheckHome(t, "update-check-empty-fail");
  const fetchImpl = async () => {
    throw new Error("network is unreachable");
  };

  assert.equal(await latestVersion({ env, fetchImpl, now: () => NOW }), null);
  assert.deepEqual(readCache(env), { checkedAt: new Date(NOW).toISOString(), latest: null });
});

test("NIGHTSHIFT_NO_UPDATE_CHECK=1 reads nothing, asks nothing and writes nothing", async (t) => {
  const env = makeCheckHome(t, "update-check-off");
  writeCache(env, { checkedAt: new Date(NOW - UPDATE_CHECK_TTL_MS - 1000).toISOString(), latest: "0.3.0" });
  const calls = [];

  const off = { ...env, NIGHTSHIFT_NO_UPDATE_CHECK: "1" };
  assert.equal(await latestVersion({ env: off, fetchImpl: fakeFetch(calls, "0.4.0"), now: () => NOW }), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(readCache(env), { checkedAt: new Date(NOW - UPDATE_CHECK_TTL_MS - 1000).toISOString(), latest: "0.3.0" });
});

test("without a fetch implementation the check never opens a socket: it answers the cache and stops", async (t) => {
  const env = makeCheckHome(t, "update-check-unwired");
  const stamp = new Date(NOW - UPDATE_CHECK_TTL_MS - 1000).toISOString();
  writeCache(env, { checkedAt: stamp, latest: "0.3.0" });

  assert.equal(await latestVersion({ env, now: () => NOW }), "0.3.0");
  assert.deepEqual(readCache(env), { checkedAt: stamp, latest: "0.3.0" }, "an unwired check rewrote the cache");
  assert.equal(await latestVersion({ env: makeCheckHome(t, "update-check-unwired-empty"), now: () => NOW }), null);
});

test("a cache file that is broken, or a home that cannot be written, costs no error", async (t) => {
  const env = makeCheckHome(t, "update-check-broken");
  ensureHome(env);
  writeFileSync(updateCheckPath(env), "{ not json");
  const calls = [];

  assert.equal(await latestVersion({ env, fetchImpl: fakeFetch(calls, "0.4.0"), now: () => NOW }), "0.4.0");
  assert.equal(calls.length, 1, "a broken cache was treated as fresh");

  const unwritable = { ...makeCheckHome(t, "update-check-unwritable"), NIGHTSHIFT_HOME: "/dev/null/home" };
  assert.equal(await latestVersion({ env: unwritable, fetchImpl: fakeFetch(calls, "0.4.0"), now: () => NOW }), "0.4.0");
});
