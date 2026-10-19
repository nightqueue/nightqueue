import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { connectionCall } from "../../src/integrations/connection-call.mjs";
import { requestJson } from "../../src/integrations/http.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const SENTRY_TOKEN = "sntrys_secret_token_0123456789";
const LINEAR_KEY = "lin_api_secret_0123456789";
const WEBHOOK_TOKEN = "hookTokenSecret_abcdefghij-0123";
const WEBHOOK_URL = `https://discord.com/api/webhooks/123456789012345678/${WEBHOOK_TOKEN}`;
const REFUSAL = "refused: `connection_call` POST inside J-7: a call that is not a GET is the operator's call, made only outside a queue run after the person's explicit ok; a run may only GET. Nothing was sent";

// A home holding one connection of each callable kind, with any extra records given.
function callHome(t, name, extra = {}) {
  const env = makeHome(t, name);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.sn = { type: "sentry", token: SENTRY_TOKEN, org: "acme", ...extra.sentry };
  secrets.connections.linear = { type: "linear", apiKey: LINEAR_KEY };
  secrets.connections["team-chat"] = { type: "discord", url: WEBHOOK_URL };
  Object.assign(secrets.connections, extra.records ?? {});
  saveSecrets(secrets, env);
  return env;
}

// A fake fetch answering one fixed response and recording each call it served.
function fakeFetch({ status = 200, text = "{}", json = null, throws = false } = {}) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push({ url, options });
    if (throws) throw new Error(`boom ${url}`);
    return { status, headers: new Map(), text: async () => text, json: async () => json ?? JSON.parse(text) };
  };
  return { impl, calls };
}

// Calls the tool's runtime side with a fake fetch.
function call(env, args, fetch) {
  return connectionCall(args, { env, fetchImpl: fetch.impl });
}

test("a sentry call goes to the api root with the bearer token, a GET with no redirect followed", async (t) => {
  const env = callHome(t, "cc-sentry");
  const fetch = fakeFetch({ text: '{"id":"1"}' });
  const answer = await call(env, { connection: "sn", path: "organizations/acme/issues/", query: { query: "is:unresolved" } }, fetch);
  assert.deepEqual(answer, { ok: true, status: 200, body: { id: "1" } });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, "https://sentry.io/api/0/organizations/acme/issues/?query=is%3Aunresolved");
  assert.equal(fetch.calls[0].options.headers.Authorization, `Bearer ${SENTRY_TOKEN}`);
  assert.equal(fetch.calls[0].options.method, "GET");
  assert.equal(fetch.calls[0].options.redirect, "manual");
});

test("a sentry connection with a stored url is called on that host", async (t) => {
  const env = callHome(t, "cc-sentry-host", { sentry: { url: "https://sentry.example.com" } });
  const fetch = fakeFetch();
  await call(env, { connection: "sn", path: "/organizations/acme/" }, fetch);
  assert.equal(fetch.calls[0].url, "https://sentry.example.com/api/0/organizations/acme/");
});

test("a linear call posts the graphql body with the raw key and takes no path", async (t) => {
  const env = callHome(t, "cc-linear");
  const fetch = fakeFetch({ text: '{"data":{"viewer":{"id":"u1"}}}' });
  const body = { query: "query { viewer { id } }" };
  const answer = await call(env, { connection: "linear", method: "POST", body }, fetch);
  assert.deepEqual(answer, { ok: true, status: 200, body: { data: { viewer: { id: "u1" } } } });
  assert.equal(fetch.calls[0].url, "https://api.linear.app/graphql");
  assert.equal(fetch.calls[0].options.headers.Authorization, LINEAR_KEY);
  assert.equal(fetch.calls[0].options.method, "POST");
  assert.equal(fetch.calls[0].options.body, JSON.stringify(body));
  const withPath = fakeFetch();
  assert.equal((await call(env, { connection: "linear", method: "POST", path: "x", body }, withPath)).error, "invalid-input");
  assert.equal(withPath.calls.length, 0);
});

