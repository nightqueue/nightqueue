import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { testConnection } from "../../src/config/connections.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { ORIGIN_MAX_BYTES, enrichJobOrigins } from "../../src/integrations/enrich.mjs";
import { requestJson } from "../../src/integrations/http.mjs";
import { detectOrigins, explicitOrigin } from "../../src/integrations/origin.mjs";
import { sentry } from "../../src/integrations/sentry.mjs";
import { acquireClose, getJob } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, runClosePipeline } from "../../src/queue/close.mjs";
import { noChangeConclusion } from "../../src/queue/run-notice.mjs";
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

// One full event of the fixture issue, `at` places from the newest: 40 frames, 25 breadcrumbs, tags, and private request/user data.
function fullEvent({ at = 0, extraTags = 0 } = {}) {
  const padding = Array.from({ length: extraTags }, () => ({ key: "release", value: "é".repeat(40) }));
  const frames = Array.from({ length: 40 }, (_, n) => ({ filename: `src/f${n}.js`, function: `fn${n}`, lineNo: n, inApp: n % 2 === 0 }));
  const crumbs = Array.from({ length: 25 }, (_, n) => ({ category: "http", message: `call ${n}` }));
  return {
    eventID: `e${at}`,
    dateCreated: `2026-09-30T${19 - at}:00:00Z`,
    title: `TypeError: x is undefined #${at}`,
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

// Seven full events of the fixture issue, newest first; the ones listed in `bare` come without their entries.
function recentEvents({ extraTags = 0, bare = [] } = {}) {
  return Array.from({ length: 7 }, (_, at) => {
    const event = fullEvent({ at, extraTags });
    return bare.includes(at) ? { eventID: event.eventID, dateCreated: event.dateCreated, title: event.title } : event;
  });
}

// The issue routes of the fixture: the issue, its recent events in full, one event by id, its status update and its note.
function issueRoutes({ put = 200, note = 201, events = 200, title = "TypeError: x is undefined", extraTags = 0, bare = [] } = {}) {
  return {
    [`GET ${API}/issues/4507/`]: {
      body: { shortId: "API-12", title, culprit: "boot()", level: "error", status: "unresolved", count: "42", userCount: 3, firstSeen: "2026-09-01", lastSeen: "2026-09-30", permalink: ISSUE_URL },
    },
    [`GET ${API}/issues/4507/events/?full=true&per_page=3`]: { status: events, body: recentEvents({ extraTags, bare }) },
    [`GET ${API}/issues/4507/events/e1/`]: { body: fullEvent({ at: 1 }) },
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
  assert.deepEqual(detectOrigins("add sentry error-handling to the worker"), []);
  assert.equal(parse("fix J-86 for D-55, see NQ-7 and API-12"), null);
  assert.equal(parse("https://notsentry.io/issues/1"), null);
  assert.equal(parse("4507"), null);
  assert.deepEqual(detectOrigins("fix J-86 for D-55, see NQ-7"), []);
  assert.deepEqual(detectOrigins(`the worker crashes, see ${ISSUE_URL}`), [{ kind: "sentry", ref: "4507" }]);
  assert.deepEqual(sentry.origin.find(`sentry: api-1 no, Sentry API-12 then https://sentry.io/issues/9 and ${ISSUE_URL}`), ["API-12", "9", "4507"]);
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

// The per-event sections of an enriched markdown, each from its `### Event` heading to the next one.
function eventSections(markdown) {
  return markdown.split("\n### Event ").slice(1).map((section) => `### Event ${section}`);
}

// The lines of a section that match a pattern.
function linesMatching(section, pattern) {
  return section.split("\n").filter((line) => pattern.test(line));
}

test("enrichment reads the issue and its three most recent events in full into markdown with no private data, resolving a short id first", async () => {
  const fetch = fakeFetch(issueRoutes());
  const { markdown } = await sentry.origin.enrich("API-12", { connection: { ...RECORD, name: "sn" }, http: httpOf(fetch) });
  assert.deepEqual(fetch.calls.map((call) => [call.method, call.url]), [
    ["GET", `${API}/shortids/API-12/`],
    ["GET", `${API}/issues/4507/`],
    ["GET", `${API}/issues/4507/events/?full=true&per_page=3`],
  ]);
  assert.ok(fetch.calls.every((call) => call.auth === `Bearer ${TOKEN}`));
  assert.match(markdown, /^# Sentry issue API-12: TypeError: x is undefined/);
  assert.match(markdown, /- events: 42, users: 3/);
  assert.ok(markdown.indexOf("## Recent events (the 3 most recent, in full)") < markdown.indexOf("### Event 1 of 3"));
  const sections = eventSections(markdown);
  assert.deepEqual(sections.map((section) => section.split("\n")[0]), [
    "### Event 1 of 3 — 2026-09-30T19:00:00Z e0: TypeError: x is undefined #0",
    "### Event 2 of 3 — 2026-09-30T18:00:00Z e1: TypeError: x is undefined #1",
    "### Event 3 of 3 — 2026-09-30T17:00:00Z e2: TypeError: x is undefined #2",
  ]);
  assert.ok(!markdown.includes(" e3: "), "only the three most recent events are written");
  for (const section of sections) {
    assert.match(section, /#### Exception\n- TypeError: x is undefined/);
    assert.match(section, /- release=1\.2\.3/);
    assert.match(section, /- browser=Firefox/);
    const frames = linesMatching(section, /^- src\/f\d+\.js:/);
    assert.deepEqual([frames.length, frames[0], frames[19], frames[20]], [30, "- src/f38.js:fn38:38", "- src/f0.js:fn0:0", "- src/f39.js:fn39:39"]);
    const crumbs = linesMatching(section, /^- http: call/);
    assert.deepEqual([crumbs.length, crumbs[0], crumbs.at(-1)], [20, "- http: call 5", "- http: call 24"]);
  }
  assert.ok(!/^- (user|url|server_name|user\.ip)=/m.test(markdown), "only allow-listed tag keys are written");
  assert.ok(!markdown.includes(PRIVATE_MARK));
  assert.ok(!markdown.includes(TOKEN));

  const { markdown: partial } = await sentry.origin.enrich("4507", { connection: RECORD, http: httpOf(fakeFetch(issueRoutes({ events: 500 }))) });
  assert.match(partial, /Recent events not read \(HTTP 500\)\./);
  assert.ok(!partial.includes("### Event"));
  assert.match(partial, /^# Sentry issue API-12/);
  const missing = await sentry.origin.enrich("NOPE-1", { connection: RECORD, http: httpOf(fakeFetch()) });
  assert.deepEqual(missing, { detail: "short id NOPE-1 not resolved (HTTP 404)" });
});

test("a listed event without entries is read once more by its id, and a failed read names the event instead of its body", async () => {
  const fetch = fakeFetch(issueRoutes({ bare: [1, 2] }));
  const { markdown } = await sentry.origin.enrich("4507", { connection: RECORD, http: httpOf(fetch) });
  assert.deepEqual(fetch.calls.map((call) => call.url), [
    `${API}/issues/4507/`,
    `${API}/issues/4507/events/?full=true&per_page=3`,
    `${API}/issues/4507/events/e1/`,
    `${API}/issues/4507/events/e2/`,
  ]);
  const [first, second, third] = eventSections(markdown);
  assert.equal(linesMatching(first, /^- src\/f\d+\.js:/).length, 30);
  assert.equal(linesMatching(second, /^- src\/f\d+\.js:/).length, 30);
  assert.match(third, /^### Event 3 of 3 — 2026-09-30T17:00:00Z e2: TypeError: x is undefined #2\n\nEvent not read \(HTTP 404\)\.\n$/);
  assert.ok(!markdown.includes(PRIVATE_MARK));
});

test("the runner's enrichment writes the capped sentry file once and logs no secret", async (t) => {
  const home = sentryHome(t, "sentry-enrich");
  const dir = mkdtempSync(join(tmpdir(), "nq-sentry-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fetch = fakeFetch(issueRoutes({ title: "é".repeat(20000), extraTags: 500 }));
  const lines = [];
  await enrichJobOrigins({
    origins: [{ kind: "sentry", ref: "4507" }],
    orgId: home.orgId,
    integrations: { sentry: { onClosed: "resolved" } },
    dir,
    env: home.env,
    fetchImpl: fetch.impl,
    log: (line) => lines.push(line),
  });
  assert.deepEqual(lines, ["origin: sentry 4507 (connection: sn)"]);
  const written = readFileSync(join(dir, "sentry-4507.md"), "utf8");
  assert.ok(Buffer.byteLength(written, "utf8") <= ORIGIN_MAX_BYTES);
  assert.ok(written.endsWith("[truncated]"));
  const [newest] = eventSections(written);
  assert.match(newest, /^### Event 1 of 3 — 2026-09-30T19:00:00Z e0:/);
  assert.equal(linesMatching(newest, /^- src\/f\d+\.js:/).length, 30, "the newest event's frames survive the cap");
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

test("onClosed on a job resolved without change sets the onClosed status and notes the conclusion, never a pull request or a sha", async () => {
  const conclusion = "The crash comes from a browser extension, not from this code.";
  for (const [settings, status] of [[{}, "resolved"], [{ onClosed: "resolvedInNextRelease" }, "resolvedInNextRelease"]]) {
    const fetch = fakeFetch(issueRoutes());
    const answer = await sentry.onClosed({
      ref: "4507",
      job: { id: 1, ref: "J-1", title: "fix the crash", project: "alpha" },
      result: { prUrl: null, prNumber: null, mergeSha: null, resolution: "no-change", conclusion },
      settings,
      slot: { ...RECORD, name: "sn" },
      connections: [],
      http: httpOf(fetch),
    });
    assert.deepEqual(answer, { status: "done", note: `issue 4507 marked ${status}` });
    assert.deepEqual(fetch.calls.map((call) => [call.method, call.body]), [
      ["PUT", JSON.stringify({ status })],
      ["POST", JSON.stringify({ text: `Resolved without a code change (J-1, nightqueue): ${conclusion}` })],
    ]);
    const note = fetch.calls[1].body;
    for (const word of ["Fixed by", "merged as", "pull request", "/pull/"]) assert.equal(note.includes(word), false, `the no-change note says ${word}`);
  }
});

test("the note of a no-change close carries the headline once and no instruction to confirm before closing", async () => {
  const notice = "✅ Resolved — no code change needed\n\nThe crash comes from an extension. Confirm it is still a single development event before closing.";
  const fetch = fakeFetch(issueRoutes());
  await sentry.onClosed({
    ref: "4507",
    job: { id: 1, ref: "J-1", title: "fix the crash", project: "alpha" },
    result: { prUrl: null, prNumber: null, mergeSha: null, resolution: "no-change", conclusion: noChangeConclusion(notice) },
    settings: {},
    slot: { ...RECORD, name: "sn" },
    connections: [],
    http: httpOf(fetch),
  });
  const { text } = JSON.parse(fetch.calls[1].body);
  assert.equal(text.match(/Resolved without a code change/gi).length, 1);
  assert.equal(/no code change/i.test(text), false, `the note repeats the headline: ${text}`);
  assert.equal(/confirm[\s\S]*before closing/i.test(text), false, `the note tells the operator to confirm: ${text}`);
  assert.ok(text.includes("The crash comes from an extension."));
});

test("the merge note ends with the OTA line on done and on warning, and has none on skipped or a no-change close", async () => {
  const merged = { prUrl: "https://github.com/acme/api/pull/7", prNumber: 7, mergeSha: MERGE_SHA };
  const head = "Fixed by https://github.com/acme/api/pull/7, merged as abc1234";
  const url = "https://expo.dev/accounts/acme/projects/app/updates/0f3c9a12-aaaa";
  const noteOf = async (result) => {
    const fetch = fakeFetch(issueRoutes());
    await sentry.onClosed({ ref: "4507", job: { id: 1, ref: "J-1", title: "fix the crash", project: "alpha" }, result, settings: {}, slot: { ...RECORD, name: "sn" }, connections: [], http: httpOf(fetch) });
    return JSON.parse(fetch.calls[1].body).text;
  };
  assert.equal(await noteOf({ ...merged, ota: { status: "done", branch: "production", groupId: "0f3c9a12-aaaa", url, note: null } }), `${head}\n\nOTA published to production (${url})`);
  assert.equal(await noteOf({ ...merged, ota: { status: "done", branch: "staging", groupId: "0f3c9a12", url: null, note: null } }), `${head}\n\nOTA published to staging`);
  assert.equal(await noteOf({ ...merged, ota: { status: "warning", branch: "production", groupId: null, url: null, note: "eas update exited 1\nError: bundling failed" } }), `${head}\n\nOTA failed: eas update exited 1`);
  assert.equal(await noteOf({ ...merged, ota: { status: "skipped", branch: "production", groupId: null, url: null, note: "expo.ota is off" } }), head);
  assert.equal(await noteOf({ ...merged, ota: null }), head);
  const noChange = await noteOf({ prUrl: null, prNumber: null, mergeSha: null, resolution: "no-change", conclusion: "Nothing to change.", ota: { status: "done", branch: "production", groupId: "g", url, note: null } });
  assert.equal(noChange.includes("OTA"), false, `the no-change note carries an OTA line: ${noChange}`);
});

test("closing a job queued from a sentry link resolves the issue, and a refused update leaves the job closed with a notice line", async (t) => {
  const home = sentryHome(t, "sentry-close");
  setIntegrations(home.env, home.projectId, { sentry: { onClosed: "resolved" } });

  const fetch = fakeFetch(issueRoutes());
  const { outcome, row } = await closeSentryJob(home, fetch);
  assert.equal(outcome.status, "closed");
  assert.deepEqual(outcome.postClose.steps[1], { name: "origin", status: "done", note: "sentry 4507: issue 4507 marked resolved" });
  assert.deepEqual(fetch.calls.map((call) => call.method), ["GET", "PUT", "POST"]);
  assert.equal(row.status, "closed");
  assert.deepEqual(JSON.parse(row.close).data.originsNotified, { "sentry 4507": true });
  assert.ok(!row.notice_md, "settle appends no Closed line to the notice");

  const failing = fakeFetch(issueRoutes({ put: 500 }));
  const failed = await closeSentryJob(home, failing);
  assert.equal(failed.outcome.status, "closed");
  assert.equal(failed.row.status, "closed");
  assert.match(failed.row.notice_md, /After close: origin warning - sentry 4507: issue 4507 not marked resolved \(HTTP 500\)/);
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
