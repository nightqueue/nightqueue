import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { testConnection } from "../../src/config/connections.mjs";
import { loadConfig, loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { requestJson } from "../../src/integrations/http.mjs";
import { detectOrigin, explicitOrigin } from "../../src/integrations/origin.mjs";
import { discord, noticeSummary } from "../../src/integrations/discord.mjs";
import { acquireClose, getJob } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, runClosePipeline } from "../../src/queue/close.mjs";
import { runPostCloseSteps } from "../../src/queue/close-start.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf, seedDoneJob } from "../../test-support/memory.mjs";
import { orgOfProject, setIntegrations } from "../../test-support/origin-provider.mjs";

const GUILD = "111";
const CHAT_CHANNEL = "222";
const OPS_CHANNEL = "333";
const THREAD = "444";
const MESSAGE = "555";
const CHAT_TOKEN = "chatWebhookSecretToken-0123";
const OPS_TOKEN = "opsWebhookSecretToken-4567";
const FAR_TOKEN = "farWebhookSecretToken-8910";
const CHAT_URL = `https://discord.com/api/webhooks/9001/${CHAT_TOKEN}`;
const OPS_URL = `https://discord.com/api/webhooks/9002/${OPS_TOKEN}`;
const FAR_URL = `https://discord.com/api/webhooks/9003/${FAR_TOKEN}`;
const SECRETS = [CHAT_TOKEN, OPS_TOKEN, FAR_TOKEN];
const MESSAGE_LINK = `https://discord.com/channels/${GUILD}/${CHAT_CHANNEL}/${MESSAGE}`;
const MERGE_SHA = "abc1234def5678";
const WORKER = "close:test:1:discord";
const POST_STEPS = CLOSE_STEPS.filter((step) => step.required === false);
const CHAT = { type: "discord", url: CHAT_URL, channelId: CHAT_CHANNEL, guildId: GUILD, mode: "webhook", name: "chat" };
const OPS = { type: "discord", url: OPS_URL, channelId: OPS_CHANNEL, guildId: GUILD, mode: "webhook", name: "ops" };
const FAR = { type: "discord", url: FAR_URL, channelId: "777", guildId: "999", mode: "webhook", name: "far" };
const RESULT = { prUrl: "https://github.com/acme/api/pull/7", prNumber: 7, mergeSha: MERGE_SHA, mergedAt: "2026-05-01T10:00:00.000Z" };
const JOB = { id: 1, ref: "J-1", title: "fix the crash", project: "alpha" };

// A fake fetch recording every call and answering by `METHOD url` route, 404 for a route it does not know.
function fakeFetch(routes = {}) {
  const calls = [];
  const impl = async (url, options) => {
    const method = options.method ?? "GET";
    calls.push({ url, method, body: options.body ? JSON.parse(options.body) : null });
    const route = routes[`${method} ${url}`] ?? { status: 404 };
    return { status: route.status ?? 200, headers: new Map(), json: async () => route.body ?? {} };
  };
  return { impl, calls };
}

// The webhook GET routes of the fixture connections.
function webhookRoutes() {
  return {
    [`GET ${CHAT_URL}`]: { body: { channel_id: CHAT_CHANNEL, guild_id: GUILD, token: CHAT_TOKEN } },
    [`GET ${OPS_URL}`]: { body: { channel_id: OPS_CHANNEL, guild_id: GUILD, token: OPS_TOKEN } },
    [`GET ${FAR_URL}`]: { body: { channel_id: "777", guild_id: "999", token: FAR_TOKEN } },
  };
}

// The http a provider receives, bound to a fake fetch.
function httpOf(fetch) {
  return (url, options = {}) => requestJson(fetch.impl, url, options);
}

// Asserts no fixture webhook token appears in a value.
function assertNoSecret(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of SECRETS) assert.ok(!text.includes(secret), `a webhook token leaked: ${text}`);
}

