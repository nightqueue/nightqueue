import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { getJob, jobView } from "../../src/memory/jobs.mjs";
import { makeHome, makeProject, projectIdOf, seedDoneJob } from "../../test-support/memory.mjs";
import { orgOfProject, setIntegrations } from "../../test-support/origin-provider.mjs";

const LINEAR_API = "https://api.linear.app/graphql";
const LINEAR_URL = "https://linear.app/acme/issue/MK-42/fix-the-login";
const SENTRY_API = "https://sentry.io/api/0/organizations/acme";
const SENTRY_URL = "https://acme.sentry.io/issues/4507/";
const GUILD = "111";
const CHAT_CHANNEL = "222";
const OPS_CHANNEL = "333";
const MESSAGE = "555";
const CHAT_URL = `https://discord.com/api/webhooks/9001/chatWebhookSecretToken-0123`;
const OPS_URL = `https://discord.com/api/webhooks/9002/opsWebhookSecretToken-4567`;
const DISCORD_LINK = `https://discord.com/channels/${GUILD}/${CHAT_CHANNEL}/${MESSAGE}`;
const REPLY = `POST ${CHAT_URL}?wait=true`;
const LOG = `POST ${OPS_URL}?wait=true`;
const SENTRY_PUT = `PUT ${SENTRY_API}/issues/4507/`;
const SENTRY_NOTE = `POST ${SENTRY_API}/issues/4507/comments/`;
const LINEAR_WRITES = ["issueUpdate", "attachmentCreate", "commentCreate"];
const CONCLUSION = "✅ Resolved — no code change needed\n\nThe loop comes from the CDN cache rule, not from this repository.";
const STATES = [{ id: "s-done", name: "Done", type: "completed", position: 3 }];

// The GraphQL operation of a Linear request body, named by its root field.
function linearOperation(body) {
  const query = JSON.parse(body ?? "{}").query ?? "";
  for (const name of ["issueUpdate", "attachmentCreate", "commentCreate", "issue("]) {
    if (query.includes(name)) return name.replace("(", "");
  }
  return "unknown";
}

// The answers of Linear, Sentry and Discord, each write overridable with an HTTP status.
function serviceRoutes(failing = {}) {
  const linearIssue = { id: "uuid-42", identifier: "MK-42", title: "Fix the login", url: LINEAR_URL, team: { states: { nodes: STATES } } };
  return {
    "linear issue": { body: { data: { issue: linearIssue } } },
    "linear issueUpdate": { body: { data: { issueUpdate: { success: true } } } },
    "linear commentCreate": { body: { data: { commentCreate: { success: true } } } },
    [`GET ${SENTRY_API}/issues/4507/`]: { body: { shortId: "API-12", title: "TypeError: x is undefined", permalink: SENTRY_URL } },
    [SENTRY_PUT]: { status: failing[SENTRY_PUT] ?? 200 },
    [SENTRY_NOTE]: { status: 201 },
    [`GET ${CHAT_URL}`]: { body: { channel_id: CHAT_CHANNEL, guild_id: GUILD } },
    [`GET ${OPS_URL}`]: { body: { channel_id: OPS_CHANNEL, guild_id: GUILD } },
    [REPLY]: { status: failing[REPLY] ?? 200 },
    [LOG]: { status: failing[LOG] ?? 200 },
  };
}

// A fake fetch over the three services recording each call as `METHOD url`, a Linear call as `linear <operation>`; 404 for an unknown route.
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const key = url === LINEAR_API ? `linear ${linearOperation(options.body)}` : `${options.method ?? "GET"} ${url}`;
    calls.push({ key, body: options.body ?? null });
    const route = routes[key] ?? { status: 404 };
    return { status: route.status ?? 200, headers: new Map(), json: async () => route.body ?? {} };
  };
  return { impl, calls };
}

// Close deps that answer the fake fetch and fail on any gh or git call.
function closeDeps(fetch) {
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        if (name === "fetch") return fetch.impl;
        if (name === "settleClosed" || name === "integrations" || typeof name === "symbol") return undefined;
        return () => {
          throw new Error(`${String(name)} must not be called`);
        };
      },
    },
  );
}

// Runs the CLI in this process with a fetch for the commands and the close, collecting what it printed.
async function runCli(env, argv, { fetch, input = "" }) {
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env, stdin: Readable.from([input]), fetchImpl: fetch.impl, closeDeps: closeDeps(fetch), out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await run(argv, ctx);
  return { code, out, err };
}

// Adds the Linear home connection and binds the Sentry connection `sn` to the project's org.
function connectLinearAndSentry(env, orgId) {
  const config = loadConfig(env, { warn: () => {} });
  config.orgConnections[orgId] = { ...(config.orgConnections[orgId] ?? {}), sentry: "sn" };
  saveConfig(config, env);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.linear = { type: "linear", apiKey: "lin_api_secret_0123456789" };
  secrets.connections.sn = { type: "sentry", token: "sntrys_secret_token_0123456789", org: "acme", url: "https://sentry.io" };
  saveSecrets(secrets, env);
}

