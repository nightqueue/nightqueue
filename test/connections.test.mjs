import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addConnection,
  bindConnection,
  connectionFor,
  listConnections,
  removeConnection,
  requireType,
  secretOf,
  testConnection,
} from "../src/config/connections.mjs";
import { UserError } from "../src/config/errors.mjs";
import { emptyConfig, emptySecrets } from "../src/config/schema.mjs";
import { resolveForClose } from "../src/integrations/connections.mjs";

const TOKEN = "s3cr3t-sentinel-do-not-print";
const DEFAULT = "01J00000000000000000000DEF";
const ACME = "01J0000000000000000000ACME";
const EXTRA = { org: "acme" };
const SENTRY_ORG_URL = "https://sentry.io/api/0/organizations/acme/";

// Builds an empty config and empty secrets; the org ids stand for two registered orgs.
function fixture() {
  return { config: emptyConfig(), secrets: emptySecrets() };
}

// Adds a Sentry connection of the acme Sentry org, the stored org-slot kind of this build.
function addSentry({ config, secrets, name, orgId = DEFAULT, secret = TOKEN }) {
  return addConnection({ config, secrets, name, type: "sentry", orgId, secret, extra: EXTRA });
}

// Doubles the Sentry fetch, recording the arguments it receives.
function fakeFetch(response, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
}

test("addConnection binds an empty slot of an org id and reports an occupied one", () => {
  const { config, secrets } = fixture();
  const first = addSentry({ config, secrets, name: "st" });
  assert.equal(first.bound, true);
  assert.equal(first.orgId, DEFAULT);
  assert.equal(first.occupiedBy, null);
  assert.equal(connectionFor(config, DEFAULT, "sentry"), "st");
  assert.deepEqual(secrets.connections.st, { type: "sentry", token: TOKEN, org: "acme", url: "https://sentry.io" });

  const second = addSentry({ config, secrets, name: "st2", secret: "other" });
  assert.equal(second.bound, false);
  assert.equal(second.occupiedBy, "st");
  assert.equal(connectionFor(config, DEFAULT, "sentry"), "st");
  assert.equal(secrets.connections.st2.token, "other");
});

test("addConnection validates name, type, secret and duplicates", () => {
  const { config, secrets } = fixture();
  assert.throws(() => addSentry({ config, secrets, name: "ST" }), UserError);
  assert.throws(() => addConnection({ config, secrets, name: "st", type: "jira", orgId: DEFAULT, secret: TOKEN }), (err) => {
    assert.match(err.message, /unknown connection type `jira`; supported: sentry/);
    return true;
  });
  assert.throws(() => addConnection({ config, secrets, name: "gh", type: "github", orgId: DEFAULT, secret: TOKEN }), (err) => {
    assert.match(err.message, /github is not a stored connection: .*run `gh auth login`/);
    return true;
  });
  assert.throws(() => addSentry({ config, secrets, name: "st", secret: "" }), UserError);
  assert.deepEqual(Object.keys(secrets.connections), []);
  addSentry({ config, secrets, name: "st" });
  assert.throws(() => addSentry({ config, secrets, name: "st", secret: "other" }), (err) => {
    assert.match(err.message, /connection `st` already exists; remove it first/);
    return true;
  });
  assert.equal(secrets.connections.st.token, TOKEN);
});

test("bindConnection rebinds an occupied slot and reports what it replaced", () => {
  const { config, secrets } = fixture();
  addSentry({ config, secrets, name: "st" });
  addSentry({ config, secrets, name: "st2", secret: "other" });
  const result = bindConnection({ config, secrets, name: "st2", orgId: DEFAULT });
  assert.equal(result.type, "sentry");
  assert.equal(result.previous, "st");
  assert.equal(connectionFor(config, DEFAULT, "sentry"), "st2");
  assert.equal(bindConnection({ config, secrets, name: "st", orgId: ACME }).previous, null);
  assert.equal(connectionFor(config, ACME, "sentry"), "st");
  assert.throws(() => bindConnection({ config, secrets, name: "nope", orgId: DEFAULT }), UserError);
});

test("removeConnection unbinds from every org and drops the secret", () => {
  const { config, secrets } = fixture();
  addSentry({ config, secrets, name: "st" });
  bindConnection({ config, secrets, name: "st", orgId: ACME });
  const result = removeConnection({ config, secrets, name: "st" });
  assert.deepEqual(result.unboundFrom, [DEFAULT, ACME]);
  assert.equal(connectionFor(config, DEFAULT, "sentry"), null);
  assert.equal(connectionFor(config, ACME, "sentry"), null);
  assert.deepEqual(Object.keys(secrets.connections), []);
  assert.throws(() => removeConnection({ config, secrets, name: "st" }), UserError);
});

test("listConnections exposes no secret and keeps dangling pointers visible", () => {
  const { config, secrets } = fixture();
  addSentry({ config, secrets, name: "st" });
  bindConnection({ config, secrets, name: "st", orgId: ACME });
  config.orgConnections[ACME].sentry = "ghost";
  const rows = listConnections(config, secrets);
  assert.deepEqual(rows, [
    { name: "st", type: "sentry", present: true, orgs: [DEFAULT] },
    { name: "ghost", type: "sentry", present: false, orgs: [ACME] },
  ]);
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
});

