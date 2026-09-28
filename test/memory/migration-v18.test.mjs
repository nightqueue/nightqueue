import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isId } from "../../src/config/ids.mjs";
import { configPath, dbPath, preV18BackupPath } from "../../src/config/paths.mjs";
import { closeDb, migrateIfOutdated, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { recentMemories } from "../../src/memory/memory.mjs";
import { migrateToV18 } from "../../src/memory/migration/v18.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { sharedSlugPending } from "../../src/memory/shared-slug-migration.mjs";
import { buildLegacyHome, legacyConfig } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const DB_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;
const PATHS_URL = new URL("../../src/config/paths.mjs", import.meta.url).href;
const V18_URL = new URL("../../src/memory/migration/v18.mjs", import.meta.url).href;
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
  const rows = db.prepare("SELECT id, project_id, slug, result FROM jobs ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(rows.map((row) => row.slug), ["same-run", null]);
  assert.equal(JSON.parse(rows[1].result).runSlugDetached, "same-run");
  assert.equal(JSON.parse(rows[1].result).runSlugKeptBy, rows[0].id);
  assert.equal(rows[1].project_id, rows[0].project_id, "the detached job changed owner");
  assert.equal(rows[0].project_id, registry.projectByName(db, "api").id);
  assert.equal(sharedSlugPending(db), false);

  closeDb(env);
  const again = openDb(env);
  assert.deepEqual(again.prepare("SELECT id, project_id, slug, result FROM jobs ORDER BY id").all().map((row) => ({ ...row })), rows, "a second open detached again");
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the jobs of a settled run");
});

const CLOSED_CHECKLIST = JSON.stringify({ steps: { merge: { status: "done" } }, data: { merged: true } });

// Inserts the jobs a v17 build wrote in every shape the queue leaves: each status, an expired lease, a closed job with its merge, the highest id deleted.
function seedJobRows(db) {
  const job = db.prepare(
    "INSERT INTO jobs (project, prompt, status, slug, pr_url, close, worker, lease_until, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  job.run("api", "a pending job", "pending", null, null, null, null, null, "simple");
  job.run("api", "a job whose runner died", "running", "run-a", null, null, "host:1", "2000-01-01 00:00:00", null);
  job.run("history", "a done job", "done", "run-b", "https://github.com/acme/api/pull/1", null, null, null, null);
  job.run("api", "a closed job", "closed", "run-c", "https://github.com/acme/api/pull/2", CLOSED_CHECKLIST, null, null, "complex");
  job.run("Foo", "a gated job", "gate", "run-d", null, null, null, null, null);
  job.run("foo", "a failed job", "failed", null, null, null, null, null, null);
  job.run("Bad Name!", "a cancelled job", "cancelled", null, null, null, null, null, null);
  job.run("api", "gone", "failed", null, null, null, null, null, null);
  db.exec("DELETE FROM jobs WHERE prompt = 'gone'");
}

test("the jobs table is rebuilt by id: same rows and values, the closed invariant and the foreign key armed, the id counter kept", (t) => {
  const { env } = v17Home(t, "v18-jobs", { seed: seedJobRows });
  const db = openDb(env);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const before = new DatabaseSync(preV18BackupPath(env), { readOnly: true });
  t.after(() => before.close());

  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
  assert.ok(columns.includes("project_id") && !columns.includes("project"), "jobs still owns rows by name");
  assert.deepEqual(namedRows(db, "jobs"), legacyRows(before, "jobs"));
  assert.deepEqual(
    [...new Set(rowsOf(db, "jobs").map((row) => row.status))].sort(),
    ["cancelled", "closed", "done", "failed", "gate", "pending", "running"],
  );
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    db.prepare("PRAGMA index_info(jobs_project_slug_idx)").all().map((column) => column.name),
    ["project_id", "slug"],
  );

  assert.throws(() => db.prepare("INSERT INTO jobs (project_id, prompt) VALUES (?, 'x')").run("0".repeat(26)), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE jobs SET status = 'closed' WHERE prompt = 'a done job'").run(), /CHECK constraint failed/);
  assert.equal(addJob({ projectId: registry.projectByName(db, "api").id, prompt: "after" }, env).id, 9, "a job id was reused");
  assert.equal(getJob(2, env).project, "api", "a job view lost its project name");
});

// Source of a process that runs the v18 migration on a raw connection and kills itself at the given hook.
function crashingMigratorSource() {
  return [
    'import { DatabaseSync } from "node:sqlite";',
    `import { dbPath } from ${JSON.stringify(PATHS_URL)};`,
    `import { migrateToV18 } from ${JSON.stringify(V18_URL)};`,
    "const [, , hook, table] = process.argv;",
    "const db = new DatabaseSync(dbPath(process.env));",
    'db.exec("PRAGMA busy_timeout = 5000");',
    'const kill = () => process.kill(process.pid, "SIGKILL");',
    'const hooks = hook === "afterTable" ? { afterTable: (name) => name === table && kill() } : { afterCommit: kill };',
    "migrateToV18(db, process.env, hooks);",
    'process.stdout.write("survived\\n");',
    "",
  ].join("\n");
}

// Runs the crashing migrator as a real child process and answers how it ended.
function crashMigration(t, env, args) {
  const script = join(makeDir(t, "v18-crash-script"), "migrator.mjs");
  writeFileSync(script, crashingMigratorSource());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout }));
  });
}

