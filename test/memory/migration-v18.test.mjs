import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isId } from "../../src/config/ids.mjs";
import { configPath, dbPath, preV18BackupPath } from "../../src/config/paths.mjs";
import { closeDb, migrateIfOutdated, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { migrateToV18 } from "../../src/memory/migration/v18.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { buildLegacyHome, legacyConfig } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const DB_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;
const LEASE_REFUSAL = /the database must migrate to v18, but a runner holds a live lease on job #1: stop the runners \(`nightqueue queue run --stop`\) and run the command again$/;

// A checkout directory a v17 config registers.
function checkout(t, name) {
  const dir = join(makeDir(t, `v18-${name}`), name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return realpathSync(dir);
}

// Inserts the named rows a v17 build wrote: jobs, lessons and decisions under project and org names, some known only from history.
function seedNamedRows(db) {
  const job = db.prepare("INSERT INTO jobs (project, prompt, status, slug) VALUES (?, ?, ?, ?)");
  job.run("api", "fix the worker", "done", "fix-worker");
  job.run("history", "an old job", "failed", null);
  const lesson = db.prepare("INSERT INTO lessons (project, title, root_cause, solution, prevention) VALUES (?, ?, 'r', 's', 'p')");
  for (const project of ["Foo", "foo", "Bad Name!", null]) lesson.run(project, `a lesson of ${project}`);
  db.prepare("INSERT INTO decisions (scope, org, number, title, context, decision) VALUES ('org', 'orbit', 1, 't', 'c', 'd')").run();
  db.prepare("INSERT INTO decisions (scope, project, number, title, context, decision) VALUES ('project', 'api', 1, 't', 'c', 'd')").run();
}

// A v17 home: a config with an org bound to a GitHub connection and a hand-added key, and the named rows above.
function v17Home(t, name, { seed = seedNamedRows } = {}) {
  const env = makeHome(t, name);
  const api = checkout(t, "api");
  const config = legacyConfig({ orgs: { acme: "gh" }, projects: { api: { path: api, org: "acme" } }, extra: { handAdded: { keep: true } } });
  buildLegacyHome(env, { config, seed });
  return { env, api, fixture: readFileSync(dbPath(env)) };
}

// The schema version of the database on disk, read without migrating it.
function diskVersion(env) {
  const db = openDbReadOnly(env);
  try {
    return schemaVersionOn(db);
  } finally {
    db.close();
  }
}

test("a v17 home migrates once: the registry is imported, history-only names join the default org, the config is stripped, and a byte copy stays beside it", (t) => {
  const { env, api, fixture } = v17Home(t, "v18-import");
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 18);
  assert.ok(readFileSync(preV18BackupPath(env)).equals(fixture), "the pre-v18 copy is not the v17 database byte for byte");

  const projects = Object.fromEntries(registry.listProjects(db).map((project) => [project.name, project]));
  assert.deepEqual(Object.keys(projects).sort(), ["Bad Name!", "Foo", "api", "foo", "history"].sort());
  assert.equal(projects.api.path, api);
  assert.equal(projects.api.org, "acme");
  for (const name of ["history", "Foo", "foo", "Bad Name!"]) {
    assert.equal(projects[name].path, null, `${name} got a path`);
    assert.equal(projects[name].org, "default", `${name} is not in the default org`);
  }
  assert.ok(Object.values(projects).every((project) => isId(project.id)));
  assert.deepEqual(registry.listOrgs(db).map((org) => org.name), ["default", "acme", "orbit"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lessons").get().n, 4);

  const config = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.equal(Object.hasOwn(config, "projects"), false);
  assert.equal(Object.hasOwn(config, "orgs"), false);
  assert.equal(config.defaultOrg, registry.orgByName(db, "default").id);
  assert.deepEqual(config.orgConnections, { [registry.orgByName(db, "acme").id]: { github: "gh" } });
  assert.deepEqual(config.handAdded, { keep: true });

  const copyStat = statSync(preV18BackupPath(env));
  const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  const configText = readFileSync(configPath(env), "utf8");
  closeDb(env);
  const again = openDb(env);
  assert.equal(again.prepare("PRAGMA user_version").get().user_version, 18);
  assert.deepEqual(again.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.equal(statSync(preV18BackupPath(env)).mtimeMs, copyStat.mtimeMs, "a second open took another copy");
  assert.equal(readFileSync(configPath(env), "utf8"), configText, "a second open rewrote the config");
});

test("a runner holding a live lease refuses the migration with one line and nothing is written; an expired lease does not block it", async (t) => {
  const running = (lease) => (db) => {
    db.prepare("INSERT INTO jobs (project, prompt, status, worker, lease_until, started_at) VALUES ('api', 'p', 'running', 'w', datetime('now', ?), datetime('now'))").run(lease);
  };
  const { env, fixture } = v17Home(t, "v18-live-lease", { seed: running("+1 hour") });
  assert.throws(() => openDb(env), (err) => LEASE_REFUSAL.test(err.message) && err.message.split("\n").length === 1);
  await assert.rejects(async () => migrateIfOutdated(env), (err) => LEASE_REFUSAL.test(err.message) && !err.message.includes("could not be migrated"));
  assert.equal(diskVersion(env), 17);
  assert.equal(existsSync(preV18BackupPath(env)), false, "a refused migration published a copy");
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(configPath(env), "utf8")), "projects"), "a refused migration stripped the config");

  const expired = v17Home(t, "v18-expired-lease", { seed: running("-1 hour") });
  const db = openDb(expired.env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 18);
  assert.equal(db.prepare("SELECT status FROM jobs").get().status, "running");
});

test("the gate is re-read before every copy: a second connection finds the database migrated and neither copies nor migrates again", (t) => {
  const { env, fixture } = v17Home(t, "v18-gate");
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const first = new DatabaseSync(dbPath(env));
  const second = new DatabaseSync(dbPath(env));
  t.after(() => {
    first.close();
    second.close();
  });
  const commits = [];
  assert.equal(migrateToV18(first, env, { afterCommit: () => commits.push("first") }), true);
  const copied = statSync(preV18BackupPath(env)).mtimeMs;
  assert.equal(migrateToV18(second, env, { afterCommit: () => commits.push("second") }), false);
  assert.deepEqual(commits, ["first"]);
  assert.equal(statSync(preV18BackupPath(env)).mtimeMs, copied, "the second connection published another copy");
  assert.ok(readFileSync(preV18BackupPath(env)).equals(fixture));
});

test("two jobs of a v17 home sharing a run slug are detached by name before the migration, and one keeps the slug", (t) => {
  const shared = (db) => {
    const job = db.prepare("INSERT INTO jobs (project, prompt, status, slug, branch) VALUES ('api', ?, 'failed', 'same-run', 'feat/same-run')");
    job.run("first attempt");
    job.run("second attempt");
  };
  const { env } = v17Home(t, "v18-shared-slug", { seed: shared });
  const db = openDb(env);
  const rows = db.prepare("SELECT id, slug, result FROM jobs ORDER BY id").all();
  assert.deepEqual(rows.map((row) => row.slug), ["same-run", null]);
  assert.equal(JSON.parse(rows[1].result).runSlugDetached, "same-run");
});

// Source of a process that opens the home's database and prints the version and the registry it found.
function openerSource() {
  return [
    `import { openDb } from ${JSON.stringify(DB_URL)};`,
    "const startAt = Number(process.argv[2]);",
    "while (Date.now() < startAt) {}",
    "try {",
    "  const db = openDb(process.env);",
    '  const version = db.prepare("PRAGMA user_version").get().user_version;',
    '  const projects = db.prepare("SELECT COUNT(*) AS n FROM projects").get().n;',
    '  process.stdout.write(JSON.stringify({ version, projects, error: null }) + "\\n");',
    "} catch (err) {",
    '  process.stdout.write(JSON.stringify({ version: null, projects: null, error: err.message }) + "\\n");',
    "}",
    "",
  ].join("\n");
}

// Runs one opener as a real child process.
function spawnOpener(env, script, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, String(startAt)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", () => resolve(JSON.parse(stdout.trim())));
  });
}

test("two processes opening one v17 home end with one migration, the same registry, and the v17 bytes in the copy", async (t) => {
  const { env, fixture } = v17Home(t, "v18-race");
  const script = join(makeDir(t, "v18-race-script"), "opener.mjs");
  writeFileSync(script, openerSource());
  const startAt = Date.now() + 400;
  const results = await Promise.all([spawnOpener(env, script, startAt), spawnOpener(env, script, startAt)]);
  assert.deepEqual(results, [
    { version: 18, projects: 5, error: null },
    { version: 18, projects: 5, error: null },
  ]);
  assert.ok(readFileSync(preV18BackupPath(env)).equals(fixture), "the copy is not the v17 database");
  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM lessons").get().n, 4);
});
