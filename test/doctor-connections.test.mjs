import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { loadSecrets, saveSecrets } from "../src/config/store.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";

const SETUP = ["setup", "--no-path", "--no-embedding"];
const GITHUB_TOKEN = "ghp_doctor_secret_token";
const SENTRY_TOKEN = "sntrys_doctor_secret_token";
const WEBHOOK_URL = "https://discord.com/api/webhooks/123456789012345678/doctor-secret-webhook-token";

// A fake fetch: github answers, sentry refuses with a 500, the discord webhook never answers and ignores the abort.
function fakeFetch() {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    if (url === "https://api.github.com/user") return { status: 200, headers: new Map([["x-oauth-scopes", "repo"]]), json: async () => ({ login: "octo" }) };
    if (url.startsWith("https://sentry.io/")) return { status: 500, headers: new Map(), json: async () => ({}) };
    return new Promise(() => {});
  };
  return { impl, calls };
}

// Installs the runtime into an isolated host, so the diagnosis reads a real home.
async function setupHost(t, name) {
  const host = makeHostEnv(t, name);
  await run(SETUP, { ...defaultContext(), env: host.env, out: () => {}, err: () => {} });
  return host;
}

// Runs the diagnosis in process with an injected fetch and a short connection budget, returning the parsed report.
async function diagnose(env, fetchImpl) {
  const out = [];
  const ctx = { ...defaultContext(), env: assertIsolatedEnv(env), fetchImpl, connectionTestTimeoutMs: 1000, out: (line) => out.push(line), err: () => {} };
  const code = await run(["doctor", "--json"], ctx);
  return { code, report: JSON.parse(out[0]), raw: out.join("\n") };
}

// The connection lines of a report.
function connectionChecks(report) {
  return report.checks.filter((entry) => entry.name.startsWith("connection "));
}

test("doctor prints no connection line when no connection is stored", async (t) => {
  const host = await setupHost(t, "doctor-connections-none");
  const fetch = fakeFetch();
  const { report } = await diagnose(host.env, fetch.impl);
  assert.deepEqual(connectionChecks(report), []);
  assert.deepEqual(fetch.calls, []);
});

test("doctor tests every stored connection and warns, never fails, for a failed test, a timeout or an unknown type", async (t) => {
  const host = await setupHost(t, "doctor-connections-warn");
  const secrets = loadSecrets(host.env, { warn: () => {} });
  secrets.connections.zgh = { type: "github", token: GITHUB_TOKEN };
  secrets.connections.sn = { type: "sentry", token: SENTRY_TOKEN, org: "acme", url: "https://sentry.io" };
  secrets.connections.chat = { type: "discord", url: WEBHOOK_URL, channelId: "1", guildId: "2", mode: "webhook" };
  secrets.connections.old = { type: "pager", token: "x" };
  saveSecrets(secrets, host.env);

  const fetch = fakeFetch();
  const { report, raw } = await diagnose(host.env, fetch.impl);
  assert.deepEqual(connectionChecks(report), [
    { name: "connection chat", status: "warn", detail: "discord: failed - timeout (1s)", hint: "nightqueue connection test chat" },
    { name: "connection old", status: "warn", detail: "unknown type pager", hint: "update nightqueue or run `nightqueue connection remove old`" },
    { name: "connection sn", status: "warn", detail: "sentry: failed - HTTP 500", hint: "nightqueue connection test sn" },
    { name: "connection zgh", status: "ok", detail: "github: ok", hint: null },
  ]);
  assert.equal(fetch.calls.length, 3);
  for (const secret of [GITHUB_TOKEN, SENTRY_TOKEN, WEBHOOK_URL]) assert.ok(!raw.includes(secret));
  assert.ok(connectionChecks(report).every((entry) => entry.status !== "fail"));
});
