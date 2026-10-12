import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { acquireClose, addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, runClosePipeline } from "../../src/queue/close.mjs";
import { runPostCloseSteps } from "../../src/queue/close-start.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { orgOfProject, setIntegrations } from "../../test-support/origin-provider.mjs";

const SENTRY_TOKEN = "sntrys_three_origins_secret";
const LINEAR_KEY = "lin_api_three_origins_secret";
const WEBHOOK_TOKEN = "discordThreeOriginsSecret";
const SENTRY_API = "https://sentry.io/api/0/organizations/acme";
const LINEAR_API = "https://api.linear.app/graphql";
const WEBHOOK_URL = `https://discord.com/api/webhooks/9001/${WEBHOOK_TOKEN}`;
const PR_URL = "https://github.com/acme/api/pull/7";
const MERGE_SHA = "abc1234def5678";
const WORKER = "close:test:1:three";
const POST_STEPS = CLOSE_STEPS.filter((step) => step.required === false);
const SECRETS = [SENTRY_TOKEN, LINEAR_KEY, WEBHOOK_TOKEN];
const STORED = [
  { kind: "discord", ref: "111/222/555" },
  { kind: "linear", ref: "MK-42" },
  { kind: "sentry", ref: "4507" },
];
const LINEAR_ANSWERS = {
  issue: { issue: { id: "uuid-42", identifier: "MK-42", state: { name: "In Progress", type: "started" }, team: { states: { nodes: [{ id: "s-done", name: "Done", type: "completed", position: 1 }] } } } },
  issueUpdate: { issueUpdate: { success: true } },
  attachmentCreate: { attachmentCreate: { success: true } },
  commentCreate: { commentCreate: { success: true } },
};

// The Linear operation a GraphQL query carries, named by its root field.
function linearOperation(query) {
  return ["issueUpdate", "attachmentCreate", "commentCreate", "issue"].find((name) => query.includes(name)) ?? "unknown";
}

// A fake fetch for the three services, recording each call as `<service> <action>`; the discord post answers `discord`.
function serviceFetch({ discord = 200 } = {}) {
  const calls = [];
  const impl = async (url, options = {}) => {
    const method = options.method ?? "GET";
    const reply = (status, body = {}) => ({ status, headers: new Map(), json: async () => body });
    if (url === LINEAR_API) {
      const operation = linearOperation(JSON.parse(options.body).query);
      calls.push(`linear ${operation}`);
      return reply(200, { data: LINEAR_ANSWERS[operation] ?? null });
    }
    if (url.startsWith(SENTRY_API)) {
      calls.push(`sentry ${method} ${url.slice(SENTRY_API.length)}`);
      return reply(200);
    }
    calls.push(`discord ${method}`);
    if (discord === "throw") throw new Error(`socket hang up ${WEBHOOK_TOKEN}`);
    return reply(discord, { id: "999" });
  };
  return { impl, calls };
}

// A home whose project enables sentry and discord, with the org's sentry slot, its discord webhook and the home's linear key.
function threeOriginHome(t, name) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const orgId = orgOfProject(env, projectId);
  setIntegrations(env, projectId, { sentry: { onClosed: "resolved" }, discord: {} });
  const config = loadConfig(env, { warn: () => {} });
  config.orgConnections[orgId] = { ...(config.orgConnections[orgId] ?? {}), sentry: "sn", discord: ["chat"] };
  saveConfig(config, env);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.sn = { type: "sentry", token: SENTRY_TOKEN, org: "acme", url: "https://sentry.io" };
  secrets.connections.chat = { type: "discord", url: WEBHOOK_URL, channelId: "222", guildId: "111", mode: "webhook" };
  secrets.connections.lin = { type: "linear", apiKey: LINEAR_KEY };
  saveSecrets(secrets, env);
  return { env, checkout, projectId };
}

// Queues a job with the three origins stored out of close order and finishes it done with a pull request.
function seedThreeOriginJob(home) {
  const { id } = addJob({ projectId: home.projectId, prompt: "fix the login crash", origin: STORED }, home.env);
  if (!claimJobById(id, { worker: WORKER, cap: null }, home.env)) throw new Error(`job #${id} could not be claimed`);
  if (!finishJob(id, { worker: WORKER, status: "done", prUrl: PR_URL }, home.env)) throw new Error(`job #${id} could not be finished`);
  return id;
}

// Pre-close steps that merge and settle without gh, so the real post-close steps run after a real settle.
function fakePreSteps() {
  const done = (note, data) => async () => ({ status: "done", note, data });
  return [
    { name: "preflight", run: done("checks green", { title: "fix the login crash" }) },
    { name: "conflict", run: async () => ({ status: "skipped", note: "mergeable" }) },
    { name: "merge", run: done("merged", { merged: true, mergeSha: MERGE_SHA }) },
    { name: "settle", run: async () => ({ status: "done", note: "ready", data: { noticeLine: "Closed: PR #7 merged as abc1234 on 2026-10-01" } }) },
  ];
}

