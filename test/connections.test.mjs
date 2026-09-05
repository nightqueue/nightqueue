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
import { addOrg } from "../src/config/orgs.mjs";
import { emptyConfig, emptySecrets } from "../src/config/schema.mjs";

const TOKEN = "s3cr3t-sentinel-do-not-print";

// Monta config com duas orgs e secrets vazio.
function fixture() {
  return { config: addOrg(emptyConfig(), "acme"), secrets: emptySecrets() };
}

// Dubla o fetch do GitHub, registrando os argumentos recebidos.
function fakeFetch(response, calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return response;
  };
}

test("addConnection binds an empty slot and reports an occupied one", () => {
  const { config, secrets } = fixture();
  const first = addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  assert.equal(first.bound, true);
  assert.equal(first.org, "default");
  assert.equal(first.occupiedBy, null);
  assert.equal(connectionFor(config, "default", "github"), "gh");
  assert.deepEqual(secrets.connections.gh, { type: "github", token: TOKEN });

  const second = addConnection({ config, secrets, name: "gh2", type: "github", secret: "other" });
  assert.equal(second.bound, false);
  assert.equal(second.occupiedBy, "gh");
  assert.equal(connectionFor(config, "default", "github"), "gh");
  assert.equal(secrets.connections.gh2.token, "other");
});

test("addConnection validates name, type, org, secret and duplicates", () => {
  const { config, secrets } = fixture();
  assert.throws(() => addConnection({ config, secrets, name: "GH", type: "github", secret: TOKEN }), UserError);
  assert.throws(() => addConnection({ config, secrets, name: "gh", type: "linear", secret: TOKEN }), (err) => {
    assert.match(err.message, /unknown connection type `linear`; supported: github/);
    return true;
  });
  assert.throws(() => addConnection({ config, secrets, name: "gh", type: "github", org: "ghost", secret: TOKEN }), (err) => {
    assert.match(err.message, /unknown org `ghost`/);
    return true;
  });
  assert.throws(() => addConnection({ config, secrets, name: "gh", type: "github", secret: "" }), UserError);
  assert.deepEqual(Object.keys(secrets.connections), []);
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  assert.throws(() => addConnection({ config, secrets, name: "gh", type: "github", secret: "other" }), (err) => {
    assert.match(err.message, /connection `gh` already exists; remove it first/);
    return true;
  });
  assert.equal(secrets.connections.gh.token, TOKEN);
});

test("bindConnection rebinds an occupied slot and reports what it replaced", () => {
  const { config, secrets } = fixture();
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  addConnection({ config, secrets, name: "gh2", type: "github", secret: "other" });
  const result = bindConnection({ config, secrets, name: "gh2", org: "default" });
  assert.equal(result.type, "github");
  assert.equal(result.previous, "gh");
  assert.equal(connectionFor(config, "default", "github"), "gh2");
  assert.equal(bindConnection({ config, secrets, name: "gh", org: "acme" }).previous, null);
  assert.equal(connectionFor(config, "acme", "github"), "gh");
  assert.throws(() => bindConnection({ config, secrets, name: "nope", org: "default" }), UserError);
  assert.throws(() => bindConnection({ config, secrets, name: "gh", org: "ghost" }), UserError);
});

test("removeConnection unbinds from every org and drops the secret", () => {
  const { config, secrets } = fixture();
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  bindConnection({ config, secrets, name: "gh", org: "acme" });
  const result = removeConnection({ config, secrets, name: "gh" });
  assert.deepEqual(result.unboundFrom, ["default", "acme"]);
  assert.equal(connectionFor(config, "default", "github"), null);
  assert.equal(connectionFor(config, "acme", "github"), null);
  assert.deepEqual(Object.keys(secrets.connections), []);
  assert.throws(() => removeConnection({ config, secrets, name: "gh" }), UserError);
});

test("listConnections exposes no secret and keeps dangling pointers visible", () => {
  const { config, secrets } = fixture();
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  bindConnection({ config, secrets, name: "gh", org: "acme" });
  config.orgs.acme.connections.github = "ghost";
  const rows = listConnections(config, secrets);
  assert.deepEqual(rows, [
    { name: "gh", type: "github", present: true, orgs: ["default"] },
    { name: "ghost", type: "github", present: false, orgs: ["acme"] },
  ]);
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
});

test("secretOf is the only accessor that returns the stored value", () => {
  const { config, secrets } = fixture();
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  assert.deepEqual(secretOf(secrets, "gh"), { type: "github", token: TOKEN });
  assert.equal(secretOf(secrets, "nope"), null);
  assert.equal(JSON.stringify(config).includes(TOKEN), false);
});

test("testConnection sends the token only in the Authorization header", async () => {
  const { config, secrets } = fixture();
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  const calls = [];
  const response = {
    status: 200,
    headers: new Headers({ "X-OAuth-Scopes": "repo, read:org" }),
    json: async () => ({ login: "octocat" }),
  };
  const result = await testConnection({ name: "gh", secrets, fetchImpl: fakeFetch(response, calls) });
  assert.deepEqual(result, {
    type: "github",
    ok: true,
    status: 200,
    login: "octocat",
    scopes: "repo, read:org",
    detail: "ok",
  });
  assert.equal(calls[0].url, "https://api.github.com/user");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  const withoutHeader = { ...calls[0].options, headers: { ...calls[0].options.headers, Authorization: "" } };
  assert.equal(JSON.stringify({ url: calls[0].url, options: withoutHeader }).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("testConnection reports an HTTP failure without leaking the token", async () => {
  const { config, secrets } = fixture();
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  const response = { status: 401, headers: new Headers(), json: async () => ({}) };
  const result = await testConnection({ name: "gh", secrets, fetchImpl: fakeFetch(response) });
  assert.deepEqual(result, { type: "github", ok: false, status: 401, login: null, scopes: null, detail: "HTTP 401" });
});

test("testConnection turns a timeout and a network error into a detail string", async () => {
  const { config, secrets } = fixture();
  addConnection({ config, secrets, name: "gh", type: "github", secret: TOKEN });
  const timeout = new Error(`connecting to https://api.github.com with ${TOKEN}`);
  timeout.name = "TimeoutError";
  const timedOut = await testConnection({ name: "gh", secrets, fetchImpl: fakeFetch(timeout) });
  assert.equal(timedOut.detail, "timeout (5s)");
  assert.equal(JSON.stringify(timedOut).includes(TOKEN), false);
  const broken = await testConnection({ name: "gh", secrets, fetchImpl: fakeFetch(new Error(TOKEN)) });
  assert.deepEqual(broken, { type: "github", ok: false, status: null, login: null, scopes: null, detail: "network failure" });
});

test("testConnection and requireType refuse unknown inputs", async () => {
  await assert.rejects(() => testConnection({ name: "nope", secrets: emptySecrets() }), UserError);
  assert.equal(requireType("github").secretFields[0], "token");
  assert.throws(() => requireType("sentry"), UserError);
});
