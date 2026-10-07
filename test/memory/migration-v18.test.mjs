import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { isId } from "../../src/config/ids.mjs";
import { configPath, dbPath, homeDir, preV18BackupPath, preVersionBackupPath, runDir, runsIdMarkerPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { listDecisions, saveDecision } from "../../src/memory/decisions.mjs";
import { addJob, claimJobById, getJob, sweepOrphans } from "../../src/memory/jobs.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { recentMemories } from "../../src/memory/memory.mjs";
import { finishV18, migrateToV18 } from "../../src/memory/migration/v18.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { logPipelineRun } from "../../src/memory/runs.mjs";
import { sharedSlugPending } from "../../src/memory/shared-slug-migration.mjs";
import { decideResume, ownRunState, resumeHandoff } from "../../src/queue/resume.mjs";
import { buildLegacyHome, legacyConfig, preV22Name } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";

const MIGRATE_URL = new URL("../../test-support/migrate.mjs", import.meta.url).href;
const PATHS_URL = new URL("../../src/config/paths.mjs", import.meta.url).href;
const V18_URL = new URL("../../src/memory/migration/v18.mjs", import.meta.url).href;
const LEASE_REFUSAL = /the database must migrate to v18, but a runner holds a live lease on J-1: stop the runners \(`nightqueue queue run --stop`\) and run the command again$/;

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
function v17Home(t, name, { seed = seedNamedRows, runs = {} } = {}) {
  const env = makeHome(t, name);
  const api = checkout(t, "api");
  const config = legacyConfig({ orgs: { acme: "gh" }, projects: { api: { path: api, org: "acme" } }, extra: { handAdded: { keep: true } } });
  buildLegacyHome(env, { config, seed, runs });
  return { env, api, fixture: readFileSync(dbPath(env)) };
}

// The schema version of the database on disk, read without migrating it.
function diskVersion(env) {
  const db = openDbReadOnly(env, { anySchema: true });
  try {
    return schemaVersionOn(db);
  } finally {
    db.close();
  }
}

test("a v17 home migrates once: the registry is imported, history-only names join the default org, the config is stripped, and a byte copy stays beside it", (t) => {
  const { env, api, fixture } = v17Home(t, "v18-import");
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
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
  const again = migrateTestHome(env);
  assert.equal(again.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.deepEqual(again.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.equal(statSync(preV18BackupPath(env)).mtimeMs, copyStat.mtimeMs, "a second open took another copy");
  assert.equal(readFileSync(configPath(env), "utf8"), configText, "a second open rewrote the config");
});

test("a runner holding a live lease refuses the migration with one line and nothing is written; an expired lease does not block it", async (t) => {
  const running = (lease) => (db) => {
    db.prepare("INSERT INTO jobs (project, prompt, status, worker, lease_until, started_at) VALUES ('api', 'p', 'running', 'w', datetime('now', ?), datetime('now'))").run(lease);
  };
  const { env, fixture } = v17Home(t, "v18-live-lease", { seed: running("+1 hour") });
  assert.throws(() => migrateTestHome(env), (err) => LEASE_REFUSAL.test(err.message) && err.message.split("\n").length === 1);
  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED" && /database at v17, this nightqueue expects v24: run `nightqueue update`/.test(err.message));
  assert.equal(diskVersion(env), 17);
  assert.equal(existsSync(preV18BackupPath(env)), false, "a refused migration published a copy");
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(configPath(env), "utf8")), "projects"), "a refused migration stripped the config");

  const expired = v17Home(t, "v18-expired-lease", { seed: running("-1 hour") });
  const db = migrateTestHome(expired.env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
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
  const db = migrateTestHome(env);
  const rows = db.prepare("SELECT id, project_id, slug, result FROM jobs ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(rows.map((row) => row.slug), ["same-run", null]);
  assert.equal(JSON.parse(rows[1].result).runSlugDetached, "same-run");
  assert.equal(JSON.parse(rows[1].result).runSlugKeptBy, rows[0].id);
  assert.equal(rows[1].project_id, rows[0].project_id, "the detached job changed owner");
  assert.equal(rows[0].project_id, registry.projectByName(db, "api").id);
  assert.equal(sharedSlugPending(db), false);

  closeDb(env);
  const again = migrateTestHome(env);
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
  const db = migrateTestHome(env);
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

  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.deepEqual(namedRows(db, "jobs"), state.jobs);
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(configPath(env), "utf8")), "projects"), false);
});

