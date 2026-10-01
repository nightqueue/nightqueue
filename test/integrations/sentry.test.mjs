import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { testConnection } from "../../src/config/connections.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { ORIGIN_MAX_BYTES, enrichJobOrigin } from "../../src/integrations/enrich.mjs";
import { requestJson } from "../../src/integrations/http.mjs";
import { detectOrigin, explicitOrigin } from "../../src/integrations/origin.mjs";
import { sentry } from "../../src/integrations/sentry.mjs";
import { acquireClose, getJob } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, runClosePipeline } from "../../src/queue/close.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf, seedDoneJob } from "../../test-support/memory.mjs";
import { orgOfProject, setIntegrations } from "../../test-support/origin-provider.mjs";

const TOKEN = "sntrys_secret_token_0123456789";
const API = "https://sentry.io/api/0/organizations/acme";
const ISSUE_URL = "https://acme.sentry.io/issues/4507/";
const MERGE_SHA = "abc1234def5678";
const WORKER = "close:test:1:sentry";
const PRIVATE_MARK = "PRIVATE-USER-DATA";
const RECORD = { type: "sentry", token: TOKEN, org: "acme", url: "https://sentry.io" };
const POST_STEPS = CLOSE_STEPS.filter((step) => step.required === false);

// A fake fetch recording every call and answering by `METHOD url` route, 404 for a route it does not know.
function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, options) => {
    const method = options.method ?? "GET";
    calls.push({ url, method, body: options.body ?? null, auth: options.headers?.Authorization ?? null });
    const route = routes[`${method} ${url}`] ?? { status: 404 };
    return { status: route.status ?? 200, headers: new Map(), json: async () => route.body ?? {} };
  };
  return { impl, calls };
}

// The http a provider receives, bound to a fake fetch.
function httpOf(fetch) {
  return (url, options = {}) => requestJson(fetch.impl, url, options);
}

// The latest event of the fixture issue: 40 frames, 25 breadcrumbs, tags, and private request/user data.
function latestEvent({ extraTags = 0 } = {}) {
  const padding = Array.from({ length: extraTags }, () => ({ key: "release", value: "é".repeat(40) }));
  const frames = Array.from({ length: 40 }, (_, at) => ({ filename: `src/f${at}.js`, function: `fn${at}`, lineNo: at, inApp: at % 2 === 0 }));
  const crumbs = Array.from({ length: 25 }, (_, at) => ({ category: "http", message: `call ${at}` }));
  return {
    entries: [
      { type: "exception", data: { values: [{ type: "TypeError", value: "x is undefined", stacktrace: { frames } }] } },
      { type: "breadcrumbs", data: { values: crumbs } },
      { type: "request", data: { url: "https://app.example/login", cookies: PRIVATE_MARK, headers: [["Authorization", PRIVATE_MARK]] } },
    ],
    tags: [
      { key: "release", value: "1.2.3" },
      { key: "browser", value: "Firefox" },
      { key: "user", value: `id:${PRIVATE_MARK}` },
      { key: "url", value: `https://app.example/reset?token=${PRIVATE_MARK}` },
      { key: "server_name", value: PRIVATE_MARK },
      { key: "user.ip", value: PRIVATE_MARK },
      ...padding,
    ],
    user: { email: PRIVATE_MARK },
    contexts: { device: { name: PRIVATE_MARK } },
  };
}

// Seven recent events of the fixture issue, newest first, each carrying private user data and tags.
function recentEvents() {
  return Array.from({ length: 7 }, (_, at) => ({
    eventID: `e${at}`,
    dateCreated: `2026-09-30T1${at}:00:00Z`,
    title: `TypeError: x is undefined #${at}`,
    user: { email: PRIVATE_MARK },
    tags: [{ key: "user.email", value: PRIVATE_MARK }],
  }));
}

// The issue routes of the fixture: the issue, its recent events, its latest event, its status update and its note.
function issueRoutes({ put = 200, note = 201, event = 200, events = 200, title = "TypeError: x is undefined", extraTags = 0 } = {}) {
  return {
    [`GET ${API}/issues/4507/`]: {
      body: { shortId: "API-12", title, culprit: "boot()", level: "error", status: "unresolved", count: "42", userCount: 3, firstSeen: "2026-09-01", lastSeen: "2026-09-30", permalink: ISSUE_URL },
    },
    [`GET ${API}/issues/4507/events/?per_page=5`]: { status: events, body: recentEvents() },
    [`GET ${API}/issues/4507/events/latest/`]: { status: event, body: latestEvent({ extraTags }) },
    [`PUT ${API}/issues/4507/`]: { status: put },
    [`POST ${API}/issues/4507/comments/`]: { status: note },
    [`GET ${API}/shortids/API-12/`]: { body: { groupId: "4507", shortId: "API-12" } },
  };
}

