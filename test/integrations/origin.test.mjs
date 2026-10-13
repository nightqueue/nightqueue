import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { loadConfig, loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { originCoverage } from "../../src/integrations/coverage.mjs";
import { detectOrigins, explicitOrigin, originInLink, originLabel, originsLabel, parseOriginsColumn, resolveOrigins } from "../../src/integrations/origin.mjs";
import { byRegistryOrder, withProviders } from "../../src/integrations/registry.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView, recordJobOrigins } from "../../src/memory/jobs.mjs";
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

test("detection collects every provider that recognizes the prompt, in registry order, and nothing matches nothing", async () => {
  await withProviders(originProviders(shadowProvider()), () => {
    assert.deepEqual(detectOrigins(PROMPT), [{ kind: "tracker", ref: "4507" }, { kind: "shadow", ref: "4507" }]);
    assert.deepEqual(detectOrigins("fix the worker J-86 and D-55"), []);
    assert.deepEqual(detectOrigins(null), []);
  });
  await withProviders([shadowProvider(), ...originProviders()], () => {
    assert.deepEqual(detectOrigins(PROMPT), [{ kind: "shadow", ref: "4507" }, { kind: "tracker", ref: "4507" }]);
  });
});

test("with the build's providers every recognised link of a prompt is an origin, one per kind and ref, and a bare KEY-n is no origin", () => {
  const linearUrl = "https://linear.app/acme/issue/MK-42/fix-the-login";
  const discordUrl = "https://discord.com/channels/111/222/555";
  const prompt = `see ${linearUrl}, ${discordUrl}, https://acme.sentry.io/issues/4507/ and again ${linearUrl} plus https://linear.app/acme/issue/mk-7`;
  assert.deepEqual(detectOrigins(prompt), [
    { kind: "sentry", ref: "4507" },
    { kind: "linear", ref: "MK-42" },
    { kind: "linear", ref: "MK-7" },
    { kind: "discord", ref: "111/222/555" },
  ]);
  assert.deepEqual(detectOrigins(`see ${linearUrl}`), [{ kind: "linear", ref: "MK-42" }]);
  assert.deepEqual(detectOrigins("fix MK-42, J-86 and D-55"), []);
});

test("links inside quoted comment threads are never origins, an unclosed thread hiding the rest of the text", () => {
  const quoted = "<comment-thread id=\"1\">see https://acme.sentry.io/issues/9/</comment-thread>";
  const prompt = `fix https://linear.app/acme/issue/MK-42 ${quoted} and https://discord.com/channels/1/2/3`;
  assert.deepEqual(detectOrigins(prompt), [{ kind: "linear", ref: "MK-42" }, { kind: "discord", ref: "1/2/3" }]);
  assert.deepEqual(detectOrigins("fix Linear MK-1 <COMMENT-THREAD>https://acme.sentry.io/issues/9/ and Linear MK-2"), [{ kind: "linear", ref: "MK-1" }]);
});

test("an opener never finished by `>` hides nothing, a closer with spaces ends its thread, and a thread after one is removed too", () => {
  assert.deepEqual(detectOrigins("<comment-thread https://linear.app/acme/issue/MK-7"), [{ kind: "linear", ref: "MK-7" }]);
  assert.deepEqual(detectOrigins("<comment-threads>x</comment-threads> https://linear.app/acme/issue/MK-8"), [{ kind: "linear", ref: "MK-8" }]);
  const twice = "<comment-thread>https://acme.sentry.io/issues/9/</comment-thread  > https://linear.app/acme/issue/MK-9 <comment-thread a>https://discord.com/channels/1/2/3</comment-thread>";
  assert.deepEqual(detectOrigins(twice), [{ kind: "linear", ref: "MK-9" }]);
});

test("detection over 600 KB of unterminated comment-thread openers stays linear", () => {
  for (const prompt of ["<comment-thread ".repeat(40000), "<comment-thread>".repeat(40000), "</comment-thread ".repeat(40000)]) {
    const started = performance.now();
    assert.deepEqual(detectOrigins(prompt), []);
    assert.ok(performance.now() - started < 500, `detection took ${Math.round(performance.now() - started)} ms`);
  }
});

test("queue_add covers a linear origin with the home's connection in a project with no integrations", async (t) => {
  const { env } = makeOriginHome(t, "origin-queue-add-linear");
  const client = await connectInProcess(t, env);
  const none = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it", origin: [{ kind: "linear", ref: "mk-42" }] } }));
  assert.deepEqual(none.origin, [{ kind: "linear", ref: "MK-42", connection: "none", detail: "no linear connection in the home" }]);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.lin = { type: "linear", apiKey: TRACKER_SECRET };
  saveSecrets(secrets, env);
  const covered = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it again", origin: [{ kind: "linear", ref: "MK-42" }] } }));
  assert.deepEqual(covered.origin, [{ kind: "linear", ref: "MK-42", connection: "lin" }]);
  assert.equal(JSON.stringify([none, covered]).includes(TRACKER_SECRET), false);
});

test("an empty list resolves to no origin whatever the prompt names; null or omitted still detects; another shape is refused", () => {
  const prompt = "Linear MK-9 crash";
  assert.deepEqual(resolveOrigins({ origin: [], prompt }), []);
  assert.deepEqual(resolveOrigins({ origin: null, prompt }), [{ kind: "linear", ref: "MK-9" }]);
  assert.deepEqual(resolveOrigins({ prompt }), [{ kind: "linear", ref: "MK-9" }]);
  assert.deepEqual(resolveOrigins({ origin: [{ kind: "linear", ref: "mk-9" }, { kind: "linear", ref: "MK-9" }], prompt }), [{ kind: "linear", ref: "MK-9" }]);
  assert.throws(() => resolveOrigins({ origin: false, prompt }), /`origin` is a list of \{kind, ref\}/);
  assert.throws(() => resolveOrigins({ origin: { kind: "linear", ref: "MK-9" }, prompt }), /`origin` is a list of \{kind, ref\}/);
  assert.throws(() => resolveOrigins({ origin: [{ kind: "linear", ref: "MK-9" }, { kind: "nope", ref: "1" }], prompt }), /unknown origin kind `nope`/);
});

test("queue_add detects a Discord thread link (guild/thread) pasted in the prompt as a discord origin", async (t) => {
  const { env } = makeOriginHome(t, "origin-queue-add-thread");
  const client = await connectInProcess(t, env);
  const prompt = "the bot crashes, see https://discord.com/channels/111/222";
  const added = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt } }));
  assert.deepEqual(jobView(getJob(added.id, env)).origin, [{ kind: "discord", ref: "111/222" }]);
});

