import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { makeHostEnv } from "../test-support/host.mjs";

const SETUP = ["setup", "--no-path", "--no-embedding"];
const GH_TOKEN = "ghp_retired_secret_token";
const SENTRY_RECORD = { type: "sentry", token: "sntrys_kept_token", org: "acme", url: "https://sentry.io" };

// Runs `nightqueue setup` in process, answering its exit code and the lines it printed.
async function setup(env) {
  const out = [];
  const code = await run(SETUP, { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => out.push(line) });
  return { code, out };
}

// Writes a home whose two files still hold github slots, a github list and a github record next to sentry data.
function writeLegacyFiles(home) {
  const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  config.orgConnections = { orgA: { github: "gh", sentry: "st" }, orgB: { github: "gh", sentry: null } };
  config.orgConnectionLists = { orgA: { github: ["gh"] } };
  writeFileSync(join(home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const secrets = { version: 1, connections: { gh: { type: "github", token: GH_TOKEN }, st: SENTRY_RECORD } };
  writeFileSync(join(home, "secrets.json"), `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
}

test("setup removes stored github slots and records once, keeps the sentry data and the version", async (t) => {
  const host = makeHostEnv(t, "setup-retire-github");
  assert.equal((await setup(host.env)).code, 0);
  writeLegacyFiles(host.home);

  const first = await setup(host.env);
  assert.equal(first.code, 0, first.out.join("\n"));
  assert.ok(first.out.some((line) => line.startsWith("stored github connection: removed")), first.out.join("\n"));
  const configText = readFileSync(join(host.home, "config.json"), "utf8");
  const secretsText = readFileSync(join(host.home, "secrets.json"), "utf8");
  assert.equal(configText.includes("github"), false, configText);
  assert.equal(secretsText.includes("github"), false, secretsText);
  assert.equal(secretsText.includes(GH_TOKEN), false);
  const config = JSON.parse(configText);
  const secrets = JSON.parse(secretsText);
  assert.deepEqual(config.orgConnections, { orgA: { sentry: "st" }, orgB: { sentry: null } });
  assert.deepEqual(secrets.connections, { st: SENTRY_RECORD });
  assert.equal(config.version, 1);
  assert.equal(secrets.version, 1);
  assert.equal(statSync(join(host.home, "secrets.json")).mode & 0o777, 0o600);

  const mtimes = ["config.json", "secrets.json"].map((name) => statSync(join(host.home, name)).mtimeMs);
  const second = await setup(host.env);
  assert.equal(second.code, 0);
  assert.equal(second.out.some((line) => line.includes("stored github connection")), false, second.out.join("\n"));
  assert.deepEqual(["config.json", "secrets.json"].map((name) => statSync(join(host.home, name)).mtimeMs), mtimes);
});

test("the setup line counts the retired records and org slots, so a slot-only home never reads 0 removed", async (t) => {
  const legacy = makeHostEnv(t, "setup-retire-counts");
  assert.equal((await setup(legacy.env)).code, 0);
  writeLegacyFiles(legacy.home);
  const counted = await setup(legacy.env);
  assert.ok(counted.out.includes("stored github connection: removed (1 record(s), 3 org slot(s))"), counted.out.join("\n"));

  const slotOnly = makeHostEnv(t, "setup-retire-slot-only");
  assert.equal((await setup(slotOnly.env)).code, 0);
  const config = JSON.parse(readFileSync(join(slotOnly.home, "config.json"), "utf8"));
  config.orgConnections = { orgA: { github: null } };
  config.orgConnectionLists = { orgA: { github: [], discord: ["dc"] } };
  writeFileSync(join(slotOnly.home, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const first = await setup(slotOnly.env);
  assert.equal(first.code, 0, first.out.join("\n"));
  assert.ok(first.out.includes("stored github connection: removed (0 record(s), 2 org slot(s))"), first.out.join("\n"));
  assert.equal(readFileSync(join(slotOnly.home, "config.json"), "utf8").includes("github"), false);
});
