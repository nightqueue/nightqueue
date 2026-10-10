import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lockPath } from "../../src/config/lock.mjs";
import { configPath, secretsPath } from "../../src/config/paths.mjs";
import { loadConfig, loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { openStore } from "../../src/store/open.mjs";
import { isolatedHostVars } from "../../test-support/host.mjs";
import { ensureProject, makeDir, makeHome, orgIdOf } from "../../test-support/memory.mjs";
import { setIntegrations } from "../../test-support/origin-provider.mjs";
import { send, startStudio, studioCookie } from "../../test-support/studio.mjs";

const QUIET = { warn: () => {} };
const TOKEN = "dlwWebhookSecretToken-0123456789";
const WEBHOOK = `https://discord.com/api/webhooks/9001/${TOKEN}`;
const CHANNEL = "222222222";
const SERVER = "111111111";
const LINKED = { discord: { log: { connection: "dlw-log", events: ["closed"] } } };

// A simulated Discord recording every call: the webhook GET and the announce POST answer the statuses it is set to.
function fakeDiscord() {
  const fake = { calls: [], getStatus: 200, postStatus: 200 };
  fake.impl = async (url, options) => {
    const method = options?.method ?? "GET";
    fake.calls.push({ method, url, body: options?.body ? JSON.parse(options.body) : null });
    const known = url === WEBHOOK || url === `${WEBHOOK}?wait=true`;
    const status = !known ? 404 : method === "GET" ? fake.getStatus : fake.postStatus;
    const body = method === "GET" ? { id: "9001", channel_id: CHANNEL, guild_id: SERVER, name: "dlw-hook", token: TOKEN } : { id: "1" };
    return { status, headers: new Map(), json: async () => body };
  };
  return fake;
}

// A home with projects a1, a2 in org dlw and c1 in org clareza, and a studio on it talking to a simulated Discord.
async function integrationsHome(t, name, { env: extraEnv = {}, fetchImpl } = {}) {
  const env = makeHome(t, name);
  const ids = { a1: ensureProject(env, "a1", { org: "dlw" }), a2: ensureProject(env, "a2", { org: "dlw" }), c1: ensureProject(env, "c1", { org: "clareza" }) };
  const discord = fakeDiscord();
  const studio = await startStudio(t, { ...env, ...extraEnv }, { fetchImpl: fetchImpl ?? discord.impl });
  const answers = [];
  const call = async (method, path, body) => {
    const headers = { cookie: studioCookie(studio.port), origin: studio.origin, "content-type": "application/json" };
    const answer = await send(studio.port, { method, path, headers, body: body === undefined ? null : JSON.stringify(body) });
    answers.push(answer.body);
    return { status: answer.status, body: answer.body ? JSON.parse(answer.body) : null };
  };
  return { env, ids, discord, call, answers, store: openStore(env) };
}

// Adds the Discord connection `dlw-log` for org dlw through the studio, asserting it was created.
async function addDlwLog(home) {
  const added = await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: WEBHOOK });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  return added.body.connection;
}

// The integrations of a project straight from the registry.
function integrationsOf(home, id) {
  return home.store.projects.integrations(id);
}

// Captures what the process writes to stderr while one async step runs.
async function stderrDuring(step) {
  const written = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return write.call(process.stderr, chunk, ...rest);
  };
  try {
    return { result: await step(), stderr: written.join("") };
  } finally {
    process.stderr.write = write;
  }
}

test("an add reads the webhook, posts one connected message, stores it bound to the org, and the view shows its ids and test", async (t) => {
  const home = await integrationsHome(t, "integrations-add");
  const connection = await addDlwLog(home);
  assert.deepEqual(home.discord.calls.map((call) => [call.method, call.url]), [["GET", WEBHOOK], ["POST", `${WEBHOOK}?wait=true`]]);
  assert.equal(home.discord.calls[1].body.embeds[0].title, "nightqueue connected");
  assert.deepEqual(home.discord.calls[1].body.allowed_mentions, { parse: [] });
  const expected = { id: "dlw-log", name: "dlw-log", type: "discord", present: true, scope: "org", orgs: ["dlw"], usedBy: [], channelId: CHANNEL, serverId: SERVER, webhookName: "dlw-hook" };
  const { lastTest, ...rest } = connection;
  assert.deepEqual(rest, expected);
  assert.deepEqual([lastTest.ok, lastTest.status, typeof lastTest.at], [true, 200, "string"]);
  const view = await home.call("GET", "/api/integrations");
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.connections, [connection]);
  assert.deepEqual(view.body.orgs.map((org) => [org.name, org.projects]).filter(([name]) => name !== "default"), [["dlw", 2], ["clareza", 1]]);
  assert.deepEqual(view.body.projects.map((project) => [project.name, project.org, project.destination, project.lastNotice]), [["a1", "dlw", null, null], ["a2", "dlw", null, null], ["c1", "clareza", null, null]]);
  assert.equal(loadSecrets(home.env, QUIET).connections["dlw-log"].url, WEBHOOK);
  assert.deepEqual(loadConfig(home.env, QUIET).orgConnections[orgIdOf(home.env, "dlw")].discord, ["dlw-log"]);
});