test("queue_add with origin [] stores no origin; omitted or null detects it; an object, false or true is an older client", async (t) => {
  const { env } = makeOriginHome(t, "origin-queue-add-false");
  const client = await connectInProcess(t, env);
  const prompt = "Linear MK-9 crash";
  const cleared = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt, origin: [] } }));
  assert.deepEqual(cleared.origin, []);
  assert.equal(getJob(cleared.id, env).origin, null);
  const omitted = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt } }));
  assert.deepEqual(jobView(getJob(omitted.id, env)).origin, [{ kind: "linear", ref: "MK-9" }]);
  const nulled = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt, origin: null } }));
  assert.deepEqual(jobView(getJob(nulled.id, env)).origin, [{ kind: "linear", ref: "MK-9" }]);
  for (const origin of [false, true, { kind: "linear", ref: "MK-9" }]) {
    const refused = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt, origin } });
    assert.equal(refused.isError, true, JSON.stringify(origin));
    assert.match(refused.content[0].text, /your client has the tool definitions of an older nightqueue \(contract 6, this server is 7\)/);
  }
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 3);
});

test("queue_add with two origins answers the coverage of each and names both in the hint", async (t) => {
  const { env } = makeOriginHome(t, "origin-queue-add-two");
  const client = await connectInProcess(t, env);
  const origin = [{ kind: "linear", ref: "MK-1" }, { kind: "discord", ref: "1/2/3" }];
  const answer = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it", origin } }));
  assert.equal(answer.origin.length, 2);
  assert.deepEqual(answer.origin.map(({ kind, ref }) => `${kind} ${ref}`), ["linear MK-1", "discord 1/2/3"]);
  assert.match(answer.hint, /Origins: linear MK-1 \(connection: none\); discord 1\/2\/3 \(connection: none\)\./);
  assert.deepEqual(jobView(getJob(answer.id, env)).origin, origin);
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
    const explicit = addJob({ projectId, prompt: PROMPT, origin: [{ kind: "tracker", ref: "42" }] }, env);
    const detected = addJob({ projectId, prompt: PROMPT, origin: null }, env);
    const plain = addJob({ projectId, prompt: "fix the worker" }, env);
    assert.deepEqual([explicit.origin, detected.origin, plain.origin], [[{ kind: "tracker", ref: "42" }], [{ kind: "tracker", ref: "4507" }], []]);
    assert.equal(getJob(explicit.id, env).origin, JSON.stringify([{ kind: "tracker", ref: "42" }]));
    assert.deepEqual(jobView(getJob(explicit.id, env)).origin, [{ kind: "tracker", ref: "42" }]);
    assert.deepEqual(jobView(getJob(detected.id, env)).origin, [{ kind: "tracker", ref: "4507" }]);
    assert.deepEqual(jobView(getJob(plain.id, env)).origin, []);
    assert.equal(getJob(plain.id, env).origin, null);
  });
});

