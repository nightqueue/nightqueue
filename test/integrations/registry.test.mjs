import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { CONNECTION_TYPES, requireType } from "../../src/config/connections.mjs";
import { emptySlots } from "../../src/config/schema.mjs";
import { originCoverage } from "../../src/integrations/coverage.mjs";
import {
  actsOnOrigin,
  ambientProviders,
  connectionProviders,
  connectionTypes,
  isHomeScoped,
  manyTypes,
  moduleCards,
  originProviders,
  providerOf,
  providers,
  retiredConnectionKinds,
  slotTypes,
  withProviders,
} from "../../src/integrations/registry.mjs";
import { providerSettingsView } from "../../src/integrations/settings.mjs";
import { requestJson } from "../../src/integrations/http.mjs";

const INTEGRATIONS_DIR = fileURLToPath(new URL("../../src/integrations/", import.meta.url));
const SECRET = "ghp_registrytestsecret0000000000000000";

test("the registry lists github first, then sentry, then linear, then discord, in this build", () => {
  assert.deepEqual(providers().map((provider) => provider.kind), ["github", "sentry", "linear", "discord"]);
  assert.equal(providerOf("github").kind, "github");
  assert.equal(providerOf("nope"), null);
  assert.deepEqual(slotTypes(), ["sentry"]);
  assert.deepEqual(manyTypes(), ["discord"]);
  assert.deepEqual(originProviders().map((provider) => provider.kind), ["sentry", "linear", "discord"]);
});

test("emptySlots is derived from the one-cardinality connection providers", () => {
  assert.deepEqual({ ...emptySlots() }, { sentry: null });
  assert.equal(Object.getPrototypeOf(emptySlots()), null);
});

test("CONNECTION_TYPES holds only the stored kinds; github is read from the machine's gh", () => {
  assert.ok(CONNECTION_TYPES instanceof Map);
  assert.deepEqual([...CONNECTION_TYPES.keys()], ["sentry", "linear", "discord"]);
  assert.deepEqual(connectionProviders().map((provider) => provider.kind), ["sentry", "linear", "discord"]);
  assert.deepEqual(ambientProviders().map((provider) => provider.kind), ["github"]);
  assert.deepEqual(retiredConnectionKinds(), ["github"]);
  assert.equal(requireType("sentry"), connectionTypes().get("sentry"));
  assert.throws(() => requireType("github"), /github is not a stored connection: nightqueue uses the machine's authenticated gh; run `gh auth login`/);
  assert.throws(() => requireType("jira"), /unknown connection type `jira`; supported: sentry, linear, discord/);
});

test("moduleCards lists GitHub, Linear, Sentry, Discord as plain data that survives JSON", () => {
  const cards = moduleCards();
  assert.deepEqual(cards.map((card) => card.kind), ["github", "linear", "sentry", "discord"]);
  assert.deepEqual(JSON.parse(JSON.stringify(cards)), cards);
  const byKind = Object.fromEntries(cards.map((card) => [card.kind, card]));
  assert.deepEqual(cards.map((card) => card.icon), ["github", "linear", "sentry", "discord"]);
  assert.deepEqual(cards.map((card) => card.destinations), [false, false, false, true]);
  assert.deepEqual([byKind.discord.place, byKind.linear.place, byKind.github.place, byKind.sentry.place], ["org", "home", "machine", "org"]);
  assert.equal(byKind.github.add, null);
  assert.deepEqual(byKind.github.ambient, { statusPath: "/api/integrations/github/status", command: "gh auth login --web" });
  assert.equal(byKind.discord.add.nameRequired, true);
  assert.equal(byKind.linear.add.orgRequired, false);
  assert.equal(byKind.sentry.add.secretField, "token");
  assert.deepEqual(byKind.sentry.add.fields.map((field) => field.name), ["org", "url"]);
});

test("origin coverage and the settings view run on the real registry, github included", () => {
  const empty = { orgConnections: {} };
  const covered = originCoverage({ origin: { kind: "github", ref: "x" }, orgId: "o", integrations: { github: {} }, config: empty, secrets: { connections: {} } });
  assert.equal(covered.connection, "none");
  assert.deepEqual(providerSettingsView().map((view) => view.kind), ["github", "sentry", "linear", "discord"]);
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