test("an invalid URL is a 422 before Discord is asked, and the secrets file stays byte-identical or absent", async (t) => {
  const home = await integrationsHome(t, "integrations-invalid");
  for (const url of ["", "https://example.com/api/webhooks/1/x", `${WEBHOOK}${"x".repeat(512)}`, 42]) {
    const answer = await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url });
    assert.equal(answer.status, 422, JSON.stringify(answer.body));
    assert.equal(answer.body.code, "invalid-url");
    assert.match(answer.body.error, /Nothing was saved\.$/);
  }
  assert.equal(existsSync(secretsPath(home.env)), false);
  saveSecrets({ version: 1, connections: { gh: { type: "github", token: "ghp_x" } } }, home.env);
  const before = readFileSync(secretsPath(home.env));
  assert.equal((await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: "not a url" })).status, 422);
  assert.deepEqual(readFileSync(secretsPath(home.env)), before);
  assert.equal(home.discord.calls.length, 0);
});

test("a webhook Discord refuses, on the read or on the announce, is a 502 with its reason and stores nothing", async (t) => {
  const home = await integrationsHome(t, "integrations-refused");
  home.discord.getStatus = 404;
  const read = await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: WEBHOOK });
  assert.deepEqual([read.status, read.body.code, read.body.status, read.body.reason], [502, "refused", 404, "Discord answered 404: the webhook was deleted on the server."]);
  assert.deepEqual(home.discord.calls.map((call) => call.method), ["GET"]);
  home.discord.getStatus = 200;
  home.discord.postStatus = 403;
  const announce = await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: WEBHOOK });
  assert.deepEqual([announce.status, announce.body.code, announce.body.status], [502, "refused", 403]);
  assert.match(announce.body.error, /Nothing was saved\.$/);
  assert.equal(existsSync(secretsPath(home.env)), false);
  assert.equal(loadConfig(home.env, QUIET).orgConnections[orgIdOf(home.env, "dlw")]?.discord ?? null, null);
});

test("a duplicate name is a 409 naming the orgs that use it, before Discord is asked", async (t) => {
  const home = await integrationsHome(t, "integrations-duplicate");
  await addDlwLog(home);
  const calls = home.discord.calls.length;
  const again = await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "clareza", url: WEBHOOK });
  assert.deepEqual([again.status, again.body.code, again.body.orgs], [409, "duplicate", ["dlw"]]);
  assert.equal(home.discord.calls.length, calls);
  const unknownOrg = await home.call("POST", "/api/integrations/discord", { name: "other", org: "nope", url: WEBHOOK });
  assert.equal(unknownOrg.status, 400);
});

