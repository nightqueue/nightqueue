import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { secretsPath } from "../../src/config/paths.mjs";
import { loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { connectLinear } from "../../src/studio/connect.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const API_KEY = "lin_api_studio_secret_0123456789";

// A fake Linear fetch counting its calls: a viewer answer, an HTTP refusal, or a throw whose message carries the key.
function fakeLinear({ status = 200, viewer = "Ana", throws = false } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, auth: options.headers?.Authorization ?? null });
    if (throws) throw new Error(`boom ${API_KEY}`);
    return { status, headers: new Map(), json: async () => ({ data: { viewer: { id: "u1", name: viewer } } }) };
  };
  return { impl, calls };
}

// The error a connect attempt rejects with, asserting it never carries the key.
async function refusal(args) {
  const err = await connectLinear(args).then(
    () => assert.fail("the connect was accepted"),
    (caught) => caught,
  );
  assert.ok(!String(err?.message).includes(API_KEY), `the key leaked into: ${err?.message}`);
  assert.ok(!String(err?.stack).includes(API_KEY), "the key leaked into the stack");
  return err;
}

test("a key Linear accepts is stored home-wide under `linear`, and the answer names the viewer, never the key", async (t) => {
  const env = makeHome(t, "connect-ok");
  const fetch = fakeLinear();
  const answer = await connectLinear({ body: { api_key: `  ${API_KEY}\n` }, env, fetchImpl: fetch.impl });
  assert.deepEqual(answer, { connected: true, name: "linear", type: "linear", viewer: "Ana" });
  assert.ok(!JSON.stringify(answer).includes(API_KEY));
  assert.deepEqual(fetch.calls.map((call) => call.auth), [API_KEY]);
  assert.deepEqual(loadSecrets(env).connections.linear, { type: "linear", apiKey: API_KEY });
});

test("a key Linear refuses, or a network failure, writes nothing and answers a message without the key", async (t) => {
  for (const [name, fake] of [["refused", fakeLinear({ status: 401 })], ["throws", fakeLinear({ throws: true })]]) {
    const env = makeHome(t, `connect-${name}`);
    const err = await refusal({ body: { api_key: API_KEY }, env, fetchImpl: fake.impl });
    assert.match(err.message, /^Linear refused the key \(.+\); nothing was saved$/);
    assert.equal(existsSync(secretsPath(env)), false, `${name} wrote the secrets file`);
  }
});

test("an existing secrets file stays byte-identical when the key is refused", async (t) => {
  const env = makeHome(t, "connect-identical");
  saveSecrets({ version: 1, connections: { gh: { type: "github", token: "ghp_x" } } }, env);
  const before = readFileSync(secretsPath(env));
  await refusal({ body: { api_key: API_KEY }, env, fetchImpl: fakeLinear({ status: 403 }).impl });
  assert.deepEqual(readFileSync(secretsPath(env)), before);
});

test("inside a job the connect is refused before Linear is ever asked", async (t) => {
  const home = makeHome(t, "connect-job");
  const env = { ...home, NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_JOB_HOME: home.NIGHTQUEUE_HOME };
  const fetch = fakeLinear();
  const err = await refusal({ body: { api_key: API_KEY }, env, fetchImpl: fetch.impl });
  assert.match(err.message, /^refused: /);
  assert.equal(fetch.calls.length, 0);
  assert.equal(existsSync(secretsPath(home)), false);
});

test("a missing, empty, oversized or non-string key is refused before Linear is asked", async (t) => {
  const env = makeHome(t, "connect-shape");
  const fetch = fakeLinear();
  for (const body of [{}, { api_key: "" }, { api_key: "   " }, { api_key: 42 }, { api_key: [API_KEY] }, { api_key: "k".repeat(513) }]) {
    const err = await refusal({ body, env, fetchImpl: fetch.impl });
    assert.match(err.message, /`api_key` expects a non-empty string/);
  }
  assert.equal(fetch.calls.length, 0);
});

test("a home that already has a Linear connection refuses a second one without asking Linear", async (t) => {
  const env = makeHome(t, "connect-twice");
  saveSecrets({ version: 1, connections: { work: { type: "linear", apiKey: "lin_api_old" } } }, env);
  const fetch = fakeLinear();
  const err = await refusal({ body: { api_key: API_KEY }, env, fetchImpl: fetch.impl });
  assert.match(err.message, /one `linear` connection: `work`/);
  assert.equal(fetch.calls.length, 0);
});

test("a save that fails after a valid test never carries the key in its error", { skip: process.getuid?.() === 0 }, async (t) => {
  const env = makeHome(t, "connect-readonly");
  mkdirSync(env.NIGHTQUEUE_HOME, { recursive: true });
  chmodSync(env.NIGHTQUEUE_HOME, 0o500);
  t.after(() => chmodSync(env.NIGHTQUEUE_HOME, 0o700));
  await refusal({ body: { api_key: API_KEY }, env, fetchImpl: fakeLinear().impl });
  assert.equal(existsSync(secretsPath(env)), false);
});