test("a migration killed in the middle of the transaction, right after it rebuilt jobs, leaves v17 intact and the next open migrates it", async (t) => {
  const { env } = v17Home(t, "v18-kill-mid", { seed: seedJobRows });
  const crashed = await crashMigration(t, env, ["afterTable", "jobs"]);
  assert.equal(crashed.signal, "SIGKILL", `the migrator was not killed: ${crashed.stdout}`);

  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const raw = new DatabaseSync(dbPath(env));
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  const state = {
    version: raw.prepare("PRAGMA user_version").get().user_version,
    jobColumns: raw.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name),
    jobs: legacyRows(raw, "jobs"),
  };
  raw.close();
  assert.equal(state.version, 17);
  assert.ok(state.jobColumns.includes("project") && !state.jobColumns.includes("project_id"), "the killed rebuild of jobs survived");
  assert.equal(tables.includes("projects"), false, "the killed migration left a registry behind");
  assert.equal(tables.some((name) => name.endsWith("_v18")), false, `a half-built table survived: ${tables.join(", ")}`);
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(configPath(env), "utf8")), "projects"), "a killed migration stripped the config");

  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 18);
  assert.deepEqual(namedRows(db, "jobs"), state.jobs);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(configPath(env), "utf8")), "projects"), false);
});