test("an invalid explicit origin is refused before any job row is written", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-add-refused");
  await withProviders(originProviders(), () => {
    assert.throws(() => addJob({ projectId, prompt: PROMPT, origin: [{ kind: "tracker", ref: "1" }, { kind: "nope", ref: "1" }] }, env), /unknown origin kind `nope`/);
    assert.throws(() => addJob({ projectId, prompt: PROMPT, origin: { kind: "tracker", ref: "1" } }, env), /`origin` is a list/);
  });
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("the origin column reads only as a list: an object, malformed text or a bad element is no origin", () => {
  assert.deepEqual(parseOriginsColumn("{broken"), []);
  assert.deepEqual(parseOriginsColumn(JSON.stringify({ kind: "tracker", ref: "1" })), []);
  assert.deepEqual(parseOriginsColumn(JSON.stringify([{ kind: "tracker" }, { kind: "", ref: "2" }, { kind: "tracker", ref: "3" }, { kind: "tracker", ref: "3" }, 7])), [{ kind: "tracker", ref: "3" }]);
  assert.deepEqual(parseOriginsColumn(undefined), []);
  assert.deepEqual(parseOriginsColumn(42), []);
});

test("a link names the origin of the first other provider that recognizes it, and the labels join every origin", () => {
  assert.deepEqual(originInLink("https://discord.com/channels/1/2/3", { exclude: "linear" }), { kind: "discord", ref: "1/2/3" });
  assert.deepEqual(originInLink("https://acme.sentry.io/issues/4507/", { exclude: "linear" }), { kind: "sentry", ref: "4507" });
  assert.equal(originInLink("https://linear.app/acme/issue/MK-1", { exclude: "linear" }), null);
  assert.equal(originInLink("https://github.com/acme/app/pull/3", { exclude: "linear" }), null);
  assert.equal(originInLink(null), null);
  assert.equal(originsLabel([{ kind: "linear", ref: "MK-1" }, { kind: "discord", ref: "1/2/3" }]), "linear MK-1, discord 1/2/3");
  assert.equal(originsLabel([]), "");
});

test("origins sort by registry order, keeping the given order within a kind and unknown kinds last", () => {
  const origins = [
    { kind: "discord", ref: "1/2/3" },
    { kind: "mystery", ref: "x" },
    { kind: "linear", ref: "MK-2" },
    { kind: "sentry", ref: "9" },
    { kind: "linear", ref: "MK-1" },
  ];
  assert.deepEqual(byRegistryOrder(origins).map(originLabel), ["sentry 9", "linear MK-2", "linear MK-1", "discord 1/2/3", "mystery x"]);
  assert.deepEqual(byRegistryOrder(null), []);
});

test("recordJobOrigins writes the list back only for the running job of that worker", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-record");
  const job = addJob({ projectId, prompt: "fix it", origin: [{ kind: "linear", ref: "MK-1" }] }, env);
  const origins = [{ kind: "linear", ref: "MK-1" }, { kind: "discord", ref: "1/2/3" }];
  assert.equal(recordJobOrigins(job.id, { worker: "w1", origins }, env), false);
  openDb(env).prepare("UPDATE jobs SET status = 'running', worker = 'w1' WHERE id = ?").run(job.id);
  assert.equal(recordJobOrigins(job.id, { worker: "w2", origins }, env), false);
  assert.deepEqual(jobView(getJob(job.id, env)).origin, [{ kind: "linear", ref: "MK-1" }]);
  assert.equal(recordJobOrigins(job.id, { worker: "w1", origins }, env), true);
  assert.deepEqual(jobView(getJob(job.id, env)).origin, origins);
  assert.throws(() => recordJobOrigins(job.id, { worker: "w1", origins: [{ kind: "linear" }] }, env), /must be a list of \{kind, ref\}/);
  assert.throws(() => recordJobOrigins(job.id, { worker: "w1", origins: { kind: "linear", ref: "MK-1" } }, env), /must be a list of \{kind, ref\}/);
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

test("queue_add answers each origin with its covering connection, and an empty list when the job has none", async (t) => {
  const { env, projectId } = makeOriginHome(t, "origin-queue-add");
  setIntegrations(env, projectId, { tracker: { enabled: true } });
  bindTrackerConnection(env, projectId);
  const client = await connectInProcess(t, env);
  await withProviders(originProviders(), async () => {
    const detected = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT } }));
    assert.deepEqual(detected.origin, [{ kind: "tracker", ref: "4507", connection: "trk" }]);
    assert.match(detected.hint, /\(1 pending\)\. Origins: tracker 4507 \(connection: trk\)\. /);
    const explicit = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix it", origin: [{ kind: "tracker", ref: "12" }] } }));
    assert.deepEqual(explicit.origin, [{ kind: "tracker", ref: "12", connection: "trk" }]);
    const plain = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "fix the parser", origin: null } }));
    assert.deepEqual(plain.origin, []);
    assert.equal(plain.hint.includes("Origins:"), false);
    assert.equal(JSON.stringify([detected, explicit, plain]).includes(TRACKER_SECRET), false);
  });
});