// Closes the job with the fake pre-close steps and the real post-close ones and providers.
async function closeJob(home, id, fetch) {
  acquireClose(id, { worker: WORKER, leaseS: 660 }, home.env);
  const outcome = await runClosePipeline({
    store: openStore(home.env),
    job: getJob(id, home.env),
    worker: WORKER,
    env: home.env,
    deps: { fetch: fetch.impl },
    timeoutS: 60,
    signal: null,
    onStep: () => {},
    checkout: home.checkout,
    steps: [...fakePreSteps(), ...POST_STEPS],
  });
  return { outcome, row: getJob(id, home.env) };
}

// Asserts no fixture secret appears in a value.
function assertNoSecret(value) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `a secret leaked: ${text}`);
}

const SENTRY_CALLS = ["sentry PUT /issues/4507/", "sentry POST /issues/4507/comments/"];
const LINEAR_CALLS = ["linear issue", "linear issueUpdate", "linear attachmentCreate", "linear commentCreate"];

test("a close with sentry, linear and discord origins acts on Sentry, then Linear (move, PR attached, comment), then Discord", async (t) => {
  const home = threeOriginHome(t, "three-origins");
  const id = seedThreeOriginJob(home);
  const fetch = serviceFetch();
  const { outcome, row } = await closeJob(home, id, fetch);
  assert.equal(outcome.status, "closed");
  assert.deepEqual(fetch.calls, [...SENTRY_CALLS, ...LINEAR_CALLS, "discord POST"]);
  assert.equal(outcome.postClose.steps[0].name, "origin");
  assert.equal(outcome.postClose.steps[0].status, "done", outcome.postClose.steps[0].note);
  assert.deepEqual(JSON.parse(row.close).data.originsNotified, { "sentry 4507": true, "linear MK-42": true, "discord 111/222/555": true });
  assert.equal(row.notice_md, "Closed: PR #7 merged as abc1234 on 2026-10-01");
  assertNoSecret(row);
});

test("a refused or throwing discord post is a warning line of its own; the job stays closed and a re-close calls only discord", async (t) => {
  for (const discord of [400, "throw"]) {
    const home = threeOriginHome(t, `three-origins-${discord}`);
    const id = seedThreeOriginJob(home);
    const fetch = serviceFetch({ discord });
    const { outcome, row } = await closeJob(home, id, fetch);
    assert.equal(outcome.status, "closed", String(discord));
    assert.equal(row.status, "closed", String(discord));
    assert.deepEqual(fetch.calls, [...SENTRY_CALLS, ...LINEAR_CALLS, "discord POST"], String(discord));
    assert.equal(outcome.postClose.steps[0].status, "warning", String(discord));
    assert.deepEqual(JSON.parse(row.close).data.originsNotified, { "sentry 4507": true, "linear MK-42": true }, String(discord));
    assert.match(row.notice_md, /After close: origin warning - discord 111\/222\/555: /, String(discord));
    assertNoSecret(row);

    const retry = serviceFetch();
    const rerun = await runPostCloseSteps({ store: openStore(home.env), id, names: ["origin"], env: home.env, deps: { fetch: retry.impl } });
    assert.deepEqual(retry.calls, ["discord POST"], String(discord));
    assert.equal(rerun.steps[0].status, "done", String(discord));

    const idle = serviceFetch();
    await runPostCloseSteps({ store: openStore(home.env), id, names: ["origin"], env: home.env, deps: { fetch: idle.impl } });
    assert.deepEqual(idle.calls, [], "a re-close of every done origin makes no request");
  }
});

// The origin notice lines of a job's notice text.
function originLines(noticeMd) {
  return (noticeMd ?? "").split("\n\n").filter((line) => line.startsWith("After close: origin"));
}

test("a re-close adds notice lines only for the origins it acted on, never an `already notified` one", async (t) => {
  const home = threeOriginHome(t, "three-origins-notice");
  const id = seedThreeOriginJob(home);
  await closeJob(home, id, serviceFetch({ discord: 400 }));
  const first = originLines(getJob(id, home.env).notice_md);
  assert.equal(first.length, 1, first.join("\n"));

  await runPostCloseSteps({ store: openStore(home.env), id, names: ["origin"], env: home.env, deps: { fetch: serviceFetch({ discord: 400 }).impl } });
  const failedAgain = originLines(getJob(id, home.env).notice_md).slice(first.length);
  assert.equal(failedAgain.length, 1, failedAgain.join("\n"));
  assert.match(failedAgain[0], /^After close: origin warning - discord 111\/222\/555: /);

  await runPostCloseSteps({ store: openStore(home.env), id, names: ["origin"], env: home.env, deps: { fetch: serviceFetch().impl } });
  const succeeded = originLines(getJob(id, home.env).notice_md).slice(first.length + 1);
  assert.equal(succeeded.length, 1, succeeded.join("\n"));
  assert.match(succeeded[0], /^After close: origin done - discord 111\/222\/555: /);
  assert.ok(!getJob(id, home.env).notice_md.includes("already notified"));
});