test("a discord call goes to the webhook url with only its allowed query and no authorization", async (t) => {
  const env = callHome(t, "cc-discord");
  const fetch = fakeFetch({ text: '{"id":"9"}' });
  await call(env, { connection: "team-chat", method: "POST", query: { wait: "true", thread_id: "123" }, body: { content: "hi" } }, fetch);
  assert.equal(fetch.calls[0].url, `${WEBHOOK_URL}?wait=true&thread_id=123`);
  assert.equal(fetch.calls[0].options.headers.Authorization, undefined);
  const other = fakeFetch();
  const refused = await call(env, { connection: "team-chat", method: "POST", query: { foo: "1" }, body: { content: "hi" } }, other);
  assert.deepEqual(refused, { ok: false, error: "invalid-input", status: null, detail: "query takes only thread_id, wait" });
  assert.equal(other.calls.length, 0);
});

test("a discord call reads and edits a posted message, and nothing else widens", async (t) => {
  const env = callHome(t, "cc-discord-message");
  const read = fakeFetch({ text: '{"id":"42"}' });
  assert.equal((await call(env, { connection: "team-chat", path: "messages/42" }, read)).ok, true);
  assert.equal(read.calls[0].url, `${WEBHOOK_URL}/messages/42`);
  const edit = fakeFetch({ text: '{"id":"42"}' });
  await call(env, { connection: "team-chat", method: "PATCH", path: "/messages/42", body: { content: "fixed" } }, edit);
  assert.equal(edit.calls[0].url, `${WEBHOOK_URL}/messages/42`);
  assert.equal(edit.calls[0].options.method, "PATCH");
  const refusals = [
    { path: "messages" },
    { path: "messages/abc" },
    { path: "messages/42/x" },
    { path: "other/42" },
    { path: "messages/42", method: "POST" },
    { path: "", method: "PATCH" },
    { method: "PUT" },
  ];
  for (const args of refusals) {
    const other = fakeFetch();
    const answer = await call(env, { connection: "team-chat", body: { content: "x" }, ...args }, other);
    assert.equal(answer.error, "invalid-input", JSON.stringify(args));
    assert.equal(other.calls.length, 0, JSON.stringify(args));
    assert.ok(!JSON.stringify(answer).includes(WEBHOOK_TOKEN));
  }
});

test("a webhook message path keeps thread_id, refuses traversal and @original, and a bare GET hits the exact url", async (t) => {
  const env = callHome(t, "cc-discord-gaps");
  for (const method of ["GET", "PATCH"]) {
    const sent = fakeFetch({ text: '{"id":"42"}' });
    await call(env, { connection: "team-chat", method, path: "messages/42", query: { thread_id: "7" }, ...(method === "PATCH" ? { body: { content: "x" } } : {}) }, sent);
    assert.equal(sent.calls[0].url, `${WEBHOOK_URL}/messages/42?thread_id=7`, method);
  }
  const bare = fakeFetch({ text: '{"id":"1"}' });
  await call(env, { connection: "team-chat" }, bare);
  assert.equal(bare.calls[0].url, WEBHOOK_URL);
  for (const path of ["../", "messages/@original", "messages/../x", "messages/42/.."]) {
    const other = fakeFetch();
    const answer = await call(env, { connection: "team-chat", path }, other);
    assert.equal(answer.error, "invalid-input", path);
    assert.equal(other.calls.length, 0, path);
    assert.ok(!JSON.stringify(answer).includes(WEBHOOK_TOKEN), path);
  }
});

test("a path that could leave the api root is refused and nothing is sent", async (t) => {
  const env = callHome(t, "cc-paths");
  const paths = ["https://evil.example/x", "//evil.example/x", "organizations/../../x", "a/%2e%2e/b", "a/%2E%2E/b", "a%2fb", "a\\b", "a?x=1", "a#b", "javascript:alert(1)", "./a", "a b", `https://x/${SENTRY_TOKEN}`];
  for (const path of paths) {
    const fetch = fakeFetch();
    const answer = await call(env, { connection: "sn", path }, fetch);
    assert.equal(answer.error, "invalid-input", path);
    assert.equal(fetch.calls.length, 0, path);
    assert.ok(!JSON.stringify(answer).includes(SENTRY_TOKEN), path);
  }
});

test("DELETE and any method but GET, POST, PATCH or PUT are refused and nothing is sent", async (t) => {
  const env = callHome(t, "cc-methods");
  for (const method of ["DELETE", "HEAD", "delete"]) {
    const fetch = fakeFetch();
    const answer = await call(env, { connection: "sn", method, path: "x/" }, fetch);
    assert.deepEqual(answer, { ok: false, error: "invalid-input", status: null, detail: "method is GET, POST, PATCH or PUT" }, method);
    assert.equal(fetch.calls.length, 0, method);
  }
});