test("queue_add answers `none` with the reason for a project that did not enable the provider, and refuses an invalid origin", async (t) => {
  const { env } = makeOriginHome(t, "origin-queue-add-none");
  const client = await connectInProcess(t, env);
  await withProviders(originProviders(), async () => {
    const answer = payloadOf(await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: PROMPT } }));
    assert.deepEqual(answer.origin, [{ kind: "tracker", ref: "4507", connection: "none", detail: "project has no tracker integration" }]);
    const refused = await client.callTool({ name: "queue_add", arguments: { project: "alpha", prompt: "x", origin: [{ kind: "tracker", ref: "abc" }] } });
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
  assert.deepEqual(withKey.origin, []);
});

test("`queue add --origin <kind>:<ref>` is repeatable, prints one line per origin, and a malformed value is refused", async (t) => {
  const { env } = makeOriginHome(t, "origin-cli-add");
  await withProviders(originProviders(shadowProvider()), async () => {
    const added = await runCli(env, ["queue", "add", "alpha", "fix", "the", "worker", "--origin", "tracker:42", "--origin", "shadow:https://tracker.example/issues/7"]);
    assert.equal(added.code, 0, added.err.join("\n"));
    assert.ok(added.out.includes("origin: tracker 42 (connection: none)"), added.out.join("\n"));
    assert.ok(added.out.includes("origin: shadow 7 (connection: none)"), added.out.join("\n"));
    assert.deepEqual(jobView(getJob(1, env)).origin, [{ kind: "tracker", ref: "42" }, { kind: "shadow", ref: "7" }]);

    const plain = await runCli(env, ["queue", "add", "alpha", "fix", "the", "parser"]);
    assert.equal(plain.out.some((line) => line.startsWith("origin:")), false);

    const malformed = await runCli(env, ["queue", "add", "alpha", "fix", "--origin", "tracker:1", "--origin", "tracker"]);
    assert.notEqual(malformed.code, 0);
    assert.match(malformed.err.join("\n"), /`--origin` expects <kind>:<ref>/);
    assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 2);

    const shown = await runCli(env, ["queue", "status", "J-1"]);
    assert.ok(shown.out.some((line) => /^origin\s+tracker 42, shadow 7$/.test(line)), shown.out.join("\n"));
    const none = await runCli(env, ["queue", "status", "J-2"]);
    assert.equal(none.out.some((line) => /^origin\s/.test(line)), false, none.out.join("\n"));
  });
});