// Runs the CLI in this process with a stdin and a fetch, collecting what it printed.
async function runCli(env, argv, { input = "", fetch = fakeFetch(webhookRoutes()) } = {}) {
  const out = [];
  const err = [];
  const stdin = Readable.from([input]);
  const context = { ...defaultContext(), env, stdin, fetchImpl: fetch.impl, out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await run(argv, context);
  return { code, out, err };
}

// A home with project `alpha` whose org lists the discord webhooks `chat` and `ops`.
async function discordHome(t, name) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  for (const [hook, url] of [["chat", CHAT_URL], ["ops", OPS_URL]]) {
    const added = await runCli(env, ["connection", "add", hook, "--type", "discord"], { input: `${url}\n` });
    assert.equal(added.code, 0, added.err.join("\n"));
  }
  return { env, checkout, projectId, orgId: orgOfProject(env, projectId), store: openStore(env) };
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

// Closes a done job queued from the discord message link with the fake pre-close steps and the real post-close ones.
async function closeDiscordJob(home, fetch) {
  const id = seedDoneJob(home.env, {
    prompt: `the bot crashes, reported in ${MESSAGE_LINK}`,
    slug: "bot-crash",
    noticeMd: "✅ Fixed — the bot no longer crashes on an empty message\n\nWhat was done: an empty message is now ignored. Nothing else changed.",
  });
  acquireClose(id, { worker: WORKER, leaseS: 660 }, home.env);
  const outcome = await runClosePipeline({
    store: home.store,
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
  return { id, outcome, row: getJob(id, home.env) };
}

// Calls the provider's close action with the fixture job and merge.
async function replyWith(routes, { ref = `${GUILD}/${CHAT_CHANNEL}/${MESSAGE}`, settings = {}, connections = [CHAT, OPS, FAR] } = {}) {
  const fetch = fakeFetch(routes);
  const answer = await discord.onClosed({ ref, job: JOB, result: RESULT, settings, slot: null, connections, http: httpOf(fetch) });
  return { answer, calls: fetch.calls };
}

test("a discord message link is an origin `<guild>/<channel>/<message>`; a bare triple only when given explicitly", () => {
  const parse = (text, options) => discord.origin.parse(text, options);
  assert.equal(parse(`see ${MESSAGE_LINK}`), "111/222/555");
  assert.equal(parse("https://ptb.discord.com/channels/1/2/3"), "1/2/3");
  assert.equal(parse("https://canary.discordapp.com/channels/4/5/6"), "4/5/6");
  assert.equal(parse("https://discord.com/channels/1/2"), null);
  assert.equal(parse("https://notdiscord.com/channels/1/2/3"), null);
  assert.equal(parse("ratio 1/2/3 in prose"), null);
  assert.equal(parse("1/2/3", { explicit: true }), "1/2/3");
  assert.deepEqual(detectOrigin(`the bot crashes, see ${MESSAGE_LINK}`), { kind: "discord", ref: "111/222/555" });
  assert.deepEqual(explicitOrigin({ kind: "discord", ref: "111/222/555" }), { kind: "discord", ref: "111/222/555" });
  assert.deepEqual(explicitOrigin({ kind: "discord", ref: MESSAGE_LINK }), { kind: "discord", ref: "111/222/555" });
  assert.throws(() => explicitOrigin({ kind: "discord", ref: "general" }), /is not a discord reference/);
});

test("connection add --type discord derives the channel and guild, refuses a bad or unreadable URL without echoing it, and lists no URL", async (t) => {
  const env = makeHome(t, "discord-connection-add");
  makeProject(t, env, "alpha");
  const badUrl = `https://example.com/api/webhooks/1/${CHAT_TOKEN}`;
  const fetch = fakeFetch(webhookRoutes());
  const bad = await runCli(env, ["connection", "add", "chat", "--type", "discord"], { input: `${badUrl}\n`, fetch });
  assert.equal(bad.code, 1);
  assert.match(bad.err.join("\n"), /the secret is not a Discord webhook URL .*; nothing was stored/);
  assert.equal(fetch.calls.length, 0);
  const unreadableUrl = `https://discord.com/api/webhooks/9999/${CHAT_TOKEN}`;
  const unreadable = await runCli(env, ["connection", "add", "chat", "--type", "discord"], { input: `${unreadableUrl}\n` });
  assert.equal(unreadable.code, 1);
  assert.match(unreadable.err.join("\n"), /the Discord webhook could not be read \(HTTP 404\); nothing was stored/);
  assert.equal(loadSecrets(env, { warn: () => {} }).connections.chat, undefined);

  const added = await runCli(env, ["connection", "add", "chat", "--type", "discord"], { input: `${CHAT_URL}\n` });
  assert.equal(added.code, 0, added.err.join("\n"));
  assert.match(added.out.join("\n"), /stored connection `chat` \(discord\) and bound it to org `default`/);
  assert.deepEqual(loadSecrets(env, { warn: () => {} }).connections.chat, { type: "discord", url: CHAT_URL, channelId: CHAT_CHANNEL, guildId: GUILD, mode: "webhook" });
  const second = await runCli(env, ["connection", "add", "ops", "--type", "discord"], { input: `${OPS_URL}\n` });
  assert.equal(second.code, 0, second.err.join("\n"));
  assert.deepEqual(second.err, [], "a many type never warns about an occupied slot");

  const list = await runCli(env, ["connection", "list"]);
  const json = await runCli(env, ["connection", "list", "--json"]);
  assert.deepEqual(list.out, ["chat  discord  orgs=default", "ops  discord  orgs=default"]);
  assert.deepEqual(JSON.parse(json.out[0]).connections.map((row) => Object.keys(row)), [["name", "type", "present", "orgs"], ["name", "type", "present", "orgs"]]);
  const orgs = await runCli(env, ["org", "list"]);
  assert.match(orgs.out.join("\n"), /github=- sentry=- discord=chat,ops/);

  const tested = await testConnection({ name: "chat", secrets: loadSecrets(env, { warn: () => {} }), fetchImpl: fakeFetch(webhookRoutes()).impl });
  assert.deepEqual(tested, { type: "discord", ok: true, status: 200, channelId: CHAT_CHANNEL, guildId: GUILD, detail: "ok" });
  assert.equal(discord.connection.summary(tested), `channel=${CHAT_CHANNEL} guild=${GUILD}`);
  const testLine = await runCli(env, ["connection", "test", "chat"]);
  assert.deepEqual(testLine.out, [`chat (discord): ok — channel=${CHAT_CHANNEL} guild=${GUILD}`]);
  assertNoSecret([bad, unreadable, added, second, list, json, orgs, tested, testLine]);
});

test("a discord connection binds to many orgs once each, and removing it unbinds it from every list", async (t) => {
  const env = makeHome(t, "discord-binding");
  makeProject(t, env, "alpha");
  assert.equal((await runCli(env, ["org", "add", "other", "--key", "OTH"])).code, 0);
  await runCli(env, ["connection", "add", "chat", "--type", "discord"], { input: `${CHAT_URL}\n` });
  await runCli(env, ["connection", "add", "ops", "--type", "discord"], { input: `${OPS_URL}\n` });
  for (let round = 0; round < 2; round += 1) {
    const bound = await runCli(env, ["connection", "bind", "ops", "--org", "other"]);
    assert.deepEqual(bound.out, ["bound `ops` to org `other` (discord)"]);
  }
  const orgs = (await runCli(env, ["org", "list"])).out.join("\n");
  assert.match(orgs, /default .*discord=chat,ops/);
  assert.match(orgs, /other .*discord=ops /);

  const removed = await runCli(env, ["connection", "remove", "ops"]);
  assert.deepEqual(removed.out, ["removed connection `ops`; unbound from: default, other"]);
  const lists = Object.values(loadConfig(env, { warn: () => {} }).orgConnections).map((slots) => slots.discord);
  assert.deepEqual(lists, [["chat"], []]);
  assert.match((await runCli(env, ["org", "list"])).out.join("\n"), /other .*discord=- /);
});

test("coverage names the org webhook posting in the message's channel, otherwise none with the thread probe", () => {
  const visible = [CHAT, OPS, FAR].map(({ url, ...fields }) => fields);
  assert.deepEqual(discord.covers(`${GUILD}/${CHAT_CHANNEL}/${MESSAGE}`, { slot: null, connections: visible }), { connection: "chat", detail: null });
  assert.deepEqual(discord.covers(`${GUILD}/${THREAD}/${MESSAGE}`, { slot: null, connections: visible }), {
    connection: null,
    detail: `thread or other channel: probes the org's webhooks of guild ${GUILD} at close (2)`,
  });
});

test("the reply posts in the matching channel, else probes the guild's webhooks as a thread until one posts, never mentioning anyone", async () => {
  const byChannel = await replyWith({ [`POST ${CHAT_URL}?wait=true`]: {} });
  assert.deepEqual(byChannel.answer, { status: "done", note: `replied in channel ${CHAT_CHANNEL} through chat` });
  assert.deepEqual(byChannel.calls.map((call) => call.url), [`${CHAT_URL}?wait=true`]);
  assert.deepEqual(byChannel.calls[0].body, {
    content: "",
    embeds: [{
      title: "Fixed · J-1",
      description: "fix the crash",
      url: RESULT.prUrl,
      fields: [{ name: "Reported", value: `[message](${MESSAGE_LINK})` }],
      footer: { text: "merged as abc1234" },
      timestamp: RESULT.mergedAt,
      color: 0x2ECC71,
    }],
    allowed_mentions: { parse: [] },
  });
  assert.doesNotMatch(byChannel.calls[0].body.content, /http/);
  assert.equal(byChannel.calls[0].body.embeds[0].url, RESULT.prUrl);

  const threadRef = `${GUILD}/${THREAD}/${MESSAGE}`;
  const probed = await replyWith({ [`POST ${CHAT_URL}?wait=true&thread_id=${THREAD}`]: { status: 400 }, [`POST ${OPS_URL}?wait=true&thread_id=${THREAD}`]: {} }, { ref: threadRef });
  assert.deepEqual(probed.answer, { status: "done", note: `replied in thread ${THREAD} through ops` });
  assert.deepEqual(probed.calls.map((call) => call.url), [`${CHAT_URL}?wait=true&thread_id=${THREAD}`, `${OPS_URL}?wait=true&thread_id=${THREAD}`]);

  const firstWins = await replyWith({ [`POST ${CHAT_URL}?wait=true&thread_id=${THREAD}`]: {} }, { ref: threadRef });
  assert.equal(firstWins.calls.length, 1);

  const refused = await replyWith({}, { ref: threadRef });
  assert.deepEqual(refused.answer, { status: "skipped", note: `no webhook of the org can post in channel ${THREAD}`, notice: true });
  assert.equal(refused.calls.length, 2, "the webhook of another guild is never tried");

  const limited = await replyWith({ [`POST ${CHAT_URL}?wait=true&thread_id=${THREAD}`]: { status: 429 } }, { ref: threadRef });
  assert.deepEqual(limited.answer, { status: "warning", note: `reply in thread ${THREAD} not posted through chat (HTTP 429)` });
  assert.equal(limited.calls.length, 1);
  const failing = await replyWith({ [`POST ${CHAT_URL}?wait=true`]: { status: 502 } });
  assert.deepEqual(failing.answer, { status: "warning", note: `reply in channel ${CHAT_CHANNEL} not posted through chat (HTTP 502)` });

  const off = await replyWith({}, { settings: { replyToOrigin: false } });
  assert.deepEqual(off.answer, { status: "skipped", note: "replyToOrigin is false" });
  assert.equal(off.calls.length, 0);
  assertNoSecret([byChannel.answer, probed.answer, refused.answer, limited.answer, failing.answer, off.answer]);
});

test("the log posts the closed job once to its webhook as one embed, cut to Discord's limits, and skips any other event", async () => {
  const fetch = fakeFetch({ [`POST ${OPS_URL}?wait=true`]: {} });
  const logged = await discord.log({ event: "closed", job: { ...JOB, title: "fix(crash): the crash", slug: "the-crash" }, result: RESULT, settings: {}, connection: OPS, http: httpOf(fetch) });
  assert.deepEqual(logged, { status: "done", note: "logged through ops" });
  assert.deepEqual(fetch.calls[0].body, {
    content: "",
    embeds: [{
      title: "J-1 closed · the-crash",
      description: "fix(crash): the crash",
      url: RESULT.prUrl,
      fields: [
        { name: "PR", value: `[#7](${RESULT.prUrl})`, inline: true },
        { name: "Project", value: "alpha", inline: true },
      ],
      footer: { text: "merged as abc1234" },
      timestamp: RESULT.mergedAt,
      color: 0x2ECC71,
    }],
    allowed_mentions: { parse: [] },
  });
  assert.doesNotMatch(fetch.calls[0].body.content, /http/);
  assert.equal(fetch.calls[0].body.embeds[0].url, RESULT.prUrl);
  await discord.log({ event: "closed", job: { ...JOB, slug: "x".repeat(5000), title: "x".repeat(5000) }, result: RESULT, settings: {}, connection: OPS, http: httpOf(fetch) });
  assert.equal(fetch.calls[1].body.embeds[0].title.length, 256);
  assert.ok(fetch.calls[1].body.embeds[0].title.endsWith("…"));
  assert.equal(fetch.calls[1].body.embeds[0].description.length, 4096);
  const bare = await discord.log({ event: "closed", job: JOB, result: {}, settings: {}, connection: OPS, http: httpOf(fetch) });
  assert.equal(bare.status, "done");
  const [degraded] = fetch.calls[2].body.embeds;
  assert.equal(degraded.url, undefined);
  assert.equal(degraded.timestamp, undefined);
  assert.equal(degraded.fields[0].value, "the merged pull request");
  assert.equal(degraded.footer.text, "merged as unknown");
  const other = await discord.log({ event: "failed", job: JOB, result: RESULT, settings: {}, connection: OPS, http: httpOf(fetch) });
  assert.equal(other.status, "skipped");
  assert.equal(fetch.calls.length, 3);
  const refused = await discord.log({ event: "closed", job: JOB, result: RESULT, settings: {}, connection: OPS, http: httpOf(fakeFetch()) });
  assert.deepEqual(refused, { status: "warning", note: "log not posted through ops (HTTP 404)" });
});

// A notice in the real shape: headline, other paragraphs, "What was done:", and the closing lines.
function noticeOf(header, done) {
  return `${header}\n\nWhat was missing: something.\n\nWhat was done: ${done}\n\nHow it was validated: tests.\n\nRecord: • PR https://x/pull/1\nClosed: PR #1 merged as abc1234 on 2026-10-02`;
}

const CLOSED_JOBS = [
  { ref: "J-115", slug: "tracker-renamed-to-issues-across", title: "refactor(memory): the issues rename migrates as schema v22", pr: 38,
    header: "✅ Delivered — the project tracker is now called \"issues\" everywhere, and existing databases migrate in place",
    done: "the tracker is now \"issues\" in the command line, the assistant tools, the prompts and the docs, released as 0.6.0 with a Breaking note. Existing databases are converted on first open.",
    headline: "the project tracker is now called \"issues\" everywhere, and existing databases migrate in place",
    firstDone: "the tracker is now \"issues\" in the command line, the assistant tools, the prompts and the docs, released as 0.6.0 with a Breaking note." },
  { ref: "J-116", slug: "migrate-only-in-setup-update", title: "fix(store): migrate the home schema only in setup/update, never on open", pr: 41,
    header: "✅ Fixed — goes out in the next release",
    done: "opening the database never upgrades it now. An older database is refused untouched.",
    headline: "goes out in the next release", firstDone: "opening the database never upgrades it now.",
    line1: "Migrate the home schema only in setup/update, never on open" },
  { ref: "J-117", slug: "task-queue-status-carries-a-derived", title: "refactor(queue): queue_status carries a derived live block per running job", pr: 42,
    header: "✅ Delivered — the queue status now shows what each running job is doing right now",
    done: "one shared calculation, read on demand from the job's log, now feeds both the terminal and the tool. Running jobs carry the live view.",
    headline: "the queue status now shows what each running job is doing right now",
    firstDone: "one shared calculation, read on demand from the job's log, now feeds both the terminal and the tool." },
  { ref: "J-118", slug: "discord-embeds", title: "chore(discord): webhook posts are embeds, not text with bare links", pr: 43,
    header: "✅ Delivered — Discord posts are now cards instead of text with bare links",
    done: "both messages are now one compact card each. The card has a clickable title.",
    headline: "Discord posts are now cards instead of text with bare links", firstDone: "both messages are now one compact card each." },
  { ref: "J-119", slug: "close-steps-again", title: "chore(close): queue close --steps --again re-runs post-close steps", pr: 44,
    header: "✅ Delivered — closing a job can now re-send its follow-up messages on request",
    done: "a new \"again\" option, used together with the list of steps to re-run, sends those steps' messages one more time. A later re-run without it stays silent again.",
    headline: "closing a job can now re-send its follow-up messages on request",
    firstDone: "a new \"again\" option, used together with the list of steps to re-run, sends those steps' messages one more time." },
];

test("noticeSummary reads the headline and first sentence of the five closed jobs J-115..J-119", () => {
  for (const job of CLOSED_JOBS) {
    assert.deepEqual(noticeSummary(noticeOf(job.header, job.done)), { headline: job.headline, firstDone: job.firstDone }, job.ref);
  }
});

test("noticeSummary: no What was done paragraph, blank notice, a Partially fixed header and the e.g. abbreviation", () => {
  assert.deepEqual(noticeSummary("✅ Fixed — the crash is gone for every user"), { headline: "the crash is gone for every user", firstDone: null });
  assert.deepEqual(noticeSummary("✅ Partially fixed — the crash is gone for most users\n\nWhat was done: a guard."), { headline: "the crash is gone for most users", firstDone: "a guard." });
  assert.equal(noticeSummary(""), null);
  assert.equal(noticeSummary("  \n \n"), null);
  assert.equal(noticeSummary(undefined), null);
  assert.deepEqual(noticeSummary("✅ Delivered — a headline with enough words\n\nWhat was done: fields such as e.g. the title are cut."), { headline: "a headline with enough words", firstDone: "fields such as e.g." });
  assert.equal(noticeSummary("✅ Delivered — a headline with enough words\n\nWhat was done: is it? yes!").firstDone, "is it?");
});

test("the closed card of J-117 is titled by ref and slug, described by the full PR title and the first sentence", async () => {
  const [, , j117] = CLOSED_JOBS;
  const job = { id: 2, ref: j117.ref, slug: j117.slug, title: j117.title, project: "nightqueue", notice_md: noticeOf(j117.header, j117.done) };
  const result = { prUrl: "https://github.com/acme/nightqueue/pull/42", prNumber: 42, mergeSha: "2e2e7aa1234", mergedAt: "2026-10-02T10:00:00.000Z" };
  const fetch = fakeFetch({ [`POST ${OPS_URL}?wait=true`]: {} });
  await discord.log({ event: "closed", job, result, settings: {}, connection: OPS, http: httpOf(fetch) });
  const [embed] = fetch.calls[0].body.embeds;
  assert.equal(embed.title, "J-117 closed · task-queue-status-carries-a-derived");
  assert.equal(embed.url, result.prUrl);
  assert.equal(embed.description, "refactor(queue): queue_status carries a derived live block per running job\nOne shared calculation, read on demand from the job's log, now feeds both the terminal and the tool.");
  assert.deepEqual(embed.fields.map((field) => [field.name, field.value, field.inline]), [["PR", `[#42](${result.prUrl})`, true], ["Project", "nightqueue", true]]);
  assert.equal(embed.footer.text, "merged as 2e2e7aa");
  assert.equal(embed.timestamp, result.mergedAt);
});

test("the closed card keeps the full PR title for a weak headline, a missing notice, a notice without What was done, and a missing slug", async () => {
  const [, j116] = CLOSED_JOBS;
  const describe = async (job) => {
    const fetch = fakeFetch({ [`POST ${OPS_URL}?wait=true`]: {} });
    await discord.log({ event: "closed", job: { ...JOB, ...job }, result: RESULT, settings: {}, connection: OPS, http: httpOf(fetch) });
    return fetch.calls[0].body.embeds[0];
  };
  const weak = await describe({ title: j116.title, notice_md: noticeOf(j116.header, j116.done) });
  assert.equal(weak.description, "fix(store): migrate the home schema only in setup/update, never on open\nOpening the database never upgrades it now.");
  assert.equal(weak.title, "J-1 closed");
  const noNotice = await describe({ title: j116.title, slug: "migrate-only-in-setup-update" });
  assert.equal(noNotice.description, "fix(store): migrate the home schema only in setup/update, never on open");
  assert.equal(noNotice.title, "J-1 closed · migrate-only-in-setup-update");
  const noDone = await describe({ title: "fix the crash", notice_md: "✅ Fixed — the crash is gone for every user" });
  assert.equal(noDone.description, "fix the crash");
});

test("closing a job queued from a discord link replies and logs once; a --steps re-run posts nothing again", async (t) => {
  const home = await discordHome(t, "discord-close");
  const set = await runCli(home.env, ["project", "integrations", "alpha", "set", "discord.log.connection=ops"]);
  assert.equal(set.code, 0, set.err.join("\n"));

  const fetch = fakeFetch({ [`POST ${CHAT_URL}?wait=true`]: {}, [`POST ${OPS_URL}?wait=true`]: {} });
  const { id, outcome, row } = await closeDiscordJob(home, fetch);
  assert.equal(outcome.status, "closed");
  assert.deepEqual(outcome.postClose.steps, [
    { name: "origin", status: "done", note: `replied in channel ${CHAT_CHANNEL} through chat` },
    { name: "log", status: "done", note: "discord: logged through ops" },
  ]);
  assert.deepEqual(fetch.calls.map((call) => [call.method, call.url]), [["POST", `${CHAT_URL}?wait=true`], ["POST", `${OPS_URL}?wait=true`]]);
  assert.match(fetch.calls[1].body.embeds[0].title, /^J-\d+ closed · bot-crash$/);
  assert.equal(fetch.calls[1].body.embeds[0].description, "fix the crash\nAn empty message is now ignored.");
  assert.equal(fetch.calls[0].body.embeds[0].description, "fix the crash\nAn empty message is now ignored.");
  assert.doesNotMatch(fetch.calls[1].body.content, /http/);
  assert.equal(fetch.calls[1].body.embeds[0].url, RESULT.prUrl);
  const checklist = JSON.parse(row.close);
  assert.equal(checklist.data.originNotified, true);
  assert.deepEqual(checklist.data.logged, { discord: true });
  assert.equal(row.status, "closed");

  const again = fakeFetch();
  const rerun = await runPostCloseSteps({ store: home.store, id, names: ["log", "origin"], env: home.env, deps: { fetch: again.impl } });
  assert.deepEqual(rerun.steps, [
    { name: "origin", status: "done", note: "already notified" },
    { name: "log", status: "done", note: "discord: already logged" },
  ]);
  assert.equal(again.calls.length, 0);
  assertNoSecret([outcome, getJob(id, home.env)]);
});

test("discord.replyToOrigin=false sends no reply, and an unset replyToOrigin replies by default", async (t) => {
  const home = await discordHome(t, "discord-reply-off");
  setIntegrations(home.env, home.projectId, { discord: { replyToOrigin: false } });
  const silent = fakeFetch();
  const off = await closeDiscordJob(home, silent);
  assert.deepEqual(off.outcome.postClose.steps, [
    { name: "origin", status: "skipped", note: "replyToOrigin is false" },
    { name: "log", status: "skipped", note: "no log destination" },
  ]);
  assert.equal(silent.calls.length, 0);
  assert.match(off.row.notice_md, /\n\nClosed: PR #7 merged as abc1234 on 2026-10-01$/);

  const unset = await runCli(home.env, ["project", "integrations", "alpha", "unset", "discord.replyToOrigin"]);
  assert.deepEqual(unset.out, ["no integrations"]);
  setIntegrations(home.env, home.projectId, { discord: { log: { events: ["closed"] } } });
  const replying = fakeFetch({ [`POST ${CHAT_URL}?wait=true`]: {} });
  const on = await closeDiscordJob(home, replying);
  assert.equal(on.outcome.postClose.steps[0].status, "done");
  assert.deepEqual(replying.calls.map((call) => call.url), [`${CHAT_URL}?wait=true`]);
});

test("a thread nobody of the org can post in leaves the job closed with a notice line and no URL", async (t) => {
  const home = await discordHome(t, "discord-no-poster");
  setIntegrations(home.env, home.projectId, { discord: { replyToOrigin: true } });
  const id = seedDoneJob(home.env, { prompt: `see https://discord.com/channels/${GUILD}/${THREAD}/${MESSAGE}` });
  acquireClose(id, { worker: WORKER, leaseS: 660 }, home.env);
  const fetch = fakeFetch({ [`POST ${CHAT_URL}?wait=true&thread_id=${THREAD}`]: { status: 400 }, [`POST ${OPS_URL}?wait=true&thread_id=${THREAD}`]: { status: 403 } });
  const outcome = await runClosePipeline({
    store: home.store,
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
  const row = getJob(id, home.env);
  assert.equal(outcome.status, "closed");
  assert.equal(row.status, "closed");
  assert.match(row.notice_md, new RegExp(`After close: origin skipped - no webhook of the org can post in channel ${THREAD}`));
  assertNoSecret([outcome, row]);
});

test("project integrations takes the four discord keys and refuses a log connection of another type or another org", async (t) => {
  const home = await discordHome(t, "discord-settings");
  assert.equal((await runCli(home.env, ["org", "add", "other", "--key", "OTH"])).code, 0);
  assert.equal((await runCli(home.env, ["connection", "add", "far", "--type", "discord", "--org", "other"], { input: `${FAR_URL}\n` })).code, 0);
  const secrets = loadSecrets(home.env, { warn: () => {} });
  secrets.connections.gh = { type: "github", token: "ghp_not_a_webhook" };
  saveSecrets(secrets, home.env);

  const set = await runCli(home.env, ["project", "integrations", "alpha", "set", "discord.log.connection=ops", "discord.log.events=closed", "discord.replyToOrigin=false"]);
  assert.equal(set.code, 0, set.err.join("\n"));
  assert.deepEqual(set.out, ["discord.log.connection=ops", "discord.log.events=closed", "discord.replyToOrigin=false"]);

  const otherOrg = await runCli(home.env, ["project", "integrations", "alpha", "set", "discord.log.connection=far"]);
  assert.equal(otherOrg.code, 1);
  assert.match(otherOrg.err.join("\n"), /connection `far` is not bound to the project's org/);
  const otherType = await runCli(home.env, ["project", "integrations", "alpha", "set", "discord.log.connection=gh"]);
  assert.equal(otherType.code, 1);
  assert.match(otherType.err.join("\n"), /`discord\.log\.connection` needs a discord connection; `gh` is a github connection/);
  const badEvent = await runCli(home.env, ["project", "integrations", "alpha", "set", "discord.log.events=done"]);
  assert.match(badEvent.err.join("\n"), /`discord\.log\.events` takes a comma-separated list of: closed/);
  assertNoSecret([set, otherOrg, otherType, badEvent, await runCli(home.env, ["project", "integrations", "alpha", "show", "--json"])]);
});