test("a crash right after the commit leaves v18 with the config still by name, and the next open finishes it", async (t) => {
  const { env } = v17Home(t, "v18-crash-after-commit", { seed: seedJobRows });
  const crashed = await crashMigration(t, env, ["afterCommit"]);
  assert.equal(crashed.signal, "SIGKILL", `the migrator was not killed: ${crashed.stdout}`);
  assert.equal(diskVersion(env), 18);
  const stale = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.ok(Object.hasOwn(stale, "projects") && Object.hasOwn(stale, "orgs"), "the config was stripped before the crash");

  const db = openDb(env);
  const config = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.equal(Object.hasOwn(config, "projects"), false);
  assert.equal(Object.hasOwn(config, "orgs"), false);
  assert.deepEqual(config.orgConnections, { [registry.orgByName(db, "acme").id]: { github: "gh" } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 7);
});

const PROJECT_TABLES = ["lessons", "memory", "project_index", "project_libs", "pipeline_runs"];

// Inserts the rows of the five project-only tables a v17 build wrote, the highest lesson and run deleted so their counters sit past the rows.
function seedProjectRows(db) {
  const lesson = db.prepare("INSERT INTO lessons (project, title, root_cause, solution, prevention) VALUES (?, ?, 'r', 's', 'p')");
  for (const [project, title] of [["api", "the zebracrossing lesson of api"], [null, "a global lesson"], ["history", "a lesson of history"], ["api", "gone"]]) {
    lesson.run(project, title);
  }
  db.exec("DELETE FROM lessons WHERE title = 'gone'");
  const memory = db.prepare("INSERT INTO memory (project, key, value) VALUES (?, ?, ?)");
  memory.run("api", "deploy", "the zebracrossing pipeline deploys it");
  memory.run(null, "global", "a global fact");
  db.prepare("INSERT INTO project_index (project, path, responsibility, mtime_ms) VALUES ('api', 'src/a.mjs', 'the module', 7)").run();
  db.prepare("INSERT INTO project_libs (project, lib, version) VALUES ('api', 'zod', '4.5.4')").run();
  const run = db.prepare("INSERT INTO pipeline_runs (project, slug, tier, outcome, job_id, tier_operator) VALUES (?, ?, 'simple', 'pr_opened', ?, ?)");
  run.run("api", "fix-worker", 1, "simple");
  run.run(null, "a-hunt", null, null);
  run.run("api", "gone", null, null);
  db.exec("DELETE FROM pipeline_runs WHERE slug = 'gone'");
  const phase = db.prepare("INSERT INTO pipeline_phases (run_id, seq, phase) VALUES (?, ?, ?)");
  for (const [runId, seq, name] of [[1, 1, "triage"], [1, 2, "coder"], [2, 1, "triage"]]) phase.run(runId, seq, name);
}

// Every row of a table in id order, keyed by column, from a raw connection.
function rowsOf(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }));
}

// The rows of a v18 table with their owner id swapped for the name it resolves to, the shape a v17 table had.
function namedRows(db, table) {
  return rowsOf(db, table).map(({ project_id: projectId, ...row }) => ({ ...row, project: projectId ? registry.projectById(db, projectId).name : null }));
}

// The rows of a v17 table with the owner name moved to the end, so both shapes compare column by column.
function legacyRows(db, table) {
  return rowsOf(db, table).map(({ project, ...row }) => ({ ...row, project }));
}

test("the five project-only tables are rebuilt by id: same rows, same values, the phases of every run kept, the mirrors and the counters intact", (t) => {
  const { env } = v17Home(t, "v18-project-tables", { seed: seedProjectRows });
  const db = openDb(env);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const before = new DatabaseSync(preV18BackupPath(env), { readOnly: true });
  t.after(() => before.close());

  for (const table of PROJECT_TABLES) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    assert.ok(columns.includes("project_id") && !columns.includes("project"), `${table} still owns rows by name`);
    assert.deepEqual(namedRows(db, table), legacyRows(before, table), `${table} changed in the rebuild`);
  }
  assert.deepEqual(rowsOf(db, "pipeline_phases"), rowsOf(before, "pipeline_phases"), "the rebuild of pipeline_runs lost its phases");
  assert.equal(rowsOf(db, "pipeline_phases").length, 3);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

  const match = (mirror, word) => db.prepare(`SELECT rowid FROM ${mirror} WHERE ${mirror} MATCH ?`).all(word).map((row) => row.rowid);
  assert.deepEqual(match("lessons_fts", "zebracrossing"), [1]);
  assert.deepEqual(match("memory_fts", "zebracrossing"), [1]);

  const apiId = registry.projectByName(db, "api").id;
  assert.equal(saveLesson({ projectId: apiId, title: "t", root_cause: "r", solution: "s", prevention: "p" }, env).id, 5, "a lesson id was reused");
  assert.equal(logPipelineRun({ projectId: apiId, slug: "next", tier: "simple", outcome: "pr_opened" }, env).runId, 4, "a run id was reused");
  assert.deepEqual(recentMemories({ projectId: apiId }, env).map((row) => [row.key, row.project]), [["deploy", "api"], ["global", null]]);
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