test("a stored secret is redacted from every value, nested list and key of an answer", async (t) => {
  const env = callHome(t, "cc-redact");
  const crafted = { echo: SENTRY_TOKEN, nested: [{ deep: [`x ${SENTRY_TOKEN} y`] }], [SENTRY_TOKEN]: 1 };
  const answer = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ text: JSON.stringify(crafted) }));
  assert.equal(answer.ok, true);
  assert.ok(!JSON.stringify(answer).includes(SENTRY_TOKEN), JSON.stringify(answer));
  assert.equal(answer.body.echo, "[redacted]");
});

test("a webhook answer echoing its token or its url carries neither", async (t) => {
  const env = callHome(t, "cc-redact-webhook");
  const answer = await call(env, { connection: "team-chat" }, fakeFetch({ text: JSON.stringify({ token: WEBHOOK_TOKEN, url: WEBHOOK_URL }) }));
  const text = JSON.stringify(answer);
  assert.ok(!text.includes(WEBHOOK_TOKEN), text);
  assert.ok(!text.includes(WEBHOOK_URL), text);
});

test("a secret straddling the 50,000 cut is redacted before the cut", async (t) => {
  const env = callHome(t, "cc-boundary");
  const raw = `${"x".repeat(49_995)}${SENTRY_TOKEN}${"y".repeat(100)}`;
  const answer = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ text: raw }));
  assert.equal(answer.body_truncated, true);
  assert.equal(answer.body.length, 50_000);
  assert.ok(!answer.body.includes(SENTRY_TOKEN));
  for (let size = 8; size <= SENTRY_TOKEN.length; size += 1) assert.ok(!answer.body.endsWith(SENTRY_TOKEN.slice(0, size)), `prefix ${size}`);
});

test("an answer that fits is not marked truncated", async (t) => {
  const env = callHome(t, "cc-fits");
  const answer = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ text: '{"a":1}' }));
  assert.equal(Object.hasOwn(answer, "body_truncated"), false);
});

test("inside a queue job a POST is refused before anything is sent and a GET is sent", async (t) => {
  const env = { ...callHome(t, "cc-in-job"), NIGHTQUEUE_JOB_ID: "7" };
  const post = fakeFetch();
  await assert.rejects(() => call(env, { connection: "linear", method: "POST", body: { query: "{}" } }, post), { message: REFUSAL });
  assert.equal(post.calls.length, 0);
  const get = fakeFetch();
  assert.equal((await call(env, { connection: "sn", path: "x/" }, get)).ok, true);
  assert.equal(get.calls.length, 1);
});

test("a refused call answers its status and a fixed detail, never the provider's message", async (t) => {
  const env = callHome(t, "cc-failures");
  const notFound = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ status: 404, json: { detail: `secret-ish message ${SENTRY_TOKEN}` } }));
  assert.deepEqual(notFound, { ok: false, error: "provider-unavailable", status: 404, detail: "HTTP 404" });
  const redirect = fakeFetch({ status: 302, text: "" });
  assert.deepEqual(await call(env, { connection: "sn", path: "x/" }, redirect), { ok: false, error: "provider-unavailable", status: 302, detail: "HTTP 302" });
  assert.equal(redirect.calls.length, 1);
  const thrown = await call(env, { connection: "sn", method: "POST", path: "x/", body: {} }, fakeFetch({ throws: true }));
  assert.equal(thrown.status, null);
  assert.ok(thrown.detail.startsWith("network failure"));
  assert.ok(thrown.detail.endsWith("may still have been applied - check before trying again"));
  const thrownGet = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ throws: true }));
  assert.equal(thrownGet.detail, "network failure");
});

test("an empty or non-JSON success is answered as null or as the text", async (t) => {
  const env = callHome(t, "cc-lenient");
  assert.deepEqual(await call(env, { connection: "team-chat", method: "POST", body: { content: "hi" } }, fakeFetch({ status: 204, text: "" })), { ok: true, status: 204, body: null });
  assert.deepEqual(await call(env, { connection: "sn", path: "x/" }, fakeFetch({ text: "plain words" })), { ok: true, status: 200, body: "plain words" });
});

