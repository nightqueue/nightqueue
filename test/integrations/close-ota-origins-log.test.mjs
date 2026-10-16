import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, loadSecrets, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import { runEasAsync } from "../../src/host/eas.mjs";
import { acquireClose, addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { CLOSE_STEPS, runClosePipeline } from "../../src/queue/close.mjs";
import { copyEnvFile, envFileNames } from "../../src/queue/close-deps.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { orgOfProject, setIntegrations } from "../../test-support/origin-provider.mjs";

const LINEAR_KEY = "lin_api_ota_combo_secret";
const WEBHOOK_TOKEN = "discordOtaComboSecret";
const LINEAR_API = "https://api.linear.app/graphql";
const WEBHOOK_URL = `https://discord.com/api/webhooks/9001/${WEBHOOK_TOKEN}`;
const PR_URL = "https://github.com/acme/app/pull/7";
const MERGE_SHA = "abc1234def5678";
const GROUP = "0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7";
const GROUP_URL = `https://expo.dev/accounts/acme/projects/shop-app/updates/${GROUP}`;
const WORKER = "close:test:1:ota-combo";
const POST_STEPS = CLOSE_STEPS.filter((step) => step.required === false);
const ORIGINS = [
  { kind: "discord", ref: "111/222/555" },
  { kind: "linear", ref: "MK-42" },
];
const LINEAR_ANSWERS = {
  issue: { issue: { id: "uuid-42", identifier: "MK-42", title: "Login crashes", url: "https://linear.app/acme/issue/MK-42/login", state: { name: "In Progress", type: "started" }, team: { states: { nodes: [{ id: "s-done", name: "Done", type: "completed", position: 1 }] } } } },
  issueUpdate: { issueUpdate: { success: true } },
  attachmentCreate: { attachmentCreate: { success: true } },
  commentCreate: { commentCreate: { success: true } },
};

// The Linear operation a GraphQL query carries, named by its root field.
function linearOperation(query) {
  return ["issueUpdate", "attachmentCreate", "commentCreate", "issue"].find((name) => query.includes(name)) ?? "unknown";
}

// A fake fetch for Linear and Discord that appends each call to the shared timeline and keeps the bodies it was sent.
function serviceFetch(timeline) {
  const comments = [];
  const posts = [];
  const impl = async (url, options = {}) => {
    const reply = (status, body = {}) => ({ status, headers: new Map(), json: async () => body });
    if (url === LINEAR_API) {
      const body = JSON.parse(options.body);
      const operation = linearOperation(body.query);
      timeline.push(`linear ${operation}`);
      if (operation === "commentCreate") comments.push(body.variables.body);
      return reply(200, { data: LINEAR_ANSWERS[operation] ?? null });
    }
    timeline.push(`discord ${options.method ?? "GET"}`);
    posts.push(JSON.parse(options.body));
    return reply(200, { id: "999" });
  };
  return { impl, comments, posts };
}

// A fake eas execFile that appends each subcommand to the shared timeline and answers it from `answers`.
function fakeEasExec(timeline, answers) {
  return (file, args, options, callback) => {
    timeline.push(`eas ${args[0]}`);
    const answer = answers[args[0]] ?? { stdout: "" };
    const err = answer.code === undefined ? null : Object.assign(new Error("Command failed"), { code: answer.code });
    setImmediate(() => callback(err, answer.stdout ?? "", answer.stderr ?? ""));
  };
}

// The close deps of the OTA step: a logged-in eas over the real runner, a fake git and the real filesystem.
function otaDeps(t, timeline, answers) {
  const execFileImpl = fakeEasExec(timeline, answers);
  const run = (args, options = {}) => runEasAsync(args, { ...options, env: { PATH: "/usr/bin" }, execFileImpl });
  return {
    eas: { whoami: async () => ({ installed: true, authenticated: true, login: "alice", host: null }), update: run, projectInfo: run },
    git: async () => ({ ok: true, stdout: "", stderr: "" }),
    fs: {
      exists: () => true,
      makeTempDir: (prefix) => {
        const dir = mkdtempSync(join(tmpdir(), prefix));
        t.after(() => rmSync(dir, { recursive: true, force: true }));
        return dir;
      },
      removeDir: (dir) => rmSync(dir, { recursive: true, force: true }),
      linkNodeModules: () => false,
      envFileNames,
      copyEnvFile,
    },
  };
}

// A home whose project turns OTA on and logs closes to the org's Discord webhook, with the home's Linear key.
function otaComboHome(t, name) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  const orgId = orgOfProject(env, projectId);
  setIntegrations(env, projectId, { discord: { log: { connection: "chat" } }, expo: { ota: true } });
  const config = loadConfig(env, { warn: () => {} });
  config.orgConnections[orgId] = { ...(config.orgConnections[orgId] ?? {}), discord: ["chat"] };
  saveConfig(config, env);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.chat = { type: "discord", url: WEBHOOK_URL, channelId: "222", guildId: "111", mode: "webhook" };
  secrets.connections.lin = { type: "linear", apiKey: LINEAR_KEY };
  saveSecrets(secrets, env);
  return { env, checkout, projectId };
}

// Queues a job with a Discord and a Linear origin and finishes it done with a pull request.
function seedJob(home) {
  const { id } = addJob({ projectId: home.projectId, prompt: "fix the login crash", origin: ORIGINS }, home.env);
  if (!claimJobById(id, { worker: WORKER, cap: null }, home.env)) throw new Error(`job #${id} could not be claimed`);
  if (!finishJob(id, { worker: WORKER, status: "done", prUrl: PR_URL }, home.env)) throw new Error(`job #${id} could not be finished`);
  return id;
}