test("a batch link sets every project's destination, a not-allowed org is a 403 that allow-then-set resolves", async (t) => {
  const home = await integrationsHome(t, "integrations-link");
  const { a1, a2, c1 } = home.ids;
  await addDlwLog(home);
  const mixed = await home.call("POST", "/api/integrations/dlw-log/link", { projectIds: [a1, c1] });
  assert.deepEqual([mixed.status, mixed.body.code, mixed.body.org], [403, "not-allowed-for-org", "clareza"]);
  assert.equal(await integrationsOf(home, a1), null, "a refused batch wrote a project");
  const linked = await home.call("POST", "/api/integrations/dlw-log/link", { projectIds: [a1, a2] });
  assert.deepEqual([linked.status, linked.body], [200, { linked: [a1, a2], unchanged: [] }]);
  assert.deepEqual([await integrationsOf(home, a1), await integrationsOf(home, a2)], [LINKED, LINKED]);
  const view = (await home.call("GET", "/api/integrations")).body;
  assert.deepEqual(view.projects.map((project) => project.destination), ["dlw-log", "dlw-log", null]);
  assert.deepEqual(view.connections[0].usedBy, [a1, a2]);

  const refused = await home.call("PUT", `/api/projects/${c1}/destination`, { connectionId: "dlw-log" });
  assert.equal(refused.status, 403);
  assert.deepEqual({ code: refused.body.code, org: refused.body.org, connectionId: refused.body.connectionId, projectId: refused.body.projectId }, { code: "not-allowed-for-org", org: "clareza", connectionId: "dlw-log", projectId: c1 });
  assert.equal(await integrationsOf(home, c1), null);
  assert.equal((await home.call("POST", "/api/integrations/dlw-log/orgs", { org: "clareza" })).status, 200);
  const set = await home.call("PUT", `/api/projects/${c1}/destination`, { connectionId: "dlw-log" });
  assert.deepEqual([set.status, set.body], [200, { project: c1, destination: "dlw-log" }]);
  const cleared = await home.call("PUT", `/api/projects/${c1}/destination`, { connectionId: null });
  assert.deepEqual([cleared.status, cleared.body], [200, { project: c1, destination: null }]);
  assert.equal(await integrationsOf(home, c1), null);
});

test("unknown targets and malformed bodies are refused without a write", async (t) => {
  const home = await integrationsHome(t, "integrations-bad-input");
  const { a1 } = home.ids;
  await addDlwLog(home);
  assert.equal((await home.call("PUT", "/api/projects/01J9Z00000000000000000000Z/destination", { connectionId: "dlw-log" })).status, 404);
  assert.equal((await home.call("PUT", `/api/projects/${a1}/destination`, { connectionId: "ghost" })).status, 404);
  assert.equal((await home.call("PUT", `/api/projects/${a1}/destination`, { connectionId: 7 })).status, 400);
  assert.equal((await home.call("POST", "/api/integrations/ghost/link", { projectIds: [a1] })).status, 404);
  assert.equal((await home.call("POST", "/api/integrations/dlw-log/link", { projectIds: [] })).status, 400);
  assert.equal((await home.call("POST", "/api/integrations/dlw-log/link", { projectIds: [a1, 3] })).status, 400);
  assert.equal((await home.call("DELETE", "/api/integrations/ghost")).status, 404);
  assert.equal((await home.call("POST", "/api/integrations/ghost/test", {})).status, 404);
  assert.equal((await home.call("DELETE", "/api/integrations/%E0%A4%A")).status, 400);
  assert.equal(await integrationsOf(home, a1), null);
});

test("a remove in use is a 409 naming the projects, and ?unlink=1 unlinks them and removes the connection", async (t) => {
  const home = await integrationsHome(t, "integrations-remove");
  const { a1, a2 } = home.ids;
  await addDlwLog(home);
  await home.call("POST", "/api/integrations/dlw-log/link", { projectIds: [a1, a2] });
  const refused = await home.call("DELETE", "/api/integrations/dlw-log");
  assert.deepEqual([refused.status, refused.body.code, refused.body.usedBy], [409, "in-use", [{ id: a1, name: "a1" }, { id: a2, name: "a2" }]]);
  assert.deepEqual(await integrationsOf(home, a1), LINKED);
  const removed = await home.call("DELETE", "/api/integrations/dlw-log?unlink=1");
  assert.deepEqual([removed.status, removed.body], [200, { removed: "dlw-log", unlinked: [a1, a2] }]);
  assert.deepEqual([await integrationsOf(home, a1), await integrationsOf(home, a2)], [null, null]);
  assert.equal(loadSecrets(home.env, QUIET).connections["dlw-log"], undefined);
  const view = await home.call("GET", "/api/integrations");
  assert.deepEqual([view.status, view.body.connections, view.body.projects.map((project) => project.destination)], [200, [], [null, null, null]]);
  assert.equal((await home.call("POST", "/api/queue/pause", {})).status, 200, "the lock was not released after the refusal");
});

