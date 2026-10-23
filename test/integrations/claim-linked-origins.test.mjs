import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { jobLogPath, runDir } from "../../src/config/paths.mjs";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { enrichJobOrigins } from "../../src/integrations/enrich.mjs";
import { parseOriginsColumn } from "../../src/integrations/origin.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { fakeJobWorktree } from "../../test-support/job-worktree.mjs";
import { makeDir, makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { orgOfProject, setIntegrations } from "../../test-support/origin-provider.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const LINEAR_API = "https://api.linear.app/graphql";
const SENTRY_API = "https://sentry.io/api/0/organizations/acme";
const LINEAR_KEY = "lin_api_secret_0123456789";
const SENTRY_TOKEN = "sntrys_secret_token_0123456789";
const DISCORD_URL = "https://discord.com/channels/814481167675817994/1535014196964757784/1536811008176169001";
const DISCORD_REF = "814481167675817994/1535014196964757784/1536811008176169001";
const SENTRY_URL = "https://acme.sentry.io/issues/4507/";
const GITHUB_PR_URL = "https://github.com/acme/api/pull/9";
const OTHER_LINEAR_URL = "https://linear.app/acme/issue/MK-7/other";

// A Linear issue DLW-99 with the given attachment urls, description and comments.
function issueWith({ attachments = [], description = "", comments = [] } = {}) {
  return {
    id: "uuid-99",
    identifier: "DLW-99",
    title: "Crash on boot",
    description,
    state: { name: "Todo", type: "unstarted" },
    labels: { nodes: [] },
    attachments: { nodes: attachments.map((url) => ({ title: "linked", url })) },
    comments: { nodes: comments.map((body) => ({ body, createdAt: "2026-10-01T10:00:00Z", user: { name: "Ana" } })) },
    team: { key: "DLW" },
  };
}

// A fake fetch answering the Linear issue query and the Sentry issue reads, recording every url.
function fakeFetch(issue) {
  const calls = [];
  const sentry = {
    [`${SENTRY_API}/issues/4507/`]: { shortId: "API-12", title: "TypeError", count: "1", userCount: 1 },
    [`${SENTRY_API}/issues/4507/events/?full=true&per_page=3`]: [{ eventID: "e0", title: "TypeError", entries: [], tags: [] }],
  };
  const impl = async (url) => {
    calls.push(url);
    if (url === LINEAR_API) return { status: 200, headers: new Map(), json: async () => ({ data: { issue } }) };
    const body = sentry[url];
    return { status: body ? 200 : 404, headers: new Map(), json: async () => body ?? {} };
  };
  return { impl, calls };
}

// A home with project `alpha`, the home's Linear connection and, when asked, the org's Sentry connection enabled on the project.
function linkedHome(t, name, { sentry = false } = {}) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const orgId = orgOfProject(env, projectId);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.linear = { type: "linear", apiKey: LINEAR_KEY };
  if (sentry) secrets.connections.sn = { type: "sentry", token: SENTRY_TOKEN, org: "acme", url: "https://sentry.io" };
  saveSecrets(secrets, env);
  if (sentry) {
    const config = loadConfig(env, { warn: () => {} });
    config.orgConnections[orgId] = { ...(config.orgConnections[orgId] ?? {}), sentry: "sn" };
    saveConfig(config, env);
    setIntegrations(env, projectId, { sentry: { onClosed: "resolved" } });
  }
  return { env, projectId, orgId };
}

// The origin files written under every run directory of a project.
function originFilesOf(env, projectId) {
  const runs = dirname(runDir(projectId, "any", env));
  return readdirSync(runs).flatMap((slug) => {
    const dir = join(runs, slug, "origin");
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  });
}