// A home with project `alpha` whose org binds the sentry connection `sn`.
function sentryHome(t, name) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const orgId = orgOfProject(env, projectId);
  const config = loadConfig(env, { warn: () => {} });
  config.orgConnections[orgId] = { ...(config.orgConnections[orgId] ?? {}), sentry: "sn" };
  saveConfig(config, env);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.sn = { ...RECORD };
  saveSecrets(secrets, env);
  return { env, checkout, projectId, orgId };
}

// Runs the CLI in this process with a stdin, collecting what it printed.
async function runCli(env, argv, input = "") {
  const out = [];
  const err = [];
  const stdin = Readable.from([input]);
  const code = await run(argv, { ...defaultContext(), env, stdin, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

// Pre-close steps that merge and settle without gh, so the real post-close steps run after a real settle.
function fakePreSteps() {
  const done = (note, data) => async () => ({ status: "done", note, data });
  return [
    { name: "preflight", run: done("checks green", { title: "fix the crash" }) },
    { name: "conflict", run: async () => ({ status: "skipped", note: "mergeable" }) },
    { name: "merge", run: done("merged", { merged: true, mergeSha: MERGE_SHA }) },
    { name: "settle", run: async () => ({ status: "done", note: "ready", data: { noticeLine: "Closed: PR #7 merged as abc1234 on 2026-10-01" } }) },
  ];
}

// Closes a done job queued from the sentry link with the fake pre-close steps and the real post-close ones.
async function closeSentryJob(home, fetch) {
  const id = seedDoneJob(home.env, { prompt: `the worker crashes on boot, see ${ISSUE_URL}` });
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

test("a sentry link or a short id named after the word sentry is an origin; a bare KEY-n in prose never is", () => {
  const parse = (text) => sentry.origin.parse(text);
  assert.equal(parse(`see ${ISSUE_URL}`), "4507");
  assert.equal(parse("https://sentry.io/organizations/acme/issues/88/?project=1"), "88");
  assert.equal(parse("https://us.sentry.io/organizations/acme/issues/99"), "99");
  assert.equal(parse("crash reported in sentry API-12 yesterday"), "API-12");
  assert.equal(parse("Sentry: PROJ-1A2"), "PROJ-1A2");
  assert.equal(parse("SENTRY#API-12"), "API-12");
  assert.equal(parse("Sentry: api-12"), null);
  assert.equal(parse("wire the sentry error-handling into the sentry web-app"), null);
  assert.equal(parse("configure sentry API-KEY rotation"), null);
  assert.equal(detectOrigin("add sentry error-handling to the worker"), null);
  assert.equal(parse("fix J-86 for D-55, see NQ-7 and API-12"), null);
  assert.equal(parse("https://notsentry.io/issues/1"), null);
  assert.equal(parse("4507"), null);
  assert.equal(detectOrigin("fix J-86 for D-55, see NQ-7"), null);
  assert.deepEqual(detectOrigin(`the worker crashes, see ${ISSUE_URL}`), { kind: "sentry", ref: "4507" });
  assert.deepEqual(explicitOrigin({ kind: "sentry", ref: "4507" }), { kind: "sentry", ref: "4507" });
  assert.deepEqual(explicitOrigin({ kind: "sentry", ref: "api-12" }), { kind: "sentry", ref: "API-12" });
  assert.throws(() => explicitOrigin({ kind: "sentry", ref: "not an issue" }), /is not a sentry reference/);
});

test("connection add --type sentry takes --set org and an optional url, refuses a missing, unknown or malformed field, and the test reads the org", async (t) => {
  const env = makeHome(t, "sentry-connection-add");
  makeProject(t, env, "alpha");
  const added = await runCli(env, ["connection", "add", "sn", "--type", "sentry", "--set", "org=acme"], `${TOKEN}\n`);
  assert.equal(added.code, 0, added.err.join("\n"));
  assert.match(added.out.join("\n"), /stored connection `sn` \(sentry\) and bound it to org/);
  assert.deepEqual(loadSecrets(env, { warn: () => {} }).connections.sn, RECORD);

  const refusals = [
    [["--set", "org=acme", "--set", "region=eu"], /a sentry connection has no field `region`; fields: org, url/],
    [[], /a sentry connection needs --set org=<value>/],
    [["--set", "org=acme", "--set", "url=http://sentry.example.com"], /`--set url` of a sentry connection takes an https origin/],
    [["--set", "org=a/b"], /`--set org` of a sentry connection takes an organization slug/],
  ];
  for (const [extra, message] of refusals) {
    const refused = await runCli(env, ["connection", "add", "other", "--type", "sentry", ...extra], `${TOKEN}\n`);
    assert.equal(refused.code, 1);
    assert.match(refused.err.join("\n"), message);
  }
  assert.equal(loadSecrets(env, { warn: () => {} }).connections.other, undefined);
  const output = JSON.stringify([added, ...refusals]);
  assert.ok(!output.includes(TOKEN));

  const fetch = fakeFetch({ [`GET ${API}/`]: { body: { slug: "acme" } } });
  const result = await testConnection({ name: "sn", secrets: loadSecrets(env, { warn: () => {} }), fetchImpl: fetch.impl });
  assert.deepEqual(result, { type: "sentry", ok: true, status: 200, org: "acme", detail: "ok" });
  assert.equal(sentry.connection.summary(result), "org=acme");
  assert.deepEqual(fetch.calls.map((call) => [call.method, call.url, call.auth]), [["GET", `${API}/`, `Bearer ${TOKEN}`]]);
  const refused = await testConnection({ name: "sn", secrets: loadSecrets(env, { warn: () => {} }), fetchImpl: fakeFetch().impl });
  assert.deepEqual(refused, { type: "sentry", ok: false, status: 404, org: null, detail: "HTTP 404" });
});

test("enrichment reads the issue, its recent events and its latest event into markdown with no private data, resolving a short id first", async () => {
  const fetch = fakeFetch(issueRoutes());
  const markdown = await sentry.origin.enrich("API-12", { connection: { ...RECORD, name: "sn" }, http: httpOf(fetch) });
  assert.deepEqual(fetch.calls.map((call) => [call.method, call.url]), [
    ["GET", `${API}/shortids/API-12/`],
    ["GET", `${API}/issues/4507/`],
    ["GET", `${API}/issues/4507/events/?per_page=5`],
    ["GET", `${API}/issues/4507/events/latest/`],
  ]);
  const recent = markdown.split("\n").filter((line) => / e\d: TypeError/.test(line));
  assert.deepEqual([recent.length, recent[0], recent.at(-1)], [5, "- 2026-09-30T10:00:00Z e0: TypeError: x is undefined #0", "- 2026-09-30T14:00:00Z e4: TypeError: x is undefined #4"]);
  assert.ok(markdown.indexOf("## Recent events (up to 5)") < markdown.indexOf("## Exception"));
  assert.ok(fetch.calls.every((call) => call.auth === `Bearer ${TOKEN}`));
  assert.match(markdown, /^# Sentry issue API-12: TypeError: x is undefined/);
  assert.match(markdown, /- events: 42, users: 3/);
  assert.match(markdown, /- TypeError: x is undefined/);
  assert.match(markdown, /- release=1\.2\.3/);
  assert.match(markdown, /- browser=Firefox/);
  assert.ok(!/^- (user|url|server_name|user\.ip)=/m.test(markdown), "only allow-listed tag keys are written");
  const frames = markdown.split("\n").filter((line) => /^- src\/f\d+\.js:/.test(line));
  assert.equal(frames.length, 30);
  assert.equal(frames[0], "- src/f38.js:fn38:38");
  assert.equal(frames[19], "- src/f0.js:fn0:0");
  assert.equal(frames[20], "- src/f39.js:fn39:39");
  const crumbs = markdown.split("\n").filter((line) => line.startsWith("- http: call"));
  assert.deepEqual([crumbs.length, crumbs[0], crumbs.at(-1)], [20, "- http: call 5", "- http: call 24"]);
  assert.ok(!markdown.includes(PRIVATE_MARK));
  assert.ok(!markdown.includes(TOKEN));

  const partial = await sentry.origin.enrich("4507", { connection: RECORD, http: httpOf(fakeFetch(issueRoutes({ event: 403, events: 500 }))) });
  assert.match(partial, /Latest event not read \(HTTP 403\)\./);
  assert.match(partial, /Recent events not read \(HTTP 500\)\./);
  assert.match(partial, /^# Sentry issue API-12/);
  const missing = await sentry.origin.enrich("NOPE-1", { connection: RECORD, http: httpOf(fakeFetch()) });
  assert.deepEqual(missing, { detail: "short id NOPE-1 not resolved (HTTP 404)" });
});

test("the runner's enrichment writes the capped sentry file once and logs no secret", async (t) => {
  const home = sentryHome(t, "sentry-enrich");
  const dir = mkdtempSync(join(tmpdir(), "nq-sentry-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch(issueRoutes({ title: "é".repeat(20000), extraTags: 500 }));
  const lines = [];
  await enrichJobOrigin({
    origin: { kind: "sentry", ref: "4507" },
    orgId: home.orgId,
    integrations: { sentry: { onClosed: "resolved" } },
    dir,
    env: home.env,
    fetchImpl: fetch.impl,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ["origin: sentry 4507 (connection: sn)"]);
  const written = readFileSync(join(dir, "sentry.md"), "utf8");
  assert.ok(Buffer.byteLength(written, "utf8") <= ORIGIN_MAX_BYTES);
  assert.ok(written.endsWith("[truncated]"));
  assert.ok(!written.includes(TOKEN) && !written.includes(PRIVATE_MARK));
});

test("onClosed sets the configured status, leaves a note, and turns a refused update or note into a warning with no secret", async () => {
  const close = async (routes, settings = {}) => {
    const fetch = fakeFetch(routes);
    const answer = await sentry.onClosed({
      ref: "4507",
      job: { id: 1, ref: "J-1", title: "fix the crash", project: "alpha" },
      result: { prUrl: "https://github.com/acme/api/pull/7", prNumber: 7, mergeSha: MERGE_SHA },
      settings,
      slot: { ...RECORD, name: "sn" },
      connections: [],
      http: httpOf(fetch),
    });
    return { answer, calls: fetch.calls };
  };

  const resolved = await close(issueRoutes());
  assert.deepEqual(resolved.answer, { status: "done", note: "issue 4507 marked resolved" });
  assert.deepEqual(resolved.calls.map((call) => [call.method, call.url, call.body]), [
    ["PUT", `${API}/issues/4507/`, JSON.stringify({ status: "resolved" })],
    ["POST", `${API}/issues/4507/comments/`, JSON.stringify({ text: "Fixed by https://github.com/acme/api/pull/7, merged as abc1234" })],
  ]);

  const nextRelease = await close(issueRoutes(), { onClosed: "resolvedInNextRelease" });
  assert.equal(nextRelease.calls[0].body, JSON.stringify({ status: "resolvedInNextRelease" }));

  const noteFailed = await close(issueRoutes({ note: 500 }));
  assert.deepEqual(noteFailed.answer, { status: "warning", note: "issue 4507 marked resolved; note not posted (HTTP 500)", notified: true });

  const forbidden = await close(issueRoutes({ put: 403 }));
  assert.deepEqual(forbidden.answer, { status: "warning", note: "issue 4507 not marked resolved (HTTP 403)" });
  assert.equal(forbidden.calls.length, 1);

  const all = JSON.stringify([resolved.answer, nextRelease.answer, noteFailed.answer, forbidden.answer]);
  assert.ok(!all.includes(TOKEN));
});

test("closing a job queued from a sentry link resolves the issue, and a refused update leaves the job closed with a notice line", async (t) => {
  const home = sentryHome(t, "sentry-close");
  setIntegrations(home.env, home.projectId, { sentry: { onClosed: "resolved" } });

  const fetch = fakeFetch(issueRoutes());
  const { outcome, row } = await closeSentryJob(home, fetch);
  assert.equal(outcome.status, "closed");
  assert.deepEqual(outcome.postClose.steps[0], { name: "origin", status: "done", note: "issue 4507 marked resolved" });
  assert.deepEqual(fetch.calls.map((call) => call.method), ["PUT", "POST"]);
  assert.equal(row.status, "closed");
  assert.equal(JSON.parse(row.close).data.originNotified, true);
  assert.equal(row.notice_md, "Closed: PR #7 merged as abc1234 on 2026-10-01");

  const failing = fakeFetch(issueRoutes({ put: 500 }));
  const failed = await closeSentryJob(home, failing);
  assert.equal(failed.outcome.status, "closed");
  assert.equal(failed.row.status, "closed");
  assert.match(failed.row.notice_md, /After close: origin warning - issue 4507 not marked resolved \(HTTP 500\)/);
  assert.ok(!JSON.stringify(failed.row).includes(TOKEN));
});

test("project integrations accepts sentry.onClosed with its two values and refuses any other", async (t) => {
  const home = sentryHome(t, "sentry-settings");
  const set = await runCli(home.env, ["project", "integrations", "alpha", "set", "sentry.onClosed=resolvedInNextRelease"]);
  assert.equal(set.code, 0, set.err.join("\n"));
  assert.ok(set.out.includes("sentry.onClosed=resolvedInNextRelease"));
  assert.ok(set.out.includes("sentry: org connection sn"));
  const refused = await runCli(home.env, ["project", "integrations", "alpha", "set", "sentry.onClosed=ignored"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err.join("\n"), /`sentry\.onClosed` takes one of: resolved, resolvedInNextRelease/);
});