test("taking an org away from a connection is a 409 while its projects use it, and ?unlink=1 unlinks only that org", async (t) => {
  const home = await integrationsHome(t, "integrations-remove-org");
  const { a1, c1 } = home.ids;
  await addDlwLog(home);
  await home.call("POST", "/api/integrations/dlw-log/orgs", { org: "clareza" });
  await home.call("POST", "/api/integrations/dlw-log/link", { projectIds: [a1, c1] });
  const refused = await home.call("DELETE", "/api/integrations/dlw-log/orgs/clareza");
  assert.deepEqual([refused.status, refused.body.code, refused.body.usedBy], [409, "in-use", [{ id: c1, name: "c1" }]]);
  const removed = await home.call("DELETE", "/api/integrations/dlw-log/orgs/clareza?unlink=1");
  assert.deepEqual([removed.status, removed.body], [200, { connection: "dlw-log", org: "clareza", unlinked: [c1] }]);
  assert.deepEqual([await integrationsOf(home, a1), await integrationsOf(home, c1)], [LINKED, null]);
  const view = (await home.call("GET", "/api/integrations")).body;
  assert.deepEqual(view.connections[0].orgs, ["dlw"]);
});

test("a test records its outcome on the connection; a failed test is a 200 with the reason", async (t) => {
  const home = await integrationsHome(t, "integrations-test");
  await addDlwLog(home);
  const ok = await home.call("POST", "/api/integrations/dlw-log/test", {});
  assert.deepEqual([ok.status, ok.body.ok, ok.body.status], [200, true, 200]);
  assert.equal(home.discord.calls.filter((call) => call.method === "POST").length, 1, "a test posted to the channel");
  home.discord.getStatus = 404;
  const failed = await home.call("POST", "/api/integrations/dlw-log/test", {});
  assert.deepEqual([failed.status, failed.body.ok, failed.body.status, failed.body.reason], [200, false, 404, "Discord answered 404: the webhook was deleted on the server."]);
  const view = (await home.call("GET", "/api/integrations")).body;
  assert.deepEqual([view.connections[0].lastTest.ok, view.connections[0].lastTest.reason], [false, failed.body.reason]);
});

test("a test still in flight when its connection is removed and added again does not write its outcome on the new one", async (t) => {
  const OTHER = "https://discord.com/api/webhooks/9002/otherWebhookToken-0123456789";
  const gate = { held: null, open: null };
  const fetchImpl = async (url, options) => {
    const method = options?.method ?? "GET";
    const old = String(url).startsWith(WEBHOOK);
    if (old && gate.held && method === "GET") {
      await gate.held;
      return { status: 404, headers: new Map(), json: async () => ({}) };
    }
    const body = method === "GET" ? { id: old ? "9001" : "9002", channel_id: CHANNEL, guild_id: SERVER, name: "hook", token: "x" } : { id: "1" };
    return { status: 200, headers: new Map(), json: async () => body };
  };
  const home = await integrationsHome(t, "integrations-test-stale", { fetchImpl });
  await addDlwLog(home);
  gate.held = new Promise((resolve) => (gate.open = resolve));
  const testing = home.call("POST", "/api/integrations/dlw-log/test", {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await home.call("DELETE", "/api/integrations/dlw-log")).status, 200);
  const readded = await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: OTHER });
  assert.equal(readded.status, 201, JSON.stringify(readded.body));
  gate.open();
  const stale = await testing;
  assert.deepEqual([stale.status, stale.body.ok], [200, false]);
  const view = (await home.call("GET", "/api/integrations")).body;
  assert.equal(view.connections[0].lastTest.ok, true, JSON.stringify(view.connections[0].lastTest));
});

test("two parallel adds of one name post the connected message once: one is created, the other is a 409", async (t) => {
  const gate = { reads: 0, open: null };
  const held = new Promise((resolve) => (gate.open = resolve));
  const discord = fakeDiscord();
  const fetchImpl = async (url, options) => {
    if ((options?.method ?? "GET") === "GET") {
      gate.reads += 1;
      if (gate.reads === 2) gate.open();
      await held;
    }
    return await discord.impl(url, options);
  };
  const home = await integrationsHome(t, "integrations-add-race", { fetchImpl });
  const body = { name: "dlw-log", org: "dlw", url: WEBHOOK };
  const answers = await Promise.all([home.call("POST", "/api/integrations/discord", body), home.call("POST", "/api/integrations/discord", body)]);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 409]);
  assert.equal(discord.calls.filter((call) => call.method === "POST").length, 1);
});