test("secretOf is the only accessor that returns the stored value", () => {
  const { config, secrets } = fixture();
  addSentry({ config, secrets, name: "st" });
  assert.deepEqual(secretOf(secrets, "st"), { type: "sentry", token: TOKEN, org: "acme", url: "https://sentry.io" });
  assert.equal(secretOf(secrets, "nope"), null);
  assert.equal(JSON.stringify(config).includes(TOKEN), false);
});

test("testConnection sends the token only in the Authorization header", async () => {
  const { config, secrets } = fixture();
  addSentry({ config, secrets, name: "st" });
  const calls = [];
  const response = { status: 200, headers: new Headers(), json: async () => ({ slug: "acme" }) };
  const result = await testConnection({ name: "st", secrets, fetchImpl: fakeFetch(response, calls) });
  assert.deepEqual(result, { type: "sentry", ok: true, status: 200, org: "acme", detail: "ok" });
  assert.equal(calls[0].url, SENTRY_ORG_URL);
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  const withoutHeader = { ...calls[0].options, headers: { ...calls[0].options.headers, Authorization: "" } };
  assert.equal(JSON.stringify({ url: calls[0].url, options: withoutHeader }).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("testConnection reports an HTTP failure without leaking the token", async () => {
  const { config, secrets } = fixture();
  addSentry({ config, secrets, name: "st" });
  const response = { status: 401, headers: new Headers(), json: async () => ({}) };
  const result = await testConnection({ name: "st", secrets, fetchImpl: fakeFetch(response) });
  assert.deepEqual(result, { type: "sentry", ok: false, status: 401, org: null, detail: "HTTP 401" });
});

test("testConnection turns a timeout and a network error into a detail string", async () => {
  const { config, secrets } = fixture();
  addSentry({ config, secrets, name: "st" });
  const timeout = new Error(`connecting to ${SENTRY_ORG_URL} with ${TOKEN}`);
  timeout.name = "TimeoutError";
  const timedOut = await testConnection({ name: "st", secrets, fetchImpl: fakeFetch(timeout) });
  assert.equal(timedOut.detail, "timeout (5s)");
  assert.equal(JSON.stringify(timedOut).includes(TOKEN), false);
  const broken = await testConnection({ name: "st", secrets, fetchImpl: fakeFetch(new Error(TOKEN)) });
  assert.deepEqual(broken, { type: "sentry", ok: false, status: null, org: null, detail: "network failure" });
});

test("testConnection and requireType refuse unknown inputs", async () => {
  await assert.rejects(() => testConnection({ name: "nope", secrets: emptySecrets() }), UserError);
  assert.equal(requireType("sentry").secretFields[0], "token");
  assert.throws(() => requireType("nope"), UserError);
  assert.throws(() => requireType("github"), UserError);
});

test("a home-scoped connection is stored once, binds no org and lists as home", () => {
  const { config, secrets } = fixture();
  const before = JSON.stringify(config);
  const added = addConnection({ config, secrets, name: "lin", type: "linear", orgId: null, secret: TOKEN });
  assert.deepEqual({ ...added, config: null, secrets: null }, { config: null, secrets: null, orgId: null, bound: false, home: true, occupiedBy: null });
  assert.deepEqual(secrets.connections.lin, { type: "linear", apiKey: TOKEN });
  assert.equal(JSON.stringify(config), before);
  assert.throws(() => addConnection({ config, secrets, name: "lin2", type: "linear", orgId: DEFAULT, secret: "other" }), (err) => {
    assert.equal(err.message, "a home has one `linear` connection: `lin`; remove it first");
    return true;
  });
  assert.throws(() => bindConnection({ config, secrets, name: "lin", orgId: ACME }), (err) => {
    assert.equal(err.message, "connection `lin` (linear) serves the whole home and binds to no org");
    return true;
  });
  addSentry({ config, secrets, name: "st" });
  const rows = listConnections(config, secrets);
  assert.deepEqual(rows.find((row) => row.name === "lin"), { name: "lin", type: "linear", present: true, orgs: [], scope: "home" });
  assert.equal("scope" in rows.find((row) => row.name === "st"), false);
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
});

test("resolveForClose answers the home's one connection for a home-scoped kind, whatever the org", () => {
  const secrets = { connections: { zlin: { type: "linear", apiKey: "z" }, alin: { type: "linear", apiKey: "a" }, st: { type: "sentry", token: TOKEN, org: "acme" } } };
  for (const orgId of [null, DEFAULT]) {
    const resolved = resolveForClose({ kind: "linear", orgId, config: emptyConfig(), secrets });
    assert.deepEqual(resolved, { slot: { type: "linear", apiKey: "a", name: "alin" }, connections: [] });
  }
  assert.deepEqual(resolveForClose({ kind: "linear", orgId: DEFAULT, config: null, secrets: emptySecrets() }), { slot: null, connections: [] });
});
