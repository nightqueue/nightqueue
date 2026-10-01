import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { configPath } from "../src/config/paths.mjs";
import { diskConfig, emptyConfig, normalizeConfig } from "../src/config/schema.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { manyTypes } from "../src/integrations/registry.mjs";
import { makeHome } from "../test-support/memory.mjs";

const OLDER_OWNED_KEYS = new Set(["version", "defaultOrg", "orgConnections", "queue", "embedding"]);

// What a build older than the many-kind lists writes back: every non-string slot becomes null, every unowned key is kept.
function olderBuildRewrite(raw) {
  const orgConnections = {};
  for (const [orgId, slots] of Object.entries(raw.orgConnections ?? {})) {
    orgConnections[orgId] = { github: null };
    for (const [type, value] of Object.entries(slots)) orgConnections[orgId][type] = typeof value === "string" && value ? value : null;
  }
  const unowned = Object.fromEntries(Object.entries(raw).filter(([key]) => !OLDER_OWNED_KEYS.has(key)));
  return { version: 1, defaultOrg: raw.defaultOrg ?? null, orgConnections, queue: raw.queue, embedding: null, ...unowned };
}

// A config whose org binds a github slot and a list of the first many kind of this build.
function boundConfig(many) {
  const config = emptyConfig();
  config.orgConnections.org1 = { github: "gh", [many]: ["ops", "team"] };
  return config;
}

test("many-kind lists are written outside orgConnections, so an older build's normalization cannot null them", () => {
  const [many] = manyTypes();
  assert.ok(many, "this build registers a many kind");
  const disk = JSON.parse(JSON.stringify(diskConfig(boundConfig(many))));
  assert.equal(Object.hasOwn(disk.orgConnections.org1, many), false);
  assert.equal(disk.orgConnections.org1.github, "gh");
  assert.deepEqual(disk.orgConnectionLists, { org1: { [many]: ["ops", "team"] } });
  assert.equal(disk.version, 1, "the schema version stays readable by the installed build");

  const afterOlderSave = olderBuildRewrite(disk);
  const reread = normalizeConfig(afterOlderSave);
  assert.deepEqual(reread.orgConnections.org1[many], ["ops", "team"]);
  assert.equal(reread.orgConnections.org1.github, "gh");
});

test("a list left in orgConnections by an earlier write is merged with orgConnectionLists and moved out on the next save", (t) => {
  const [many] = manyTypes();
  const merged = normalizeConfig({ version: 1, orgConnections: { org1: { [many]: ["ops"] } }, orgConnectionLists: { org1: { [many]: ["team", "ops"] }, org2: { [many]: ["x"] } } });
  assert.deepEqual(merged.orgConnections.org1[many], ["ops", "team"]);
  assert.deepEqual(merged.orgConnections.org2[many], ["x"]);

  const env = makeHome(t, "many-bindings-disk");
  saveConfig(merged, env);
  const disk = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.equal(Object.hasOwn(disk.orgConnections.org1, many), false);
  assert.deepEqual(disk.orgConnectionLists.org1[many], ["ops", "team"]);
  assert.deepEqual(loadConfig(env, { warn: () => {} }).orgConnections.org1[many], ["ops", "team"]);
});

test("a config with no many-kind binding is written with no orgConnectionLists key", () => {
  const config = emptyConfig();
  config.orgConnections.org1 = { github: "gh" };
  assert.equal(Object.hasOwn(diskConfig(config), "orgConnectionLists"), false);
});
