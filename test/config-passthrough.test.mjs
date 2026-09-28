import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultContext, run } from "../src/cli/index.mjs";
import { setupEmbedding } from "../src/cli/install-steps.mjs";
import { makeReport } from "../src/cli/report.mjs";
import { isId } from "../src/config/ids.mjs";
import { configPath, dbPath, secretsPath } from "../src/config/paths.mjs";
import { ensureHome, loadConfig, saveConfig } from "../src/config/store.mjs";
import { legacyConfig } from "../test-support/legacy-home.mjs";
import { makeDir, makeHome, orgIdOf } from "../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args) {
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

// A checkout directory the v17 config registers.
function checkout(t, name) {
  const dir = join(makeDir(t, `passthrough-${name}`), name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return realpathSync(dir);
}

// A home that only has the v1 config.json a v17 build wrote: two projects, an org with a GitHub binding, and a key nightqueue does not know.
function configOnlyHome(t, name) {
  const env = makeHome(t, name);
  const api = checkout(t, "api");
  const web = checkout(t, "web");
  const config = legacyConfig({
    orgs: { acme: "gh" },
    projects: { api: { path: api, org: "acme" }, web: { path: web } },
    extra: { handAdded: { keep: true } },
  });
  ensureHome(env);
  writeFileSync(configPath(env), `${JSON.stringify(config, null, 2)}\n`);
  return { env, api, web };
}

// The raw config.json of a home.
function rawConfig(env) {
  return JSON.parse(readFileSync(configPath(env), "utf8"));
}

// An in-process CLI context of a home, capturing what the command prints.
function makeCtx(env) {
  const out = [];
  const err = [];
  return { ctx: { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) }, out, err };
}

test("config writes made before the first database open keep the v17 registry, and the first open imports it", async (t) => {
  const { env, api, web } = configOnlyHome(t, "passthrough-writes");
  delete env.NIGHTQUEUE_EMBED_DISABLED;
  const { ctx } = makeCtx(env);
  await setupEmbedding(ctx, makeReport(ctx), { embedding: false });
  assert.equal(existsSync(dbPath(env)), false, "the decline opened the database");
  const declined = rawConfig(env);
  assert.equal(declined.embedding, "declined");
  assert.deepEqual(Object.keys(declined.projects), ["api", "web"]);
  assert.deepEqual(declined.handAdded, { keep: true });

  writeFileSync(secretsPath(env), `${JSON.stringify({ version: 1, connections: { other: { type: "github", token: "t" } } })}\n`, { mode: 0o600 });
  assert.equal(await run(["connection", "remove", "other"], ctx), 0);

  const listed = JSON.parse(runCli(env, ["project", "list", "--json"]).stdout).projects;
  assert.deepEqual(listed.map((project) => [project.name, project.path, project.org]), [["api", api, "acme"], ["web", web, "default"]]);
  assert.equal(rawConfig(env).embedding, "declined");
});

test("a config-only v17 home lists its projects with their paths, and the config is stripped afterwards", (t) => {
  const { env, api, web } = configOnlyHome(t, "passthrough-config-only");
  const listed = runCli(env, ["project", "list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, `api  ${api}  acme  ok\nweb  ${web}  default  ok\n`);

  const stripped = rawConfig(env);
  assert.equal(Object.hasOwn(stripped, "projects"), false, "the registry stayed in config.json");
  assert.equal(Object.hasOwn(stripped, "orgs"), false, "the registry stayed in config.json");
  assert.ok(isId(stripped.defaultOrg));
  assert.equal(stripped.defaultOrg, orgIdOf(env, "default"));
  assert.deepEqual(stripped.orgConnections, { [orgIdOf(env, "acme")]: { github: "gh" } });
  assert.deepEqual(stripped.handAdded, { keep: true });
  assert.deepEqual(stripped.queue, { maxConcurrent: null });

  const again = runCli(env, ["project", "list"]);
  assert.equal(again.stdout, listed.stdout);
  assert.deepEqual(rawConfig(env), stripped, "a second open rewrote the stripped config");
});

test("a hand-added top-level key survives saveConfig", (t) => {
  const env = makeHome(t, "passthrough-save");
  ensureHome(env);
  writeFileSync(configPath(env), `${JSON.stringify({ version: 1, queue: { maxConcurrent: 2 }, handAdded: [1, "two"] })}\n`);
  saveConfig({ ...loadConfig(env), embedding: "declined" }, env);
  const saved = rawConfig(env);
  assert.deepEqual(saved.handAdded, [1, "two"]);
  assert.equal(saved.embedding, "declined");
  assert.equal(saved.queue.maxConcurrent, 2);
});