test("a crash right after the commit leaves v18 with the config and the run directories still by name, and the next open finishes both", async (t) => {
  const { env } = v17Home(t, "v18-crash-after-commit", { seed: seedJobRows, runs: { api: ["run-a"] } });
  const crashed = await crashMigration(t, env, ["afterCommit"]);
  assert.equal(crashed.signal, "SIGKILL", `the migrator was not killed: ${crashed.stdout}`);
  assert.equal(diskVersion(env), 18);
  const stale = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.ok(Object.hasOwn(stale, "projects") && Object.hasOwn(stale, "orgs"), "the config was stripped before the crash");
  assert.ok(existsSync(join(homeDir(env), "runs", "api", "run-a")), "the run directories moved before the crash");
  assert.equal(existsSync(runsIdMarkerPath(env)), false);

  const db = migrateTestHome(env);
  const config = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.equal(Object.hasOwn(config, "projects"), false);
  assert.equal(Object.hasOwn(config, "orgs"), false);
  assert.deepEqual(config.orgConnections, { [registry.orgByName(db, "acme").id]: { github: "gh" } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 7);
  assert.ok(existsSync(runDir(registry.projectByName(db, "api").id, "run-a", env)), "the run directory did not move to the project id");
  assert.equal(existsSync(join(homeDir(env), "runs", "api")), false, "the name directory stayed behind");
  assert.equal(existsSync(runsIdMarkerPath(env)), true);
});

// Writes one file of a run directory, creating the directory.
function writeRunFile(dir, file, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), text);
}

test("the runs move merges a name directory into an id directory entry by entry, never overwrites a run already there, and runs once", (t) => {
  const { env } = v17Home(t, "v18-runs-merge");
  const db = migrateTestHome(env);
  const apiId = registry.projectByName(db, "api").id;
  const byName = join(homeDir(env), "runs", "api");
  rmSync(runsIdMarkerPath(env), { force: true });
  writeRunFile(join(byName, "new-run"), "state.json", "moved\n");
  writeRunFile(join(byName, "taken"), "state.json", "by name\n");
  writeRunFile(runDir(apiId, "taken", env), "state.json", "by id\n");
  writeRunFile(join(homeDir(env), "runs", "unknown-project", "a-run"), "state.json", "nobody's\n");

  const warnings = [];
  finishV18(db, env, { warn: (line) => warnings.push(line) });

  assert.equal(readFileSync(join(runDir(apiId, "new-run", env), "state.json"), "utf8"), "moved\n");
  assert.equal(readFileSync(join(runDir(apiId, "taken", env), "state.json"), "utf8"), "by id\n", "the move overwrote a run already keyed by the id");
  assert.equal(readFileSync(join(byName, "taken", "state.json"), "utf8"), "by name\n", "the conflicting run was lost");
  assert.equal(existsSync(join(byName, "new-run")), false);
  assert.equal(warnings.length, 1, warnings.join("\n"));
  assert.match(warnings[0], /kept .*runs\/api\/taken where it is: .*already exists/);
  assert.ok(existsSync(join(homeDir(env), "runs", "unknown-project", "a-run")), "a directory no project is named after was moved");
  assert.ok(existsSync(runsIdMarkerPath(env)));

  const again = [];
  finishV18(db, env, { warn: (line) => again.push(line) });
  assert.deepEqual(again, [], "the marked move ran again");
  assert.equal(readFileSync(join(byName, "taken", "state.json"), "utf8"), "by name\n");
});