// A home whose job came from a Linear issue, a Sentry issue and a Discord message, resolved without change, logging closes to Discord.
async function threeOriginHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  for (const [hook, url] of [["chat", CHAT_URL], ["ops", OPS_URL]]) {
    const added = await runCli(env, ["connection", "add", hook, "--type", "discord"], { fetch: fakeFetch(serviceRoutes()), input: `${url}\n` });
    assert.equal(added.code, 0, added.err.join("\n"));
  }
  connectLinearAndSentry(env, orgOfProject(env, projectId));
  setIntegrations(env, projectId, { sentry: { onClosed: "resolved" }, discord: { replyToOrigin: true, log: { connection: "ops" } } });
  const prompt = `the login loops, see ${LINEAR_URL}, ${SENTRY_URL} and ${DISCORD_LINK}`;
  const id = seedDoneJob(env, { prompt, prUrl: null, noticeMd: CONCLUSION });
  return { env, id };
}

// The keys of the calls that wrote to a service: a Linear mutation, a Sentry update or note, a Discord post.
function writesOf(fetch) {
  return fetch.calls.map((call) => call.key).filter((key) => key.startsWith("POST ") || key.startsWith("PUT ") || LINEAR_WRITES.some((op) => key === `linear ${op}`));
}

// Asserts the job is closed as resolved without change, its notice ending with the After close line that names the failure.
function assertClosedWithWarning(home, failureLine) {
  const row = getJob(home.id, home.env);
  assert.equal(row.status, "closed");
  assert.equal(row.pr_url, null);
  assert.equal(JSON.parse(row.close).data.resolvedWithoutChange, true);
  assert.equal(jobView(row).resolution, "no-change");
  const afterClose = row.notice_md.split("\n").filter((line) => line.startsWith("After close:"));
  assert.equal(afterClose.length, 1, row.notice_md);
  assert.match(afterClose[0], failureLine);
}

const FAILURES = [
  {
    name: "Sentry refuses the update",
    failing: { [SENTRY_PUT]: 500 },
    line: /^After close: origin warning - .*sentry 4507: issue 4507 not marked resolved \(HTTP 500\)/,
    firstWrites: ["linear issueUpdate", "linear commentCreate", SENTRY_PUT, REPLY, LOG],
    redoWrites: [SENTRY_PUT, SENTRY_NOTE],
  },
  {
    name: "the Discord reply is refused",
    failing: { [REPLY]: 500 },
    line: /^After close: origin warning - .*discord 111\/222\/555: reply in channel 222 not posted through chat/,
    firstWrites: ["linear issueUpdate", "linear commentCreate", SENTRY_PUT, SENTRY_NOTE, REPLY, LOG],
    redoWrites: [REPLY],
  },
  {
    name: "the Discord log is refused",
    failing: { [LOG]: 500 },
    line: /^After close: log warning - discord: log not posted through ops/,
    firstWrites: ["linear issueUpdate", "linear commentCreate", SENTRY_PUT, SENTRY_NOTE, REPLY, LOG],
    redoWrites: [LOG],
  },
];

for (const failure of FAILURES) {
  test(`a job resolved without change whose close meets ${failure.name} ends closed with the warning, and --steps origin,log redoes only that write`, async (t) => {
    const home = await threeOriginHome(t, `no-change-fail-${FAILURES.indexOf(failure)}`);
    const first = fakeFetch(serviceRoutes(failure.failing));
    const closed = await runCli(home.env, ["queue", "close", String(home.id), "--foreground"], { fetch: first });
    assert.equal(closed.out.includes(`J-${home.id} closed: resolved without change (no pull request)`), true, [...closed.out, ...closed.err].join("\n"));
    assert.deepEqual(writesOf(first).sort(), [...failure.firstWrites].sort());
    for (const call of first.calls.filter((entry) => entry.body)) {
      assert.equal(call.body.includes("/pull/"), false, `a no-change close named a pull request: ${call.key}`);
    }
    assertClosedWithWarning(home, failure.line);

    const redo = fakeFetch(serviceRoutes());
    const rerun = await runCli(home.env, ["queue", "close", String(home.id), "--steps", "origin,log"], { fetch: redo });
    assert.equal(rerun.code, 0, [...rerun.out, ...rerun.err].join("\n"));
    assert.deepEqual(writesOf(redo), failure.redoWrites, "the re-run wrote again to a service already told");
    const sentryNote = redo.calls.find((call) => call.key === SENTRY_NOTE);
    if (sentryNote) assert.match(JSON.parse(sentryNote.body).text, /^Resolved without a code change \(J-\d+, nightqueue\): ✅ Resolved/);
    const row = getJob(home.id, home.env);
    assert.equal(row.status, "closed");
    assert.equal(JSON.parse(row.close).data.resolvedWithoutChange, true);
  });
}