test("a busy configuration lock refuses an add before the connected message, saying nothing was saved", { timeout: 30000 }, async (t) => {
  const home = await integrationsHome(t, "integrations-add-locked");
  const lock = lockPath(home.env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), String(process.pid));
  t.after(() => rmSync(lock, { recursive: true, force: true }));
  const refused = await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: WEBHOOK });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /Nothing was saved\.$/);
  assert.equal(home.discord.calls.filter((call) => call.method === "POST").length, 0);
  assert.equal(existsSync(secretsPath(home.env)), false);
});

test("the webhook URL and its token never reach an answer or stderr, across add, view, test, link and remove", async (t) => {
  const home = await integrationsHome(t, "integrations-leak");
  const { stderr } = await stderrDuring(async () => {
    await addDlwLog(home);
    await home.call("POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: WEBHOOK });
    await home.call("GET", "/api/integrations");
    await home.call("POST", "/api/integrations/dlw-log/test", {});
    home.discord.getStatus = 500;
    await home.call("POST", "/api/integrations/dlw-log/test", {});
    await home.call("POST", "/api/integrations/discord", { name: "other", org: "dlw", url: WEBHOOK });
    await home.call("POST", "/api/integrations/dlw-log/link", { projectIds: [home.ids.a1, home.ids.c1] });
    await home.call("DELETE", "/api/integrations/dlw-log");
    await home.call("DELETE", "/api/integrations/dlw-log?unlink=1");
    await home.call("GET", "/api/integrations");
  });
  assert.equal(home.answers.length, 10);
  for (const text of [...home.answers, stderr]) {
    assert.ok(!text.includes(TOKEN) && !text.includes("webhooks/9001"), `the webhook leaked: ${text.slice(0, 200)}`);
  }
});

test("a dangling destination left in a project, or a fresh home, still gets a view", async (t) => {
  const home = await integrationsHome(t, "integrations-dangling");
  setIntegrations(home.env, home.ids.a1, { discord: { log: { connection: "ghost", events: ["closed"] } } });
  const view = await home.call("GET", "/api/integrations");
  assert.equal(view.status, 200);
  assert.equal(view.body.projects[0].destination, "ghost");
  assert.deepEqual((await home.call("PUT", `/api/projects/${home.ids.a1}/destination`, { connectionId: null })).body, { project: home.ids.a1, destination: null });

  const bare = makeHome(t, "integrations-no-db");
  const studio = await startStudio(t, bare, { fetchImpl: fakeDiscord().impl });
  const answer = await send(studio.port, { path: "/api/integrations", headers: { cookie: studioCookie(studio.port) } });
  assert.equal(answer.status, 200);
  const empty = JSON.parse(answer.body);
  assert.deepEqual([empty.connections, empty.projects], [[], []]);
});

test("inside a job every write is refused before Discord or the files are touched, and the view still reads", async (t) => {
  const home = makeHome(t, "integrations-job");
  const a1 = ensureProject(home, "a1", { org: "dlw" });
  const jobEnv = { NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_JOB_HOME: home.NIGHTQUEUE_HOME };
  const discord = fakeDiscord();
  const studio = await startStudio(t, { ...home, ...jobEnv }, { fetchImpl: discord.impl });
  const headers = { cookie: studioCookie(studio.port), origin: studio.origin, "content-type": "application/json" };
  const writes = [
    ["POST", "/api/integrations/discord", { name: "dlw-log", org: "dlw", url: WEBHOOK }],
    ["POST", "/api/integrations/dlw-log/test", {}],
    ["POST", "/api/integrations/dlw-log/orgs", { org: "dlw" }],
    ["DELETE", "/api/integrations/dlw-log/orgs/dlw?unlink=1", undefined],
    ["DELETE", "/api/integrations/dlw-log?unlink=1", undefined],
    ["POST", "/api/integrations/dlw-log/link", { projectIds: [a1] }],
    ["PUT", `/api/projects/${a1}/destination`, { connectionId: null }],
  ];
  for (const [method, path, body] of writes) {
    const answer = await send(studio.port, { method, path, headers, body: body === undefined ? null : JSON.stringify(body) });
    assert.equal(answer.status, 400, `${method} ${path} answered ${answer.status}: ${answer.body}`);
    assert.match(answer.body, /refused: /);
  }
  assert.equal(discord.calls.length, 0);
  assert.equal(existsSync(secretsPath(home)), false);
  assert.equal((await send(studio.port, { path: "/api/integrations", headers })).status, 200);
});

test("a cookie write to the integrations without the studio's Origin is refused", async (t) => {
  const home = await integrationsHome(t, "integrations-origin");
  const studio = await startStudio(t, home.env, { fetchImpl: home.discord.impl });
  const body = JSON.stringify({ name: "dlw-log", org: "dlw", url: WEBHOOK });
  const noOrigin = await send(studio.port, { method: "POST", path: "/api/integrations/discord", body, headers: { cookie: studioCookie(studio.port), "content-type": "application/json" } });
  assert.equal(noOrigin.status, 403);
  assert.equal(home.discord.calls.length, 0);
});

const LINEAR_KEY = "lin_api_secretKey0123456789";
const SENTRY_TOKEN = "sntrys_secretToken0123456789";

// A simulated Linear and Sentry: Linear accepts only LINEAR_KEY, Sentry answers the org slug of any token it is set to accept.
function fakeServices() {
  const fake = { calls: [], sentryStatus: 200 };
  fake.impl = async (url, options) => {
    const auth = options?.headers?.Authorization ?? options?.headers?.authorization ?? null;
    fake.calls.push(String(url));
    if (String(url).includes("linear.app")) {
      const ok = auth === LINEAR_KEY;
      return { status: ok ? 200 : 401, headers: new Map(), json: async () => ({ data: { viewer: { name: "Ana" } } }) };
    }
    if (String(url).includes("sentry.io")) return { status: fake.sentryStatus, headers: new Map(), json: async () => ({ slug: "acme" }) };
    return { status: 404, headers: new Map(), json: async () => ({}) };
  };
  return fake;
}

// The bytes of config.json and secrets.json, null for a file that does not exist.
function filesOf(env) {
  return [configPath(env), secretsPath(env)].map((path) => (existsSync(path) ? readFileSync(path, "utf8") : null));
}

test("with zero connections the view answers the four module cards in GitHub, Linear, Sentry, Discord order", async (t) => {
  const home = await integrationsHome(t, "integrations-modules");
  const view = await home.call("GET", "/api/integrations");
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.connections, []);
  assert.deepEqual(view.body.modules.map((module) => [module.kind, module.place]), [["github", "machine"], ["linear", "home"], ["sentry", "org"], ["discord", "org"]]);
  assert.deepEqual(view.body.modules[0].ambient, { statusPath: "/api/integrations/github/status", command: "gh auth login --web" });
});