test("a job whose runner died before the upgrade is reclaimed after the migration and resumes from runs/<project id>/<slug>", (t) => {
  const died = (db) => {
    db.prepare(
      "INSERT INTO jobs (project, prompt, status, slug, worker, lease_until, started_at, attempts, max_attempts) VALUES ('api', 'fix the worker', 'running', 'run-a', 'host:1', '2000-01-01 00:00:00', '2000-01-01 00:00:00', 1, 3)",
    ).run();
  };
  const { env } = v17Home(t, "v18-expired-lease-resume", { seed: died, runs: { api: ["run-a"] } });
  const state = { schemaVersion: 1, project: "api", slug: "run-a", resumeCount: 0, branch: "fix/run-a", phases: [{ phase: "triage" }, { phase: "explore" }] };
  writeFileSync(join(homeDir(env), "runs", "api", "run-a", "state.json"), JSON.stringify(state));

  const db = migrateTestHome(env);
  const apiId = registry.projectByName(db, "api").id;
  assert.equal(getJob(1, env).status, "running", "the migration changed the job of the dead runner");
  sweepOrphans(env);
  const job = claimJobById(1, { worker: "host:2", cap: 4 }, env);
  assert.equal(job?.status, "running", "the job of the dead runner was not reclaimed");
  assert.equal(job.project_id, apiId);

  const recorded = ownRunState({ projectId: job.project_id, slug: job.slug, jobId: job.id, env });
  assert.deepEqual(recorded, state, "the run did not follow its job to the project id");
  const handoff = resumeHandoff({ job, resume: decideResume({ state: recorded }), state: recorded, env });
  assert.equal(handoff.runDir, runDir(apiId, "run-a", env));
  assert.equal(handoff.fromPhase, "architecture");
  assert.equal(handoff.branch, "fix/run-a");
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
  db.prepare("INSERT OR IGNORE INTO jobs (id, project, prompt, status, slug) VALUES (1, 'api', 'fix the worker', 'done', 'fix-worker')").run();
  const run = db.prepare("INSERT INTO pipeline_runs (project, slug, tier, outcome, job_id, tier_operator) VALUES (?, ?, 'simple', 'pr_opened', ?, ?)");
  run.run("api", "fix-worker", 1, "simple");
  run.run(null, "a-hunt", null, null);
  run.run("api", "gone", null, null);
  db.exec("DELETE FROM pipeline_runs WHERE slug = 'gone'");
  const phase = db.prepare("INSERT INTO pipeline_phases (run_id, seq, phase) VALUES (?, ?, ?)");
  for (const [runId, seq, name] of [[1, 1, "triage"], [1, 2, "coder"], [2, 1, "triage"]]) phase.run(runId, seq, name);
}

// Every row of a table in id order, keyed by column, from a raw connection, without the v21 `origin` and v23 attempt columns a v17 row never had.
function rowsOf(db, table) {
  return db
    .prepare(`SELECT * FROM ${table} ORDER BY id`)
    .all()
    .map(({ origin: _origin, attempt_started_at: _attemptStartedAt, next_attempt_fresh: _nextAttemptFresh, ...row }) => ({ ...row }));
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
  const db = migrateTestHome(env);
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

// Inserts what a v17 build wrote for decisions and the roadmap: project, org and global decisions all numbered #1, an org item
// tracking two projects with its comments, a project item linked to a job, and the highest decision and item deleted.
function seedOwnedRows(db) {
  const decision = db.prepare("INSERT INTO decisions (scope, project, org, number, title, context, decision, status) VALUES (?, ?, ?, ?, ?, 'c', 'd', 'accepted')");
  decision.run("project", "api", null, 1, "the api keeps a zebradecision cache");
  decision.run("org", null, "acme", 1, "every acme repo shares one queue");
  decision.run("org", null, "orbit", 1, "orbit decides alone");
  decision.run("project", null, null, 1, "a global decision every project reads");
  decision.run("project", "api", null, 2, "gone");
  db.exec("DELETE FROM decisions WHERE title = 'gone'");
  const item = db.prepare("INSERT INTO roadmap_items (scope, project, org, title, status, priority, position, job_id) VALUES (?, ?, ?, ?, ?, 5, ?, ?)");
  item.run("org", null, "acme", "raise the zebraitem node version", "in_progress", 1, null);
  item.run("project", "api", null, "fix the worker", "in_progress", 1, 1);
  item.run("project", "api", null, "gone", "todo", 2, null);
  db.exec("DELETE FROM roadmap_items WHERE title = 'gone'");
  const row = db.prepare("INSERT INTO roadmap_item_projects (item_id, project, status, job_id) VALUES (1, ?, ?, ?)");
  row.run("api", "in_progress", 1);
  row.run("web", "todo", null);
  const comment = db.prepare("INSERT INTO roadmap_comments (item_id, kind, author, body, project) VALUES (?, ?, ?, ?, ?)");
  comment.run(1, "queued", "job:1", "queued for api with a zebracomment", "api");
  comment.run(1, "note", "operator", "an item-level note", null);
  comment.run(2, "queued", "job:1", "queued as job #1", null);
}

// Every row a v17 build could leave, over all ten data tables and the phases of the runs.
function seedAcceptanceRows(db) {
  seedJobRows(db);
  db.prepare("INSERT INTO jobs (project, prompt, status, slug) VALUES ('api', ?, 'failed', 'same-run')").run("shared first");
  db.prepare("INSERT INTO jobs (project, prompt, status, slug) VALUES ('api', ?, 'failed', 'same-run')").run("shared second");
  seedProjectRows(db);
  const lesson = db.prepare("INSERT INTO lessons (project, title, root_cause, solution, prevention) VALUES (?, ?, 'r', 's', 'p')");
  for (const project of ["Foo", "foo", "Bad Name!", "web"]) lesson.run(project, `a lesson of ${project}`);
  seedOwnedRows(db);
}

const TRACKER_TABLES = ["issues", "issue_projects", "issue_comments"];

const ALL_TABLES = [...PROJECT_TABLES, "jobs", "decisions", ...TRACKER_TABLES, "pipeline_phases"];

// The rows of a v18 table with every owner id swapped for the name it resolves to, the shape a v17 table had.
function ownerNamedRows(db, table) {
  return rowsOf(db, table).map(({ project_id: projectId, org_id: orgId, ...row }) => ({
    ...row,
    ...(projectId === undefined ? {} : { project: projectId ? registry.projectById(db, projectId).name : null }),
    ...(orgId === undefined ? {} : { org: orgId ? registry.orgById(db, orgId).name : null }),
  }));
}

// One run directory per project with a checkout or a history (a case-only pair would share one directory on a case-insensitive disk).
const ACCEPTANCE_RUNS = { api: ["fix-worker"], web: ["web-run"], history: ["old-run"], "Bad Name!": ["odd-run"] };
const ACCEPTANCE_STATE = '{"schemaVersion":1,"project":"api","slug":"fix-worker","phases":[{"phase":"triage"}]}\n';

// The entries of the runs directory, dotfiles included, sorted.
function runEntries(env) {
  return readdirSync(join(homeDir(env), "runs")).sort();
}

// A v17 home holding the whole acceptance fixture: two config projects of `acme` (one bound to GitHub), a hand-added key, and every table seeded.
function acceptanceHome(t, name) {
  const env = makeHome(t, name);
  const config = legacyConfig({
    orgs: { acme: "gh" },
    projects: { api: { path: checkout(t, "api"), org: "acme" }, web: { path: checkout(t, "web"), org: "acme" } },
    extra: { handAdded: { keep: true } },
  });
  buildLegacyHome(env, { config, seed: seedAcceptanceRows, runs: ACCEPTANCE_RUNS });
  writeFileSync(join(homeDir(env), "runs", "api", "fix-worker", "state.json"), ACCEPTANCE_STATE);
  return { env, config, fixture: readFileSync(dbPath(env)) };
}

test("acceptance: every table of a v17 home is rebuilt by id with the same rows, the registry imported, the config stripped, and a second open changes nothing", (t) => {
  const { env, config: v17Config, fixture } = acceptanceHome(t, "v18-acceptance");
  const db = migrateTestHome(env);
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
  const before = new DatabaseSync(preV18BackupPath(env), { readOnly: true });
  t.after(() => before.close());
  const tracker = new DatabaseSync(preVersionBackupPath(env, 24), { readOnly: true });
  t.after(() => tracker.close());
  const source = (table) => (TRACKER_TABLES.includes(table) ? tracker : db);
  assert.ok(readFileSync(preV18BackupPath(env)).equals(fixture), "the pre-v18 copy is not the v17 database byte for byte");
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'issue%'").all(), [], "v24 left a tracker object");

  for (const table of ALL_TABLES) {
    const count = (connection, name) => connection.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
    assert.equal(count(source(table), table), count(before, preV22Name(table)), `${table} lost or gained rows`);
    const columns = source(table).prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
    assert.equal(columns.includes("project") || columns.includes("org"), false, `${table} still owns rows by name`);
  }
  const detached = rowsOf(db, "jobs").find((row) => row.prompt === "shared second");
  assert.equal(detached.slug, null, "the shared slug was not detached");
  assert.equal(JSON.parse(detached.result).runSlugDetached, "same-run");
  const withoutV19Number = (table, rows) => (table === "issues" ? rows.map(({ number: _number, ...row }) => row) : rows);
  for (const table of ALL_TABLES) {
    const unchanged = (rows) => rows.filter((row) => row.id !== detached.id || table !== "jobs");
    assert.deepEqual(unchanged(withoutV19Number(table, ownerNamedRows(source(table), table))), unchanged(rowsOf(before, preV22Name(table))), `${table} changed in the rebuild`);
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(sharedSlugPending(db), false);

  const projects = Object.fromEntries(registry.listProjects(db).map((project) => [project.name, project]));
  assert.deepEqual(Object.keys(projects).sort(), ["Bad Name!", "Foo", "api", "foo", "history", "web"].sort());
  assert.notEqual(projects.Foo.id, projects.foo.id, "the case pair was collapsed");
  for (const name of ["history", "Foo", "foo", "Bad Name!"]) {
    assert.equal(projects[name].path, null, `${name} got a path`);
    assert.equal(projects[name].org, "default", `${name} is not in the default org`);
  }
  assert.deepEqual(registry.listOrgs(db).map((org) => org.name), ["default", "acme", "orbit"]);

  const match = (mirror, word, connection = db) => connection.prepare(`SELECT rowid FROM ${mirror} WHERE ${mirror} MATCH ?`).all(word).map((row) => row.rowid);
  assert.deepEqual(match("lessons_fts", "zebracrossing"), [1]);
  assert.deepEqual(match("decisions_fts", "zebradecision"), [1]);
  assert.deepEqual(match("issues_fts", "zebraitem", tracker), [1]);
  assert.deepEqual(match("issue_comments_fts", "zebracomment", tracker), [1]);
  const indexed = db.prepare("SELECT COUNT(*) AS n FROM jobs_fts").get().n;
  assert.equal(indexed, db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, "the job index misses or repeats a job");
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'jobs' AND name LIKE 'jobs_fts_%' ORDER BY name").all();
  assert.deepEqual(triggers.map((row) => row.name), ["jobs_fts_ad", "jobs_fts_ai", "jobs_fts_au"]);

  const api = projects.api;
  assert.deepEqual(
    listDecisions({ projectId: api.id }, env).map((row) => [row.scope, row.org ?? row.project, row.number]),
    [["org", "acme", 1], ["project", "api", 1], ["project", null, 1]],
    "a project reads its own decisions, its org's first, and the global ones, never another org's",
  );
  assert.equal(saveDecision({ projectId: api.id, title: "t", context: "c", decision: "d" }, env).id, 6, "a decision id was reused");
  const orgRows = tracker.prepare("SELECT p.name, r.status FROM issue_projects r JOIN projects p ON p.id = r.project_id WHERE r.item_id = 1 ORDER BY p.name").all();
  assert.deepEqual(orgRows.map((row) => [row.name, row.status]), [["api", "in_progress"], ["web", "todo"]]);

  const config = JSON.parse(readFileSync(configPath(env), "utf8"));
  const { projects: _projects, orgs: _orgs, ...kept } = v17Config;
  assert.deepEqual(config, {
    ...kept,
    defaultOrg: registry.orgByName(db, "default").id,
    orgConnections: { [registry.orgByName(db, "acme").id]: { github: "gh" } },
  });

  for (const [name, slugs] of Object.entries(ACCEPTANCE_RUNS)) {
    assert.equal(existsSync(join(homeDir(env), "runs", name)), false, `runs/${name} is still keyed by the name`);
    for (const slug of slugs) assert.ok(existsSync(runDir(projects[name].id, slug, env)), `runs/<id of ${name}>/${slug} is missing`);
  }
  assert.equal(readFileSync(join(runDir(api.id, "fix-worker", env), "state.json"), "utf8"), ACCEPTANCE_STATE, "a run lost its content in the move");
  assert.deepEqual(runEntries(env), [".by-id", ...Object.keys(ACCEPTANCE_RUNS).map((name) => projects[name].id)].sort());

  const copyStat = statSync(preV18BackupPath(env));
  const markerStat = statSync(runsIdMarkerPath(env));
  const runs = runEntries(env);
  const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
  const configText = readFileSync(configPath(env), "utf8");
  closeDb(env);
  const again = migrateTestHome(env);
  assert.equal(again.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
  assert.deepEqual(runEntries(env), runs, "a second open moved the run directories again");
  assert.equal(statSync(runsIdMarkerPath(env)).mtimeMs, markerStat.mtimeMs, "a second open rewrote the marker");
  assert.deepEqual(again.prepare("SELECT sql FROM sqlite_master ORDER BY name").all(), schema);
  assert.equal(statSync(preV18BackupPath(env)).mtimeMs, copyStat.mtimeMs, "a second open took another copy");
  assert.ok(readFileSync(preV18BackupPath(env)).equals(fixture));
  assert.equal(readFileSync(configPath(env), "utf8"), configText, "a second open rewrote the config");
  assert.equal(sharedSlugPending(again), false);
});

test("a v17 decision whose owner breaks the v18 owner rule fails the migration naming its row, and nothing is written", (t) => {
  const conflict = (db) => {
    db.prepare("INSERT INTO decisions (scope, project, org, number, title, context, decision) VALUES ('project', 'api', 'acme', 1, 't', 'c', 'd')").run();
  };
  const { env, fixture } = v17Home(t, "v18-owner-conflict", { seed: conflict });
  assert.throws(
    () => migrateTestHome(env),
    /migration to v18 failed at decisions: decisions row 1 has scope `project` with project `api` and org `acme`: a project row names no org, an org row names an org and no project; nothing was written, the database is still at v17/,
  );
  assert.equal(diskVersion(env), 17);
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a failed migration wrote to the database");
  assert.ok(Object.hasOwn(JSON.parse(readFileSync(configPath(env), "utf8")), "projects"), "a failed migration stripped the config");
});

// Source of a process that opens the home's database and prints the version and the registry it found.
function openerSource() {
  return [
    `import { migrateTestHome } from ${JSON.stringify(MIGRATE_URL)};`,
    "const startAt = Number(process.argv[2]);",
    "while (Date.now() < startAt) {}",
    "try {",
    "  const db = migrateTestHome(process.env);",
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
    { version: DB_USER_VERSION, projects: 5, error: null },
    { version: DB_USER_VERSION, projects: 5, error: null },
  ]);
  assert.ok(readFileSync(preV18BackupPath(env)).equals(fixture), "the copy is not the v17 database");
  assert.equal(migrateTestHome(env).prepare("SELECT COUNT(*) AS n FROM lessons").get().n, 4);
});
