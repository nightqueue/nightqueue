import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { loadConfig, loadSecrets } from "../../src/config/store.mjs";
import { originCoverage } from "../../src/integrations/coverage.mjs";
import { detectOrigin, explicitOrigin, parseOriginColumn } from "../../src/integrations/origin.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import {
  bindTrackerConnection,
  orgOfProject,
  originProviders,
  setIntegrations,
  shadowProvider,
  TRACKER_SECRET,
  TRACKER_URL,
} from "../../test-support/origin-provider.mjs";

const PROMPT = `the worker crashes on boot, see ${TRACKER_URL}`;

// A temp home with the project `alpha`.
function makeOriginHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return { env, projectId: projectIdOf(env, "alpha") };
}

// The real tool server and a client wired together in this process, so the test's provider list is the server's.
async function connectInProcess(t, env) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-origin", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// The JSON payload of a tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, result.content.map((block) => block.text).join("\n"));
  return JSON.parse(result.content[0].text);
}

// Runs the CLI in this process, collecting what it printed.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

test("detection takes the first provider in registry order whose parser matches, and nothing matches nothing", async () => {
  await withProviders(originProviders(shadowProvider()), () => {
    assert.deepEqual(detectOrigin(PROMPT), { kind: "tracker", ref: "4507" });
    assert.equal(detectOrigin("fix the worker J-86 and D-55"), null);
    assert.equal(detectOrigin(null), null);
  });
  await withProviders([shadowProvider(), ...originProviders()], () => {
    assert.deepEqual(detectOrigin(PROMPT), { kind: "shadow", ref: "4507" });
  });
});

test("an explicit origin is validated by its provider, and an unknown kind or a foreign reference is refused", async () => {
  await withProviders(originProviders(), () => {
    assert.deepEqual(explicitOrigin({ kind: "tracker", ref: "  42 " }), { kind: "tracker", ref: "42" });
    assert.deepEqual(explicitOrigin({ kind: "tracker", ref: TRACKER_URL }), { kind: "tracker", ref: "4507" });
    assert.throws(() => explicitOrigin({ kind: "tracker", ref: "not an issue" }), /`not an issue` is not a tracker reference; known origin kinds: tracker/);
    assert.throws(() => explicitOrigin({ kind: "github", ref: "1" }), /unknown origin kind `github`; known origin kinds: tracker/);
  });
  await withProviders([originProviders()[0]], () => {
    assert.throws(() => explicitOrigin({ kind: "tracker", ref: "42" }), /unknown origin kind `tracker`; known origin kinds: \(none\)/);
  });
});

test("addJob records an explicit origin over the detected one, detects one when none is given, and stores none when nothing matches", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-add-job");
  await withProviders(originProviders(), () => {
    const explicit = addJob({ projectId, prompt: PROMPT, origin: { kind: "tracker", ref: "42" } }, env);
    const detected = addJob({ projectId, prompt: PROMPT, origin: null }, env);
    const plain = addJob({ projectId, prompt: "fix the worker" }, env);
    assert.deepEqual([explicit.origin, detected.origin, plain.origin], [{ kind: "tracker", ref: "42" }, { kind: "tracker", ref: "4507" }, null]);
    assert.deepEqual(jobView(getJob(explicit.id, env)).origin, { kind: "tracker", ref: "42" });
    assert.deepEqual(jobView(getJob(detected.id, env)).origin, { kind: "tracker", ref: "4507" });
    assert.equal(jobView(getJob(plain.id, env)).origin, null);
    assert.equal(getJob(plain.id, env).origin, null);
  });
});

test("an invalid explicit origin is refused before any job row is written", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-add-refused");
  await withProviders(originProviders(), () => {
    assert.throws(() => addJob({ projectId, prompt: PROMPT, origin: { kind: "nope", ref: "1" } }, env), /unknown origin kind `nope`/);
  });
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("an unreadable origin column reads as no origin", () => {
  assert.equal(parseOriginColumn("{broken"), null);
  assert.equal(parseOriginColumn(JSON.stringify({ kind: "tracker" })), null);
  assert.equal(parseOriginColumn(undefined), null);
});

test("coverage names the org connection only for a project that enabled the provider, and never a secret", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-coverage");
  const origin = { kind: "tracker", ref: "4507" };
  const orgId = orgOfProject(env, projectId);
  await withProviders(originProviders(), () => {
    const files = () => ({ config: loadConfig(env, { warn: () => {} }), secrets: loadSecrets(env, { warn: () => {} }) });
    assert.deepEqual(originCoverage({ origin, orgId, integrations: null, ...files() }), { ...origin, connection: "none", detail: "project has no tracker integration" });
    assert.deepEqual(originCoverage({ origin, orgId, integrations: { tracker: {} }, ...files() }), { ...origin, connection: "none", detail: "no tracker connection in the org" });
    bindTrackerConnection(env, projectId);
    const covered = originCoverage({ origin, orgId, integrations: { tracker: {} }, ...files() });
    assert.deepEqual(covered, { ...origin, connection: "trk", detail: null });
    assert.equal(JSON.stringify(covered).includes(TRACKER_SECRET), false);
  });
});