test("an add of a kind read from the machine is a 409, an unknown kind a 404, and neither writes", async (t) => {
  const home = await integrationsHome(t, "integrations-kinds");
  const github = await home.call("POST", "/api/integrations/github", { token: "ghp_x" });
  assert.deepEqual([github.status, github.body.code], [409, "ambient"]);
  assert.match(github.body.error, /gh auth login/);
  assert.equal((await home.call("POST", "/api/integrations/jira", { token: "x" })).status, 404);
  assert.deepEqual(filesOf(home.env), [null, null]);
});

test("a Linear add stores one home-wide connection with its test; a second is a 409 and a refused key a 502, both writing nothing", async (t) => {
  const services = fakeServices();
  const home = await integrationsHome(t, "integrations-linear", { fetchImpl: services.impl });
  const refused = await home.call("POST", "/api/integrations/linear", { apiKey: "lin_api_wrong" });
  assert.deepEqual([refused.status, refused.body.code, refused.body.status], [502, "refused", 401]);
  assert.deepEqual(filesOf(home.env), [null, null]);
  const added = await home.call("POST", "/api/integrations/linear", { apiKey: LINEAR_KEY });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([added.body.connection.name, added.body.connection.type, added.body.connection.scope, added.body.connection.lastTest.ok], ["linear", "linear", "home", true]);
  assert.equal(loadSecrets(home.env, QUIET).connections.linear.apiKey, LINEAR_KEY);
  const before = filesOf(home.env);
  const again = await home.call("POST", "/api/integrations/linear", { name: "linear-two", apiKey: LINEAR_KEY });
  assert.deepEqual([again.status, again.body.code], [409, "duplicate"]);
  assert.equal((await home.call("POST", "/api/integrations/linear", { apiKey: LINEAR_KEY, org: "dlw" })).status, 400);
  assert.deepEqual(filesOf(home.env), before);
});