test("requestJson without lenient still refuses a 2xx that is not JSON", async () => {
  const impl = async () => ({ status: 200, headers: new Map(), json: async () => JSON.parse("not json"), text: async () => "not json" });
  const answer = await requestJson(impl, "https://example.test/");
  assert.equal(answer.ok, false);
  assert.equal(answer.detail, "network failure");
});

test("a connection whose kind declares no api, or a name not stored, is refused", async (t) => {
  const env = callHome(t, "cc-unavailable");
  const fetch = fakeFetch();
  assert.equal((await call(env, { connection: "nowhere" }, fetch)).error, "no-connection");
  assert.equal((await call(env, { connection: "constructor" }, fetch)).error, "no-connection");
  const bare = { kind: "bare", connection: { secretFields: ["token"] } };
  const bareEnv = callHome(t, "cc-bare", { records: { b: { type: "bare", token: "bare_secret_0123456789" } } });
  await withProviders([bare], async () => {
    assert.equal((await call(bareEnv, { connection: "b" }, fetch)).error, "provider-unavailable");
  });
  assert.equal(fetch.calls.length, 0);
});

test("a body over 50,000 characters serialized, or a GET with a body, is refused and nothing is sent", async (t) => {
  const env = callHome(t, "cc-body");
  const fetch = fakeFetch();
  const long = await call(env, { connection: "linear", method: "POST", body: { query: "q".repeat(50_000) } }, fetch);
  assert.deepEqual(long, { ok: false, error: "invalid-input", status: null, detail: "body is longer than 50,000 characters serialized" });
  assert.equal((await call(env, { connection: "sn", path: "x/", body: { a: 1 } }, fetch)).error, "invalid-input");
  assert.equal(fetch.calls.length, 0);
});

test("a write answered 5xx says it may still have been applied, a 4xx and a GET 5xx do not", async (t) => {
  const env = callHome(t, "cc-write-5xx");
  for (const method of ["POST", "PATCH", "PUT"]) {
    const answer = await call(env, { connection: "sn", method, path: "x/", body: { a: 1 } }, fakeFetch({ status: 504, text: "gateway timeout" }));
    assert.deepEqual(answer, { ok: false, error: "provider-unavailable", status: 504, detail: "HTTP 504; it may still have been applied - check before trying again" }, method);
  }
  assert.equal((await call(env, { connection: "sn", method: "POST", path: "x/", body: {} }, fakeFetch({ status: 400, text: "{}" }))).detail, "HTTP 400");
  assert.equal((await call(env, { connection: "sn", path: "x/" }, fakeFetch({ status: 503, text: "{}" }))).detail, "HTTP 503");
});

test("an answer nested deeper than the walk allows is answered as its redacted text, never thrown", async (t) => {
  const env = callHome(t, "cc-deep");
  const text = `${"[".repeat(20_000)}"${SENTRY_TOKEN}"${"]".repeat(20_000)}`;
  const answer = await call(env, { connection: "sn", method: "POST", path: "x/", body: {} }, fakeFetch({ text }));
  assert.equal(answer.ok, true);
  assert.equal(typeof answer.body, "string");
  assert.ok(!answer.body.includes(SENTRY_TOKEN));
  const shallow = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ text: "[[[1]]]" }));
  assert.deepEqual(shallow.body, [[[1]]]);
});

test("a secret with JSON-escaped characters used as an object key is redacted", async (t) => {
  const odd = 'sntrys_od"d\\tok/en_0123456789';
  const env = callHome(t, "cc-odd-key", { sentry: { token: odd } });
  const answer = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ text: JSON.stringify({ [odd]: 1, v: odd }) }));
  const text = JSON.stringify(answer);
  assert.ok(!text.includes(odd) && !text.includes(JSON.stringify(odd).slice(1, -1)), text);
});

test("an answer echoing another connection's webhook token is redacted", async (t) => {
  const env = callHome(t, "cc-other-parts");
  const answer = await call(env, { connection: "sn", path: "x/" }, fakeFetch({ text: JSON.stringify({ u: encodeURIComponent(WEBHOOK_URL) }) }));
  assert.ok(!JSON.stringify(answer).includes(WEBHOOK_TOKEN), JSON.stringify(answer));
});
