import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { homeDir } from "../../src/config/paths.mjs";
import { loadSecrets, saveSecrets } from "../../src/config/store.mjs";
import { withProviders } from "../../src/integrations/registry.mjs";
import { getSetting } from "../../src/integrations/settings.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";
import { bindTrackerConnection, originProviders, TRACKER_SECRET, trackerProvider } from "../../test-support/origin-provider.mjs";

const NO_SETTINGS = "no provider of this build has integration settings";

// A test provider that declares one setting of every type, one of them under a dotted key.
function settingsProvider() {
  return {
    ...trackerProvider(),
    settings: {
      onClosed: { type: "enum", values: ["resolved", "ignored"], default: "resolved" },
      reply: { type: "boolean", default: true },
      "log.connection": { type: "connection" },
      "log.events": { type: "list", values: ["closed", "failed"], default: ["closed"] },
    },
  };
}

// The registry list of these tests: the build's github, then the provider with settings.
function settingsProviders() {
  return [originProviders()[0], settingsProvider()];
}

// A temp home with the project `alpha`, its org bound to the tracker connection `trk`, plus a spare tracker and a github connection.
function makeSettingsHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const projectId = projectIdOf(env, "alpha");
  bindTrackerConnection(env, projectId);
  const secrets = loadSecrets(env, { warn: () => {} });
  secrets.connections.spare = { type: "tracker", token: TRACKER_SECRET };
  secrets.connections.gh = { type: "github", token: TRACKER_SECRET };
  saveSecrets(secrets, env);
  return { env, projectId };
}

// The raw integrations column of a project.
function storedColumn(env, projectId) {
  return openDb(env).prepare("SELECT integrations FROM projects WHERE id = ?").get(projectId).integrations;
}

// Runs the CLI in this process, collecting what it printed.
async function runCli(env, argv) {
  const out = [];
  const err = [];
  const code = await run(argv, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out, err };
}

