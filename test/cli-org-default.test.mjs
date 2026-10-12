import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { lockPath } from "../src/config/lock.mjs";
import { setDefaultOrg } from "../src/config/orgs.mjs";
import { configPath } from "../src/config/paths.mjs";
import { loadConfig } from "../src/config/store.mjs";
import { openStore } from "../src/store/open.mjs";
import { makeHome, makeOrg, orgIdOf } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));
const QUIET = { warn: () => {} };

// Runs the real CLI in its own process on the test's home.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// A home with the `default` org and an `acme` org.
async function orgsHome(t, name) {
  const env = makeHome(t, name);
  await openStore(env).connect();
  makeOrg(env, "acme");
  return env;
}

test("setDefaultOrg refuses an unknown org, sets the id in the config it is given without saving it, and reports a change", async (t) => {
  const env = await orgsHome(t, "org-default-unit");
  const store = openStore(env);
  await assert.rejects(setDefaultOrg(store, {}, "nope"), /unknown org `nope`; existing orgs: default, acme/);
  const config = {};
  const first = await setDefaultOrg(store, config, "acme");
  assert.deepEqual([first.changed, first.org.name, config.defaultOrg], [true, "acme", orgIdOf(env, "acme")]);
  assert.equal(existsSync(configPath(env)), false);
  assert.equal((await setDefaultOrg(store, config, "acme")).changed, false);
});

test("`org default` writes the org id to config.json, `org list` marks it, and `org remove` refuses it", async (t) => {
  const env = await orgsHome(t, "org-default-cli");
  const made = runCli(env, ["org", "default", "acme"]);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(made.stdout.trim(), "default org is now `acme`");
  assert.equal(loadConfig(env, QUIET).defaultOrg, orgIdOf(env, "acme"));
  const listed = runCli(env, ["org", "list"]).stdout.split("\n");
  assert.match(listed.find((line) => line.includes(" acme ")), /^\* acme /);
  assert.equal(runCli(env, ["org", "default", "acme"]).stdout.trim(), "org `acme` is already the default org");
  const removed = runCli(env, ["org", "remove", "acme"]);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /cannot remove org `acme`: it is the default org/);
  const unknown = runCli(env, ["org", "default", "nope"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown org `nope`/);
});

test("`org default` is refused inside a job and waits for the configuration lock", { timeout: 30000 }, async (t) => {
  const env = await orgsHome(t, "org-default-guards");
  const inJob = runCli({ ...env, NIGHTQUEUE_JOB_ID: "7", NIGHTQUEUE_JOB_HOME: env.NIGHTQUEUE_HOME }, ["org", "default", "acme"]);
  assert.equal(inJob.status, 1);
  assert.match(inJob.stderr, /refused: /);
  assert.equal(existsSync(configPath(env)), false);
  const lock = lockPath(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, "owner"), String(process.pid));
  t.after(() => rmSync(lock, { recursive: true, force: true }));
  const locked = runCli(env, ["org", "default", "acme"]);
  assert.equal(locked.status, 1);
  assert.match(locked.stderr, /another nightqueue command is writing to the configuration home/);
  assert.equal(existsSync(configPath(env)) ? readFileSync(configPath(env), "utf8").includes(orgIdOf(env, "acme")) : false, false);
});
