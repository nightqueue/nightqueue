import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CONNECTION_TYPES, requireType } from "../../src/config/connections.mjs";
import { emptySlots } from "../../src/config/schema.mjs";
import {
  actsOnOrigin,
  connectionTypes,
  isHomeScoped,
  manyTypes,
  originProviders,
  providerOf,
  providers,
  slotTypes,
  withProviders,
} from "../../src/integrations/registry.mjs";
import { requestJson } from "../../src/integrations/http.mjs";

const INTEGRATIONS_DIR = fileURLToPath(new URL("../../src/integrations/", import.meta.url));
const SECRET = "ghp_registrytestsecret0000000000000000";

test("the registry lists github first, then sentry, then linear, then discord, in this build", () => {
  assert.deepEqual(providers().map((provider) => provider.kind), ["github", "sentry", "linear", "discord"]);
  assert.equal(providerOf("github").kind, "github");
  assert.equal(providerOf("nope"), null);
  assert.deepEqual(slotTypes(), ["github", "sentry"]);
  assert.deepEqual(manyTypes(), ["discord"]);
  assert.deepEqual(originProviders().map((provider) => provider.kind), ["sentry", "linear", "discord"]);
});

test("emptySlots is derived from the one-cardinality providers", () => {
  assert.deepEqual({ ...emptySlots() }, { github: null, sentry: null });
  assert.equal(Object.getPrototypeOf(emptySlots()), null);
});

test("CONNECTION_TYPES is the registry's map with the github descriptor", () => {
  assert.ok(CONNECTION_TYPES instanceof Map);
  assert.deepEqual([...CONNECTION_TYPES.keys()], ["github", "sentry", "linear", "discord"]);
  const github = CONNECTION_TYPES.get("github");
  assert.deepEqual(github.secretFields, ["token"]);
  assert.deepEqual(github.extraFields, []);
  assert.equal(github.cardinality, "one");
  assert.equal(typeof github.test, "function");
  assert.equal(requireType("github"), github);
  assert.equal(connectionTypes().get("github"), github);
});

test("the github summary keeps the historical connection test line", () => {
  const summary = requireType("github").summary;
  assert.equal(summary({ login: "octocat", scopes: "repo" }), "login=octocat scopes=repo");
  assert.equal(summary({ login: null, scopes: "" }), "login=(none) scopes=(none)");
});

test("withProviders swaps the list for the callback and restores it after a throw", async () => {
  const fake = { kind: "fake", connection: { cardinality: "many", secretFields: ["url"], extraFields: [] } };
  await withProviders([fake], () => {
    assert.deepEqual(manyTypes(), ["fake"]);
    assert.deepEqual({ ...emptySlots() }, {});
  });
  await assert.rejects(() => withProviders([fake], () => Promise.reject(new Error("boom"))), /boom/);
  assert.deepEqual(providers().map((provider) => provider.kind), ["github", "sentry", "linear", "discord"]);
  await assert.rejects(() => withProviders("fake", () => null), TypeError);
});

test("a home-scoped kind has no org slot and acts on an origin without project enablement", () => {
  assert.equal(isHomeScoped("linear"), true);
  assert.equal(isHomeScoped("sentry"), false);
  assert.equal(isHomeScoped("nope"), false);
  assert.equal(actsOnOrigin("linear", null), true);
  assert.equal(actsOnOrigin("sentry", null), false);
  assert.equal(actsOnOrigin("sentry", { sentry: {} }), true);
  assert.equal(slotTypes().includes("linear"), false);
});

test("provider modules import neither config/schema.mjs nor config/connections.mjs", () => {
  for (const file of readdirSync(INTEGRATIONS_DIR).filter((name) => name.endsWith(".mjs"))) {
    const source = readFileSync(path.join(INTEGRATIONS_DIR, file), "utf8");
    assert.doesNotMatch(source, /config\/schema\.mjs|config\/connections\.mjs/, file);
  }
});

test("requestJson never surfaces the error message, URL or headers of a failure", async () => {
  const url = `https://example.invalid/hook/${SECRET}`;
  const thrown = await requestJson(async () => {
    throw new Error(`failed ${url}`);
  }, url, { headers: { Authorization: SECRET } });
  assert.deepEqual(thrown, { ok: false, status: null, headers: null, body: null, detail: "network failure" });
  const timeout = Object.assign(new Error(SECRET), { name: "TimeoutError" });
  const timedOut = await requestJson(async () => {
    throw timeout;
  }, url, { timeoutMs: 20000 });
  assert.equal(timedOut.detail, "timeout (20s)");
  const refused = await requestJson(async () => ({ status: 500, headers: new Headers() }), url);
  assert.equal(refused.detail, "HTTP 500");
  assert.equal(JSON.stringify([thrown, timedOut, refused]).includes(SECRET), false);
});

test("requestJson sends a JSON body with manual redirects", async () => {
  const calls = [];
  const answer = await requestJson(async (target, options) => {
    calls.push(options);
    return { status: 201, headers: new Headers(), json: async () => ({ id: 1 }) };
  }, "https://example.invalid/", { method: "POST", body: { a: 1 } });
  assert.deepEqual(answer.body, { id: 1 });
  assert.equal(calls[0].redirect, "manual");
  assert.equal(calls[0].body, "{\"a\":1}");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
});
