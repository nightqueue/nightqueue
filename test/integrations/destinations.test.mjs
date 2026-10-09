import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, saveConfig, saveSecrets } from "../../src/config/store.mjs";
import {
  DestinationNotFound,
  NotAllowedForOrg,
  destinationOf,
  linkProjects,
  projectsUsing,
  setDestination,
  unlinkProjectsUsing,
} from "../../src/integrations/destinations.mjs";
import { openStore } from "../../src/store/open.mjs";
import { ensureProject, makeHome, orgIdOf } from "../../test-support/memory.mjs";
import { setIntegrations } from "../../test-support/origin-provider.mjs";

const QUIET = { warn: () => {} };
const URL = "https://discord.com/api/webhooks/9001/destinationSecretToken-0123";
const LINKED = { discord: { log: { connection: "dlw-log", events: ["closed"] } } };

// A home with projects a1, a2, a4 in org dlw and c1 in org clareza, and the Discord connection `dlw-log` allowed for dlw only.
function destinationHome(t, name) {
  const env = makeHome(t, name);
  const ids = {
    a1: ensureProject(env, "a1", { org: "dlw" }),
    a2: ensureProject(env, "a2", { org: "dlw" }),
    c1: ensureProject(env, "c1", { org: "clareza" }),
    a4: ensureProject(env, "a4", { org: "dlw" }),
  };
  const config = loadConfig(env, QUIET);
  config.orgConnections[orgIdOf(env, "dlw")] = { discord: ["dlw-log"] };
  saveConfig(config, env);
  const secrets = { version: 1, connections: { "dlw-log": { type: "discord", url: URL, channelId: "222", guildId: "111", mode: "webhook" }, gh: { type: "github", token: "ghp_x" } } };
  saveSecrets(secrets, env);
  return { env, ids, store: openStore(env), files: { config, secrets } };
}

// The integrations of every project of the home, by short name.
async function integrationsOf(home) {
  const entries = await Promise.all(Object.entries(home.ids).map(async ([key, id]) => [key, await home.store.projects.integrations(id)]));
  return Object.fromEntries(entries);
}

test("setting a destination writes the connection and the closed event; clearing it prunes back to nothing", async (t) => {
  const home = destinationHome(t, "dest-set");
  const project = await home.store.projects.byId(home.ids.a1);
  assert.equal(await setDestination({ store: home.store, project, name: "dlw-log", files: home.files }), "dlw-log");
  assert.deepEqual(await home.store.projects.integrations(home.ids.a1), LINKED);
  assert.equal(destinationOf(LINKED), "dlw-log");
  assert.equal(await setDestination({ store: home.store, project, name: null, files: home.files }), null);
  assert.equal(await home.store.projects.integrations(home.ids.a1), null);
});

test("link then unlink restores a project's other Discord setting exactly", async (t) => {
  const home = destinationHome(t, "dest-restore");
  setIntegrations(home.env, home.ids.a1, { discord: { replyToOrigin: false } });
  const project = await home.store.projects.byId(home.ids.a1);
  await setDestination({ store: home.store, project, name: "dlw-log", files: home.files });
  assert.deepEqual(await home.store.projects.integrations(home.ids.a1), { discord: { replyToOrigin: false, log: LINKED.discord.log } });
  await setDestination({ store: home.store, project, name: null, files: home.files });
  assert.deepEqual(await home.store.projects.integrations(home.ids.a1), { discord: { replyToOrigin: false } });
});

test("a connection the org is not allowed to use, or one that is not Discord, is refused and writes nothing", async (t) => {
  const home = destinationHome(t, "dest-refused");
  const other = await home.store.projects.byId(home.ids.c1);
  const refused = await setDestination({ store: home.store, project: other, name: "dlw-log", files: home.files }).catch((err) => err);
  assert.ok(refused instanceof NotAllowedForOrg, String(refused));
  assert.deepEqual([refused.orgId, refused.connection, refused.projectId], [orgIdOf(home.env, "clareza"), "dlw-log", home.ids.c1]);
  const project = await home.store.projects.byId(home.ids.a1);
  for (const name of ["gh", "nope"]) {
    await assert.rejects(setDestination({ store: home.store, project, name, files: home.files }), DestinationNotFound);
  }
  assert.deepEqual(Object.values(await integrationsOf(home)), [null, null, null, null]);
});

test("a batch link is all or none: a project of another org or an unknown id refuses the whole batch with zero writes", async (t) => {
  const home = destinationHome(t, "dest-batch");
  const { a1, a2, c1, a4 } = home.ids;
  await assert.rejects(linkProjects({ store: home.store, name: "dlw-log", projectIds: [a1, a2, c1, a4], files: home.files }), NotAllowedForOrg);
  await assert.rejects(linkProjects({ store: home.store, name: "dlw-log", projectIds: [a1, "01J9Z00000000000000000000Z"], files: home.files }), DestinationNotFound);
  assert.deepEqual(Object.values(await integrationsOf(home)), [null, null, null, null]);

  assert.deepEqual(await linkProjects({ store: home.store, name: "dlw-log", projectIds: [a1, a2], files: home.files }), { linked: [a1, a2], unchanged: [] });
  assert.deepEqual(await linkProjects({ store: home.store, name: "dlw-log", projectIds: [a1, a4, a4], files: home.files }), { linked: [a4], unchanged: [a1] });
  const after = await integrationsOf(home);
  assert.deepEqual([after.a1, after.a2, after.c1, after.a4], [LINKED, LINKED, null, LINKED]);
});

test("unlinking by org clears only that org's projects, and every unlink prunes to the prior state", async (t) => {
  const home = destinationHome(t, "dest-unlink");
  const { a1, a2, c1 } = home.ids;
  home.files.config.orgConnections[orgIdOf(home.env, "clareza")] = { discord: ["dlw-log"] };
  await linkProjects({ store: home.store, name: "dlw-log", projectIds: [a1, a2, c1], files: home.files });
  const clarezaId = orgIdOf(home.env, "clareza");
  assert.deepEqual((await projectsUsing({ store: home.store, name: "dlw-log", orgIds: [clarezaId] })).map((project) => project.id), [c1]);
  assert.deepEqual((await unlinkProjectsUsing({ store: home.store, name: "dlw-log", orgIds: [clarezaId] })).map((project) => project.id), [c1]);
  assert.deepEqual((await projectsUsing({ store: home.store, name: "dlw-log" })).map((project) => project.id).sort(), [a1, a2].sort());
  assert.deepEqual((await unlinkProjectsUsing({ store: home.store, name: "dlw-log" })).map((project) => project.id).sort(), [a1, a2].sort());
  assert.deepEqual(Object.values(await integrationsOf(home)), [null, null, null, null]);
});
