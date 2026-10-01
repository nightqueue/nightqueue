import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../src/config/errors.mjs";
import { isId } from "../src/config/ids.mjs";
import { addOrg, defaultOrg, listOrgs, removeOrg, renameOrg, requireOrg } from "../src/config/orgs.mjs";
import { emptyConfig } from "../src/config/schema.mjs";
import { openStore } from "../src/store/open.mjs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeDir, makeHome, registerCheckout } from "../test-support/memory.mjs";

// A fresh home and its store.
function homeWithAcme(t) {
  const env = makeHome(t, "orgs");
  return { env, store: openStore(env) };
}

// Registers a checkout named `name` under an org of the home.
function registerIn(t, env, name, org) {
  const path = join(makeDir(t, `orgs-${name}`), name);
  mkdirSync(join(path, ".git"), { recursive: true });
  return registerCheckout(env, { path, name, org });
}

test("addOrg validates the name and refuses duplicates", async (t) => {
  const { store } = homeWithAcme(t);
  const org = await addOrg(store, "acme");
  assert.ok(isId(org.id));
  assert.equal(org.name, "acme");
  await assert.rejects(addOrg(store, "acme"), UserError);
  await assert.rejects(addOrg(store, "Acme"), UserError);
});

test("requireOrg lists the existing orgs and never creates one", async (t) => {
  const { store } = homeWithAcme(t);
  await addOrg(store, "acme");
  assert.equal((await requireOrg(store, "acme")).name, "acme");
  await assert.rejects(requireOrg(store, "nope"), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /unknown org `nope`; existing orgs: default, acme/);
    return true;
  });
  assert.equal(await store.orgs.byName("nope"), null);
});

test("listOrgs marks the default org, carries the bindings by id and counts projects", async (t) => {
  const { env, store } = homeWithAcme(t);
  const acme = await addOrg(store, "acme");
  registerIn(t, env, "api", "acme");
  registerIn(t, env, "web");
  const config = { ...emptyConfig(), orgConnections: { [acme.id]: { github: "gh" } } };
  const orgs = await listOrgs(store, config);
  assert.deepEqual(orgs.map((org) => org.name), ["default", "acme"]);
  assert.equal(orgs[0].isDefault, true);
  assert.deepEqual(orgs[0].connections, { github: null, sentry: null });
  assert.equal(orgs[0].projects, 1);
  assert.deepEqual(orgs[1].connections, { github: "gh", sentry: null });
  assert.equal(orgs[1].projects, 1);
  assert.equal((await defaultOrg(store, { ...config, defaultOrg: acme.id })).name, "acme");
});

test("renameOrg changes one row: the id, its projects and its bindings stay", async (t) => {
  const { env, store } = homeWithAcme(t);
  const acme = await addOrg(store, "acme");
  registerIn(t, env, "api", "acme");
  const renamed = await renameOrg(store, "acme", "acme-inc");
  assert.equal(renamed.id, acme.id);
  assert.equal(renamed.name, "acme-inc");
  assert.equal(await store.orgs.byName("acme"), null);
  assert.equal((await store.projects.byName("api")).org, "acme-inc");
});

test("renameOrg refuses an unknown source and an existing target", async (t) => {
  const { store } = homeWithAcme(t);
  await addOrg(store, "acme");
  await assert.rejects(renameOrg(store, "nope", "other"), UserError);
  await assert.rejects(renameOrg(store, "acme", "default"), (err) => {
    assert.match(err.message, /org `default` already exists/);
    return true;
  });
  assert.deepEqual((await store.orgs.list()).map((org) => org.name), ["default", "acme"]);
});

test("removeOrg refuses the default org and orgs still in use, and drops the bindings of the one it removes", async (t) => {
  const { env, store } = homeWithAcme(t);
  const acme = await addOrg(store, "acme");
  const api = registerIn(t, env, "api", "acme");
  const config = { ...emptyConfig(), orgConnections: { [acme.id]: { github: "gh" } } };
  await assert.rejects(removeOrg(store, config, "default"), (err) => {
    assert.match(err.message, /it is the default org/);
    return true;
  });
  await assert.rejects(removeOrg(store, config, "acme"), (err) => {
    assert.match(err.message, /1 project\(s\) still point to it: api/);
    return true;
  });
  await store.projects.remove(api.id);
  await removeOrg(store, config, "acme");
  assert.deepEqual((await store.orgs.list()).map((org) => org.name), ["default"]);
  assert.equal(config.orgConnections[acme.id], undefined);
});