// Queues a job on Linear DLW-99 and runs one cycle with the fake fetch, answering the job id.
async function runLinearJob(t, home, fetch) {
  useFakeClaude(home.env, makeDir(t, "linked-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const { id } = addJob({ projectId: home.projectId, prompt: "fix the crash", origin: [{ kind: "linear", ref: "DLW-99" }] }, home.env);
  const gitImpl = ({ args }) => `${{ status: "", "rev-parse": "main", "symbolic-ref": "origin/main" }[args[0]]}\n`;
  const cycle = await runCycle({ jobId: id, env: home.env, deps: { worktreeImpl: fakeJobWorktree(), gitImpl, fetch: fetch.impl } });
  assert.equal(cycle.processed[0].status, "done");
  return id;
}

// A temp origin directory removed after the test.
function originDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "nq-linked-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a claimed Linear job links the Sentry and Discord origins of its attachments, writes them back and enriches Sentry", async (t) => {
  const home = linkedHome(t, "linked-claim", { sentry: true });
  const fetch = fakeFetch(issueWith({ attachments: [SENTRY_URL, DISCORD_URL, GITHUB_PR_URL, OTHER_LINEAR_URL, SENTRY_URL] }));
  const id = await runLinearJob(t, home, fetch);
  const origins = parseOriginsColumn(getJob(id, home.env).origin);
  assert.deepEqual(origins, [{ kind: "linear", ref: "DLW-99" }, { kind: "sentry", ref: "4507" }, { kind: "discord", ref: DISCORD_REF }]);
  assert.deepEqual(originFilesOf(home.env, home.projectId), ["linear-DLW-99.md", "sentry-4507.md"]);
  const log = readFileSync(jobLogPath(id, home.env), "utf8");
  assert.ok(log.includes(`origin linked by linear DLW-99: sentry 4507, discord ${DISCORD_REF}`), log);
  assert.ok(log.includes("origin: sentry 4507 (connection: sn)"), log);
  assert.equal(log.includes(LINEAR_KEY) || log.includes(SENTRY_TOKEN), false);
  assert.equal(fetch.calls.filter((url) => url === LINEAR_API).length, 1);
});

test("a claimed Linear job links a Discord thread attachment (guild/thread, no message id)", async (t) => {
  const home = linkedHome(t, "linked-thread");
  const fetch = fakeFetch(issueWith({ attachments: ["https://discord.com/channels/1526962439235698809/1559284125926555688"] }));
  const id = await runLinearJob(t, home, fetch);
  const origins = parseOriginsColumn(getJob(id, home.env).origin);
  assert.deepEqual(origins, [{ kind: "linear", ref: "DLW-99" }, { kind: "discord", ref: "1526962439235698809/1559284125926555688" }]);
  const log = readFileSync(jobLogPath(id, home.env), "utf8");
  assert.ok(log.includes("origin linked by linear DLW-99: discord 1526962439235698809/1559284125926555688"), log);
});

test("an attachment no origin recognises is logged as ignored, never with a webhook token or query", async (t) => {
  const home = linkedHome(t, "linked-ignored");
  const webhook = "https://discord.com/api/webhooks/123/SECRET_TOKEN_abc";
  const fetch = fakeFetch(issueWith({ attachments: [GITHUB_PR_URL, `${GITHUB_PR_URL}?token=QUERY_SECRET`, webhook, "not a url"] }));
  const id = await runLinearJob(t, home, fetch);
  const log = readFileSync(jobLogPath(id, home.env), "utf8");
  assert.ok(log.includes(`origin: ignored linked link ${GITHUB_PR_URL} (not a known origin)`), log);
  assert.ok(log.includes("origin: ignored linked link https://discord.com/api/webhooks/<redacted> (not a known origin)"), log);
  assert.ok(log.includes("origin: ignored linked link <not a url> (not a known origin)"), log);
  assert.equal(/SECRET_TOKEN_abc|QUERY_SECRET/.test(log), false);
  assert.deepEqual(parseOriginsColumn(getJob(id, home.env).origin), [{ kind: "linear", ref: "DLW-99" }]);
});

test("links in the description and comments of a Linear issue with no attachments never become origins", async (t) => {
  const home = linkedHome(t, "linked-prose");
  const prose = `see ${GITHUB_PR_URL}, ${OTHER_LINEAR_URL} and ${DISCORD_URL} and ${SENTRY_URL}`;
  const fetch = fakeFetch(issueWith({ description: prose, comments: [prose] }));
  const id = await runLinearJob(t, home, fetch);
  assert.deepEqual(parseOriginsColumn(getJob(id, home.env).origin), [{ kind: "linear", ref: "DLW-99" }]);
  assert.deepEqual(originFilesOf(home.env, home.projectId), ["linear-DLW-99.md"]);
  assert.equal(readFileSync(jobLogPath(id, home.env), "utf8").includes("origin linked"), false);
});

test("a refused or failed write-back logs one line, enriches no linked origin and leaves no Linear file so a retry fetches again", async (t) => {
  const home = linkedHome(t, "linked-refused");
  for (const onLinked of [async () => false, async () => { throw new Error("store down"); }]) {
    const dir = originDir(t);
    const lines = [];
    const fetch = fakeFetch(issueWith({ attachments: [DISCORD_URL] }));
    const origins = [{ kind: "linear", ref: "DLW-99" }];
    await enrichJobOrigins({ origins, orgId: home.orgId, integrations: null, dir, env: home.env, fetchImpl: fetch.impl, log: (line) => lines.push(line), onLinked });
    assert.deepEqual(lines, ["origin: linear DLW-99 (connection: linear)", "linked origins not recorded: the claim moved on"]);
    assert.deepEqual(readdirSync(dir), []);
  }
});

test("an attachment already among the job's origins is not linked again and the Linear file is written", async (t) => {
  const home = linkedHome(t, "linked-known");
  const dir = originDir(t);
  const lines = [];
  let asked = 0;
  const origins = [{ kind: "linear", ref: "DLW-99" }, { kind: "discord", ref: DISCORD_REF }];
  const fetch = fakeFetch(issueWith({ attachments: [DISCORD_URL] }));
  await enrichJobOrigins({ origins, orgId: home.orgId, integrations: null, dir, env: home.env, fetchImpl: fetch.impl, log: (line) => lines.push(line), onLinked: async () => ++asked > 0 });
  assert.equal(asked, 0);
  assert.deepEqual(readdirSync(dir), ["linear-DLW-99.md"]);
  assert.deepEqual(lines, ["origin: linear DLW-99 (connection: linear)", `origin: discord ${DISCORD_REF} (connection: none)`]);
});