// Pre-close steps that merge and settle without gh, recording the merge commit and base branch the OTA step reads.
function fakePreSteps() {
  const done = (note, data) => async () => ({ status: "done", note, data });
  return [
    { name: "preflight", run: done("checks green", { title: "fix the login crash", baseBranch: "main" }) },
    { name: "conflict", run: async () => ({ status: "skipped", note: "mergeable" }) },
    { name: "merge", run: done("merged", { merged: true, mergeSha: MERGE_SHA }) },
    { name: "settle", run: async () => ({ status: "done", note: "ready", data: { noticeLine: "Closed: PR #7 merged as abc1234 on 2026-10-01" } }) },
  ];
}

// Closes the job once with the real post-close steps, answering the outcome, the row and what each service saw.
async function closeWithOta(t, name, answers) {
  const home = otaComboHome(t, name);
  const id = seedJob(home);
  const timeline = [];
  const fetch = serviceFetch(timeline);
  acquireClose(id, { worker: WORKER, leaseS: 720 }, home.env);
  const outcome = await runClosePipeline({
    store: openStore(home.env),
    job: getJob(id, home.env),
    worker: WORKER,
    env: home.env,
    deps: { fetch: fetch.impl, ...otaDeps(t, timeline, answers) },
    timeoutS: 60,
    signal: null,
    onStep: () => {},
    checkout: home.checkout,
    steps: [...fakePreSteps(), ...POST_STEPS],
  });
  return { outcome, row: getJob(id, home.env), timeline, fetch };
}

// The [name, value] pairs of an embed's fields.
function fieldsOf(post) {
  return post.embeds[0].fields.map((field) => [field.name, field.value]);
}

// The index of the first timeline entry that starts with a prefix, failing when there is none.
function firstIndex(timeline, prefix) {
  const index = timeline.findIndex((entry) => entry.startsWith(prefix));
  assert.ok(index >= 0, `no ${prefix} call in ${timeline.join(", ")}`);
  return index;
}

const PUBLISHED = {
  update: { stdout: JSON.stringify([{ id: "u1", group: GROUP, branch: "production" }]) },
  "project:info": { stdout: "fullName  @acme/shop-app\nID        1234" },
};

test("one close with expo.ota on, a Linear and a Discord origin and a Discord log runs ota, then origin, then log, and both carry the OTA of that run", async (t) => {
  const { outcome, row, timeline, fetch } = await closeWithOta(t, "ota-combo-done", PUBLISHED);
  assert.equal(outcome.status, "closed");
  assert.equal(row.status, "closed");
  assert.deepEqual(outcome.postClose.steps.map((step) => [step.name, step.status]), [["ota", "done"], ["origin", "done"], ["log", "done"]]);
  assert.ok(firstIndex(timeline, "eas update") < firstIndex(timeline, "linear"), timeline.join(", "));
  assert.equal(timeline.filter((entry) => entry === "discord POST").length, 2, timeline.join(", "));
  assert.ok(timeline.lastIndexOf("eas project:info") < firstIndex(timeline, "discord"), timeline.join(", "));

  const ota = JSON.parse(row.close).data.ota;
  assert.deepEqual(ota, { status: "done", branch: "production", groupId: GROUP, url: GROUP_URL, note: null });
  assert.equal(fetch.comments.length, 1);
  assert.ok(fetch.comments[0].endsWith(`\n\nOTA published to production (${GROUP_URL})`), fetch.comments[0]);

  const [reply, log] = fetch.posts;
  const otaField = ["OTA", `[production · 0f1e2d3c](${GROUP_URL})`];
  assert.deepEqual(fieldsOf(reply).slice(0, 2), [["PR", `[#7](${PR_URL})`], otaField]);
  assert.deepEqual(fieldsOf(log).slice(0, 3).map(([name]) => name), ["PR", "Project", "OTA"]);
  assert.deepEqual(fieldsOf(log)[2], otaField);
  assert.ok(!JSON.stringify(row).includes(LINEAR_KEY) && !JSON.stringify(row).includes(WEBHOOK_TOKEN));
});

test("the same close whose eas update fails tells the failure to the origin and the log, and the job stays closed", async (t) => {
  const failing = { update: { code: 1, stderr: "Error: build failed\nInvalid runtime version" } };
  const { outcome, row, timeline, fetch } = await closeWithOta(t, "ota-combo-warning", failing);
  assert.equal(outcome.status, "closed");
  assert.equal(row.status, "closed");
  assert.deepEqual(outcome.postClose.steps.map((step) => [step.name, step.status]), [["ota", "warning"], ["origin", "done"], ["log", "done"]]);
  assert.ok(firstIndex(timeline, "eas update") < firstIndex(timeline, "linear"), timeline.join(", "));
  assert.ok(!timeline.includes("eas project:info"));

  const reason = JSON.parse(row.close).data.ota.note.split("\n")[0];
  assert.match(reason, /^eas update exited 1$/);
  assert.ok(fetch.comments[0].endsWith(`\n\nOTA failed: ${reason}`), fetch.comments[0]);
  const [reply, log] = fetch.posts;
  assert.deepEqual(fieldsOf(reply)[1], ["OTA", `failed (${reason})`]);
  assert.deepEqual(fieldsOf(log)[2], ["OTA", `failed (${reason})`]);
  assert.match(row.notice_md, /After close: ota warning - eas update exited 1/);
});