// The real tool server and a client wired together in this process, so the test's provider list is the server's.
async function connectInProcess(t, env) {
  const server = createServer(env);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "nightqueue-tests-integrations", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

// The text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// The JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

test("a build whose providers declare no settings shows no integrations and refuses every key", async (t) => {
  const { env, projectId } = makeSettingsHome(t, "integrations-no-settings");
  await withProviders([originProviders()[0]], async () => {
    const shown = await runCli(env, ["project", "integrations", "alpha", "show"]);
    assert.equal(shown.code, 0, shown.err.join("\n"));
    assert.deepEqual(shown.out, ["no integrations"]);

    const refused = await runCli(env, ["project", "integrations", "alpha", "set", "tracker.onClosed=resolved"]);
    assert.equal(refused.code, 1);
    assert.ok(refused.err.join("\n").includes(NO_SETTINGS), refused.err.join("\n"));
    assert.equal(storedColumn(env, projectId), null);

    const client = await connectInProcess(t, env);
    const answer = payloadOf(await client.callTool({ name: "project_integrations", arguments: { project: "alpha", action: "show" } }));
    assert.deepEqual(answer, { project: "alpha", integrations: null, providers: [{ kind: "github", keys: [] }], contract: 4 });
    const mcpRefused = await client.callTool({ name: "project_integrations", arguments: { project: "alpha", action: "set", key: "github.x", value: "y" } });
    assert.equal(mcpRefused.isError, true);
    assert.ok(textOf(mcpRefused).includes(NO_SETTINGS), textOf(mcpRefused));
  });
});

test("set stores dotted keys nested under the provider, show prints them, and unsetting the last key leaves NULL", async (t) => {
  const { env, projectId } = makeSettingsHome(t, "integrations-round-trip");
  await withProviders(settingsProviders(), async () => {
    const set = await runCli(env, ["project", "integrations", "alpha", "set", "tracker.log.connection=trk", "tracker.log.events=closed,failed", "tracker.reply=false"]);
    assert.equal(set.code, 0, set.err.join("\n"));
    assert.deepEqual(JSON.parse(storedColumn(env, projectId)), { tracker: { log: { connection: "trk", events: ["closed", "failed"] }, reply: false } });

    const shown = await runCli(env, ["project", "integrations", "alpha", "show"]);
    assert.deepEqual(shown.out, ["tracker.log.connection=trk", "tracker.log.events=closed,failed", "tracker.reply=false", "tracker: org connection trk"]);

    await runCli(env, ["project", "integrations", "alpha", "unset", "tracker.log.connection"]);
    assert.deepEqual(JSON.parse(storedColumn(env, projectId)), { tracker: { log: { events: ["closed", "failed"] }, reply: false } });
    const pruned = await runCli(env, ["project", "integrations", "alpha", "unset", "tracker.log.events", "tracker.reply"]);
    assert.equal(pruned.code, 0, pruned.err.join("\n"));
    assert.deepEqual(pruned.out, ["no integrations"]);
    assert.equal(storedColumn(env, projectId), null);

    for (const result of [set, shown, pruned]) assert.equal([...result.out, ...result.err].join("\n").includes(TRACKER_SECRET), false);
  });
});

test("each value type is validated, an unknown key lists the valid ones, and one bad argument changes nothing", async (t) => {
  const { env, projectId } = makeSettingsHome(t, "integrations-validation");
  await withProviders(settingsProviders(), async () => {
    const cases = [
      ["tracker.onClosed=closed", "takes one of: resolved, ignored"],
      ["tracker.reply=yes", "takes true or false"],
      ["tracker.log.events=closed,merged", "comma-separated list of: closed, failed"],
      ["tracker.log.connection=nope", "there is no connection named `nope`"],
      ["tracker.log.connection=gh", "needs a tracker connection; `gh` is a github connection"],
      ["tracker.log.connection=spare", "connection `spare` is not bound to the project's org"],
      ["tracker.mode=x", "valid settings: tracker.onClosed, tracker.reply, tracker.log.connection, tracker.log.events"],
      ["tracker.reply", "is not <kind.key>=<value>"],
    ];
    for (const [arg, message] of cases) {
      const refused = await runCli(env, ["project", "integrations", "alpha", "set", "tracker.onClosed=ignored", arg]);
      assert.equal(refused.code, 1, `${arg} was accepted`);
      assert.ok(refused.err.join("\n").includes(message), `${arg}: ${refused.err.join("\n")}`);
      assert.equal(refused.err.join("\n").includes(TRACKER_SECRET), false);
    }
    assert.equal(storedColumn(env, projectId), null, "a refused batch wrote its valid part");
  });
});

test("project_integrations sets and unsets over MCP, and refuses a change from inside a job while show still answers", async (t) => {
  const { env, projectId } = makeSettingsHome(t, "integrations-mcp");
  await withProviders(settingsProviders(), async () => {
    const client = await connectInProcess(t, env);
    const set = payloadOf(await client.callTool({ name: "project_integrations", arguments: { project: "alpha", action: "set", key: "tracker.onClosed", value: "ignored" } }));
    assert.deepEqual(set.integrations, { tracker: { onClosed: "ignored" } });
    assert.deepEqual(set.providers[1].keys[0], { key: "tracker.onClosed", type: "enum", values: ["resolved", "ignored"], default: "resolved" });
    assert.equal(JSON.stringify(set).includes(TRACKER_SECRET), false);

    const noValue = await client.callTool({ name: "project_integrations", arguments: { project: "alpha", action: "set", key: "tracker.reply" } });
    assert.equal(noValue.isError, true);
    assert.ok(textOf(noValue).includes("`set` needs `value`"), textOf(noValue));

    const inJob = await connectInProcess(t, { ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) });
    const refused = await inJob.callTool({ name: "project_integrations", arguments: { project: "alpha", action: "unset", key: "tracker.onClosed" } });
    assert.equal(refused.isError, true);
    assert.ok(textOf(refused).includes("from inside J-9"), textOf(refused));
    const shown = payloadOf(await inJob.callTool({ name: "project_integrations", arguments: { project: "alpha", action: "show" } }));
    assert.deepEqual(shown.integrations, { tracker: { onClosed: "ignored" } });

    const unset = payloadOf(await client.callTool({ name: "project_integrations", arguments: { project: "alpha", action: "unset", key: "tracker.onClosed" } }));
    assert.equal(unset.integrations, null);
    assert.equal(storedColumn(env, projectId), null);
  });
});

test("the CLI refuses a change from inside a job", async (t) => {
  const { env, projectId } = makeSettingsHome(t, "integrations-cli-in-job");
  await withProviders(settingsProviders(), async () => {
    const refused = await runCli({ ...env, NIGHTQUEUE_JOB_ID: "9", NIGHTQUEUE_JOB_HOME: homeDir(env) }, ["project", "integrations", "alpha", "set", "tracker.reply=true"]);
    assert.equal(refused.code, 1);
    assert.ok(refused.err.join("\n").includes("from inside J-9"), refused.err.join("\n"));
    assert.equal(storedColumn(env, projectId), null);
  });
});

test("getSetting answers the stored value, else the declared default", async () => {
  await withProviders(settingsProviders(), async () => {
    assert.equal(getSetting(null, "tracker", "reply"), true);
    assert.deepEqual(getSetting({ tracker: {} }, "tracker", "log.events"), ["closed"]);
    assert.equal(getSetting({ tracker: { reply: false } }, "tracker", "reply"), false);
    assert.equal(getSetting({ tracker: { log: { connection: "trk" } } }, "tracker", "log.connection"), "trk");
    assert.equal(getSetting(null, "tracker", "log.connection"), null);
  });
});