test("a Sentry add fills an empty org slot; a second one for that org is a 409 naming the bound connection and writing nothing", async (t) => {
  const services = fakeServices();
  const home = await integrationsHome(t, "integrations-sentry", { fetchImpl: services.impl });
  const added = await home.call("POST", "/api/integrations/sentry", { org: "dlw", token: SENTRY_TOKEN, extra: { org: "acme" } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual([added.body.connection.name, added.body.connection.orgs], ["sentry-dlw", ["dlw"]]);
  assert.equal(loadConfig(home.env, QUIET).orgConnections[orgIdOf(home.env, "dlw")].sentry, "sentry-dlw");
  assert.equal(loadSecrets(home.env, QUIET).connections["sentry-dlw"].org, "acme");
  const before = filesOf(home.env);
  const occupied = await home.call("POST", "/api/integrations/sentry", { name: "sentry-two", org: "dlw", token: SENTRY_TOKEN, extra: { org: "acme" } });
  assert.deepEqual([occupied.status, occupied.body.code, occupied.body.connection], [409, "occupied", "sentry-dlw"]);
  assert.match(occupied.body.error, /sentry-dlw/);
  assert.equal((await home.call("POST", "/api/integrations/sentry", { name: "sentry-x", org: "clareza", token: SENTRY_TOKEN })).status, 400);
  assert.equal((await home.call("POST", "/api/integrations/sentry", { name: "sentry-y", org: "clareza", token: "", extra: { org: "acme" } })).body.code, "invalid-token");
  assert.deepEqual(filesOf(home.env), before);
});

test("no answer of a Linear or Sentry add, accepted or refused, carries the submitted secret", async (t) => {
  const services = fakeServices();
  const home = await integrationsHome(t, "integrations-secret-leak", { fetchImpl: services.impl });
  await home.call("POST", "/api/integrations/linear", { apiKey: LINEAR_KEY });
  await home.call("POST", "/api/integrations/linear", { apiKey: LINEAR_KEY });
  await home.call("POST", "/api/integrations/sentry", { org: "dlw", token: SENTRY_TOKEN, extra: { org: "acme" } });
  await home.call("POST", "/api/integrations/sentry", { name: "s2", org: "dlw", token: SENTRY_TOKEN, extra: { org: "acme" } });
  services.sentryStatus = 401;
  await home.call("POST", "/api/integrations/sentry", { org: "clareza", token: SENTRY_TOKEN, extra: { org: "acme" } });
  await home.call("GET", "/api/integrations");
  for (const text of home.answers) assert.ok(!text.includes(LINEAR_KEY) && !text.includes(SENTRY_TOKEN), `a secret leaked: ${text.slice(0, 200)}`);
});

test("the GitHub status reads the machine's gh: the account when logged in, installed false when missing, one probe for parallel calls", async (t) => {
  const host = isolatedHostVars(makeDir(t, "integrations-gh-host"));
  const env = { ...host, NIGHTQUEUE_FAKE_GH_STATE: "authenticated", NIGHTQUEUE_FAKE_GH_LOGIN: "dev1", NIGHTQUEUE_FAKE_GH_HOST: "ghe.acme.io", NIGHTQUEUE_FAKE_GH_SLEEP_MS: "300" };
  const home = await integrationsHome(t, "integrations-gh-status", { env });
  const [first, second] = await Promise.all([home.call("GET", "/api/integrations/github/status"), home.call("GET", "/api/integrations/github/status")]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const { checkedAt, ...status } = first.body;
  assert.deepEqual(status, { kind: "github", installed: true, authenticated: true, login: "dev1", host: "ghe.acme.io" });
  assert.equal(typeof checkedAt, "string");
  assert.equal(second.body.login, "dev1");
  const probes = readFileSync(host.NIGHTQUEUE_FAKE_GH_LOG, "utf8").split("\n").filter((line) => line === JSON.stringify(["auth", "status"]));
  assert.equal(probes.length, 1);
  assert.equal((await home.call("GET", "/api/integrations/sentry/status")).status, 404);

  const missing = await integrationsHome(t, "integrations-gh-missing", { env: { ...host, NIGHTQUEUE_GH_BIN: join(makeDir(t, "integrations-gh-none"), "gh") } });
  const absent = await missing.call("GET", "/api/integrations/github/status");
  assert.deepEqual([absent.status, absent.body.installed, absent.body.authenticated, absent.body.login], [200, false, false, null]);
});