test("a provider's own coverage rule sees names and public fields only", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-coverage-rule");
  bindTrackerConnection(env, projectId);
  const seen = [];
  const provider = { ...originProviders()[1], covers: (ref, known) => (seen.push(known), { connection: known.slot.name, detail: `ref ${ref}` }) };
  await withProviders([provider], () => {
    const covered = originCoverage({
      origin: { kind: "tracker", ref: "9" },
      orgId: orgOfProject(env, projectId),
      integrations: { tracker: {} },
      config: loadConfig(env, { warn: () => {} }),
      secrets: loadSecrets(env, { warn: () => {} }),
    });
    assert.deepEqual(covered, { kind: "tracker", ref: "9", connection: "trk", detail: "ref 9" });
  });
  assert.deepEqual(seen, [{ slot: { type: "tracker", name: "trk" }, connections: [] }]);
});

test("queue_add answers the origin with its covering connection, and no origin key when the job has none", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-queue-add");
  setIntegrations(env, projectId, { tracker: { enabled: true } });
  bindTrackerConnection(env, projectId);
  const client = await connectInProcess(t, env);
  await withProviders(originProviders(), async () => {
    const detected = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT } }));
    assert.deepEqual(detected.origin, { kind: "tracker", ref: "4507", connection: "trk" });
    assert.match(detected.hint, /\(1 pending\)\. Origin: tracker 4507 \(connection: trk\)\. /);
    const explicit = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it", origin: { kind: "tracker", ref: "12" } } }));
    assert.deepEqual(explicit.origin, { kind: "tracker", ref: "12", connection: "trk" });
    const plain = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser", origin: null } }));
    assert.equal(Object.hasOwn(plain, "origin"), false);
    assert.equal(plain.hint.includes("Origin:"), false);
    assert.equal(JSON.stringify([detected, explicit, plain]).includes(TRACKER_SECRET), false);
  });
});

test("queue_add answers `none` with the reason for a project that did not enable the provider, and refuses an invalid origin", async (t) => {
  const { env } = makeOriginHome(t, "origin-queue-add-none");
  const client = await connectInProcess(t, env);
  await withProviders(originProviders(), async () => {
    const answer = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT } }));
    assert.deepEqual(answer.origin, { kind: "tracker", ref: "4507", connection: "none", detail: "project has no tracker integration" });
    const refused = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "x", origin: { kind: "tracker", ref: "abc" } } });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0].text, /`abc` is not a tracker reference/);
  });
});

test("queue_add with `key` and no `register` answers exactly as without it", async (t) => {
  const { env } = makeOriginHome(t, "origin-queue-add-key");
  const client = await connectInProcess(t, env);
  const without = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the worker" } }));
  const withKey = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser", key: "ZZ" } }));
  const shape = (answer) => ({ ...answer, id: null, ref: null, hint: answer.hint.replace(/J-\d+/, "J-n").replace(/\(\d+ pending\)/, "(n pending)") });
  assert.deepEqual(shape(withKey), shape(without));
  assert.equal(Object.hasOwn(withKey, "origin"), false);
});

test("`queue add --origin <kind>:<ref>` records the origin and prints it on a line of its own; a malformed value is refused", async (t) => {
  const { env } = makeOriginHome(t, "origin-cli-add");
  await withProviders(originProviders(), async () => {
    const added = await runCli(env, ["queue", "add", "alpha", "fix", "the", "worker", "--origin", "tracker:42"]);
    assert.equal(added.code, 0, added.err.join("\n"));
    assert.ok(added.out.includes("origin: tracker 42 (connection: none)"), added.out.join("\n"));
    assert.deepEqual(jobView(getJob(1, env)).origin, { kind: "tracker", ref: "42" });

    const plain = await runCli(env, ["queue", "add", "alpha", "fix", "the", "parser"]);
    assert.equal(plain.out.some((line) => line.startsWith("origin:")), false);

    const malformed = await runCli(env, ["queue", "add", "alpha", "fix", "--origin", "tracker"]);
    assert.notEqual(malformed.code, 0);
    assert.match(malformed.err.join("\n"), /`--origin` expects <kind>:<ref>/);
    assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 2);

    const shown = await runCli(env, ["queue", "status", "J-1"]);
    assert.ok(shown.out.some((line) => /^origin\s+tracker 42$/.test(line)), shown.out.join("\n"));
  });
});
