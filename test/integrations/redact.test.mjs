import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { redactSecrets, redactValue } from "../../src/integrations/redact.mjs";
import { resetTrackerCache } from "../../src/integrations/tracker.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const KEY = "lin_api_secret_0123456789ABCDEFGHIJKLMNOPQRSTUV";
const TEAMS = { data: { teams: { nodes: [{ id: "team-mk", key: "MK", states: { nodes: [] } }] } } };

// A home whose linear connection stores the fake key.
function keyedHome(t, name) {
  const env = makeHome(t, name);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.linear = { type: "linear", apiKey: KEY };
  saveSecrets(secrets, env);
  return env;
}

// The real tool server and a client wired together in this process, so the test's fetch is the server's.
async function connectInProcess(t, env) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-redact", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// The whole text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// Replaces the global fetch with a fake Linear that creates any issue with the given title, for this test only.
function fakeLinearCreating(t, title) {
  const realFetch = globalThis.fetch;
  resetTrackerCache();
  globalThis.fetch = async (url, options) => {
    const { query } = JSON.parse(options.body);
    const body = query.includes("issueCreate")
      ? { data: { issueCreate: { success: true, issue: { identifier: "MK-50", title, url: "https://linear.app/a/issue/MK-50" } } } }
      : query.includes("teams") ? TEAMS : { data: {} };
    return { status: 200, headers: new Map(), json: async () => body };
  };
  t.after(() => {
    globalThis.fetch = realFetch;
  });
}

test("redactValue replaces the stored key in every text at any depth and keeps everything else", (t) => {
  const env = keyedHome(t, "redact-value");
  const value = { ok: true, n: 3, flag: false, none: null, issue: { title: `x ${KEY} y`, labels: ["a", KEY] } };
  assert.deepEqual(redactValue(value, env), { ok: true, n: 3, flag: false, none: null, issue: { title: "x [redacted] y", labels: ["a", "[redacted]"] } });
  assert.equal(redactSecrets(`k=${KEY}`, env), "k=[redacted]");
});

test("redactValue answers the same value when the home stores no secret", (t) => {
  const env = makeHome(t, "redact-value-none");
  const value = { ok: true, issue: { title: KEY } };
  assert.equal(redactValue(value, env), value);
});

for (const [name, extra] of [["tracker_read", {}], ["tracker_comment", { body: "hi" }], ["tracker_update", { priority: 2 }]]) {
  test(`${name}: a reference ending in the stored key is redacted before the echo is cut, so no part of the key leaks`, async (t) => {
    const client = await connectInProcess(t, keyedHome(t, `redact-cut-${name}`));
    const out = textOf(await client.callTool({ name, arguments: { ref: "x".repeat(60) + KEY, ...extra } }));
    assert.ok(!out.includes(KEY.slice(0, 20)), out);
    assert.match(out, /invalid-input/);
  });
}

test("a successful tracker answer never echoes the stored key", async (t) => {
  const client = await connectInProcess(t, keyedHome(t, "redact-ok"));
  fakeLinearCreating(t, KEY);
  const out = textOf(await client.callTool({ name: "tracker_create", arguments: { team: "MK", title: KEY } }));
  assert.ok(out.includes("MK-50"), `the fake did not reach a successful create: ${out}`);
  assert.ok(!out.includes(KEY), out);
  assert.match(out, /\[redacted\]/);
});
