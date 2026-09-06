import assert from "node:assert/strict";
import { test } from "node:test";
import { UserError } from "../src/config/errors.mjs";
import { addOrg, getOrg, listOrgs, removeOrg, renameOrg, requireOrg } from "../src/config/orgs.mjs";
import { emptyConfig } from "../src/config/schema.mjs";

// Builds a config with an extra org and a project pointing at it.
function configWithAcme() {
  const config = addOrg(emptyConfig(), "acme", { displayName: "Acme" });
  config.orgs.acme.connections.github = "gh";
  config.projects.api = { path: "/tmp/api", org: "acme" };
  config.projects.web = { path: "/tmp/web", org: "default" };
  return config;
}

test("addOrg validates the name and refuses duplicates", () => {
  const config = addOrg(emptyConfig(), "acme");
  assert.equal(config.orgs.acme.displayName, "acme");
  assert.deepEqual({ ...config.orgs.acme.connections }, { github: null });
  assert.throws(() => addOrg(config, "acme"), UserError);
  assert.throws(() => addOrg(config, "Acme"), UserError);
});

test("requireOrg lists the existing orgs and never creates one", () => {
  const config = configWithAcme();
  assert.equal(requireOrg(config, "acme").displayName, "Acme");
  assert.throws(() => requireOrg(config, "nope"), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /unknown org `nope`; existing orgs: default, acme/);
    return true;
  });
  assert.equal(getOrg(config, "nope"), null);
});

test("listOrgs marks the default org and counts projects", () => {
  const orgs = listOrgs(configWithAcme());
  assert.deepEqual(orgs.map((org) => org.name), ["default", "acme"]);
  assert.deepEqual(orgs[0], {
    name: "default",
    displayName: "Default",
    isDefault: true,
    connections: { github: null },
    projects: 1,
  });
  assert.deepEqual(orgs[1].connections, { github: "gh" });
  assert.equal(orgs[1].projects, 1);
});

test("renameOrg moves the entry in place and rewrites projects and defaultOrg", () => {
  const config = configWithAcme();
  config.defaultOrg = "acme";
  renameOrg(config, "acme", "acme-inc");
  assert.deepEqual(Object.keys(config.orgs), ["default", "acme-inc"]);
  assert.equal(config.orgs["acme-inc"].displayName, "Acme");
  assert.deepEqual({ ...config.orgs["acme-inc"].connections }, { github: "gh" });
  assert.equal(config.orgs.acme, undefined);
  assert.equal(config.projects.api.org, "acme-inc");
  assert.equal(config.projects.web.org, "default");
  assert.equal(config.defaultOrg, "acme-inc");
});

test("renameOrg refuses an unknown source and an existing target", () => {
  const config = configWithAcme();
  assert.throws(() => renameOrg(config, "nope", "other"), UserError);
  assert.throws(() => renameOrg(config, "acme", "default"), (err) => {
    assert.match(err.message, /org `default` already exists/);
    return true;
  });
  assert.deepEqual(Object.keys(config.orgs), ["default", "acme"]);
  assert.equal(config.projects.api.org, "acme");
});

test("removeOrg refuses the default org and orgs still in use", () => {
  const config = configWithAcme();
  assert.throws(() => removeOrg(config, "default"), (err) => {
    assert.match(err.message, /it is the default org/);
    return true;
  });
  assert.throws(() => removeOrg(config, "acme"), (err) => {
    assert.match(err.message, /1 project\(s\) still point to it: api/);
    return true;
  });
  delete config.projects.api;
  removeOrg(config, "acme");
  assert.deepEqual(Object.keys(config.orgs), ["default"]);
});
