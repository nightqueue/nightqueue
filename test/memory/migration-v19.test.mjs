import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dbPath, preV18BackupPath, preV19BackupPath, preVersionBackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { projectFromCwd, registeredProject } from "../../src/memory/registry-access.mjs";
import { buildLegacyHome, preV22Name } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";
import { buildV18Home } from "../../test-support/v18-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

const MIGRATE_URL = new URL("../../test-support/migrate.mjs", import.meta.url).href;
const TRACKER_TABLES = ["issues", "issue_comments", "issue_projects"];
const KEPT_TABLES = ["orgs", "projects", "decisions", "jobs", "lessons", "memory"];
const TABLES = [...KEPT_TABLES, ...TRACKER_TABLES];

// A checkout directory the fixture registers for `nightqueue`.
function checkout(t) {
  const dir = join(makeDir(t, "v19-checkout"), "nightqueue");
  mkdirSync(join(dir, ".git"), { recursive: true });
  return realpathSync(dir);
}

// A v18 home with its registry ids, the checkout of `nightqueue` and the v18 bytes.
function v18Home(t, name, options = {}) {
  const env = makeHome(t, name);
  const path = checkout(t);
  const ids = buildV18Home(env, { checkout: path, ...options });
  return { env, ids, path, fixture: readFileSync(dbPath(env)) };
}

// Runs a read on a raw read-only connection to a database file.
function readRaw(file, read) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

// The row count of every table the fixture seeds, each read under the name the database gives it.
function counts(db, nameOf = (table) => table, tables = TABLES) {
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${nameOf(table)}`).get().n]));
}

// Runs a read on the copy the v24 step took, the last state that still holds the tracker tables.
function readTrackerCopy(env, read) {
  return readRaw(preVersionBackupPath(env, 24), read);
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

// Every schema object by type and name, the renamed tables' quoted names unquoted so a rebuilt table reads like a created one.
function schemaOf(db) {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map((row) => ({ type: row.type, name: row.name, sql: String(row.sql ?? "").replace(/^CREATE TABLE "(\w+)"/, "CREATE TABLE $1") }));
}

test("a v18 home migrates to v19: row counts kept, items numbered per owner, keys unique, decision numbers unchanged, a pre-v19 copy", (t) => {
  const { env, ids, fixture } = v18Home(t, "v19-migrate");
  const before = readRaw(dbPath(env), (raw) => ({
    counts: counts(raw, preV22Name),
    decisions: raw.prepare("SELECT id, number FROM decisions ORDER BY id").all().map((row) => ({ ...row })),
  }));
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  const tracker = readTrackerCopy(env, (raw) => ({
    counts: counts(raw, undefined, TRACKER_TABLES),
    numbers: raw.prepare("SELECT id, number FROM issues ORDER BY id").all().map((row) => [row.id, row.number]),
    projectRepeats: raw.prepare("SELECT COUNT(*) AS n FROM (SELECT project_id, number FROM issues WHERE scope = 'project' GROUP BY project_id, number HAVING COUNT(*) > 1)").get().n,
    orgRepeats: raw.prepare("SELECT COUNT(*) AS n FROM (SELECT org_id, number FROM issues WHERE scope = 'org' GROUP BY org_id, number HAVING COUNT(*) > 1)").get().n,
    matched: raw.prepare("SELECT rowid FROM issues_fts WHERE issues_fts MATCH 'item'").all().length,
  }));
  assert.deepEqual({ ...counts(db, undefined, KEPT_TABLES), ...tracker.counts }, before.counts, "a table lost or gained rows");

  assert.deepEqual(tracker.numbers, [[1, 1], [2, 1], [3, 1], [5, 2], [6, 2], [7, 2], [8, 3]]);
  assert.equal(tracker.projectRepeats, 0);
  assert.equal(tracker.orgRepeats, 0);

  const keys = Object.fromEntries(db.prepare("SELECT id, key FROM projects UNION ALL SELECT id, key FROM orgs").all().map((row) => [row.id, row.key]));
  assert.deepEqual(
    { nightqueue: keys[ids.projects.nightqueue], api: keys[ids.projects.api], nqWeb: keys[ids.projects["nq-web"]], default: keys[ids.orgs.default], dlweb: keys[ids.orgs.dlweb] },
    { nightqueue: "NQ", api: "AP", nqWeb: "NW", default: "DA", dlweb: "DW" },
  );
  assert.equal(new Set(Object.values(keys)).size, Object.values(keys).length, "a key repeats across projects and orgs");
  assert.deepEqual(db.prepare("SELECT id, number FROM decisions ORDER BY id").all().map((row) => ({ ...row })), before.decisions);

  assert.ok(readFileSync(preV19BackupPath(env)).equals(fixture), "the pre-v19 copy is not the v18 database byte for byte");
  assert.equal(readRaw(preV19BackupPath(env), (raw) => schemaVersionOn(raw)), 18);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(tracker.matched, 7);
});

test("a second open of a migrated home changes nothing and takes no second copy", (t) => {
  const { env } = v18Home(t, "v19-reopen");
  const db = migrateTestHome(env);
  const schema = schemaOf(db);
  const rows = db.prepare("SELECT * FROM jobs ORDER BY id").all().map((row) => ({ ...row }));
  const copied = statSync(preV19BackupPath(env)).mtimeMs;
  closeDb(env);
  const again = migrateTestHome(env);
  assert.deepEqual(schemaOf(again), schema);
  assert.deepEqual(again.prepare("SELECT * FROM jobs ORDER BY id").all().map((row) => ({ ...row })), rows);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
  assert.equal(statSync(preV19BackupPath(env)).mtimeMs, copied, "a second open took another copy");
});

test("a runner holding a live lease refuses the v19 migration with one line, and the database stays at v18", async (t) => {
  const live = (db, { projects }) => {
    db.prepare("INSERT INTO jobs (project_id, prompt, status, worker, lease_until, started_at) VALUES (?, 'p', 'running', 'w', datetime('now', '+1 hour'), datetime('now'))").run(projects.api);
  };
  const { env, fixture } = v18Home(t, "v19-live-lease", { extra: live });
  const refusal = /^the database must migrate to v19, but a runner holds a live lease on J-3: stop the runners \(`nightqueue queue run --stop`\) and run the command again$/;
  assert.throws(() => migrateTestHome(env), (err) => refusal.test(err.message));
  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED");
  assert.equal(diskVersion(env), 18);
  assert.equal(existsSync(preV19BackupPath(env)), false, "a refused migration published a copy");
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
});

test("a migrated database has exactly the schema of a fresh one, table by table and trigger by trigger", (t) => {
  const { env } = v18Home(t, "v19-shape");
  const migrated = schemaOf(migrateTestHome(env));
  const fresh = schemaOf(migrateTestHome(makeHome(t, "v19-fresh")));
  assert.deepEqual(migrated, fresh);
});

test("a v17 home reaches v19 in one open, keeping both the pre-v18 and the pre-v19 copies", (t) => {
  const env = makeHome(t, "v19-from-v17");
  buildLegacyHome(env, {
    seed: (db) => {
      db.prepare("INSERT INTO roadmap_items (scope, project, title, position) VALUES ('project', 'alpha', 'old item', 1)").run();
      db.prepare("INSERT INTO roadmap_items (scope, project, title, position) VALUES ('project', 'alpha', 'next item', 1)").run();
    },
  });
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION);
  assert.equal(readRaw(preV18BackupPath(env), (raw) => schemaVersionOn(raw)), 17);
  assert.equal(readRaw(preV19BackupPath(env), (raw) => schemaVersionOn(raw)), 18);
  assert.deepEqual(readTrackerCopy(env, (raw) => raw.prepare("SELECT number FROM issues ORDER BY id").all().map((row) => row.number)), [1, 2]);
  assert.equal(db.prepare("SELECT key FROM projects WHERE name = 'alpha'").get().key, "AP");
});

// Source of a process that opens the home's database and prints the version and the keys it found.
function openerSource() {
  return [
    `import { migrateTestHome } from ${JSON.stringify(MIGRATE_URL)};`,
    "const startAt = Number(process.argv[2]);",
    "while (Date.now() < startAt) {}",
    "try {",
    "  const db = migrateTestHome(process.env);",
    '  const version = db.prepare("PRAGMA user_version").get().user_version;',
    '  const keys = db.prepare("SELECT key FROM projects ORDER BY rowid").all().map((row) => row.key);',
    '  process.stdout.write(JSON.stringify({ version, keys, error: null }) + "\\n");',
    "} catch (err) {",
    '  process.stdout.write(JSON.stringify({ version: null, keys: null, error: err.message }) + "\\n");',
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

test("two processes opening one v18 home at once end with one migration and the same keys, and no error", async (t) => {
  const { env, fixture } = v18Home(t, "v19-race");
  const script = join(makeDir(t, "v19-race-script"), "opener.mjs");
  writeFileSync(script, openerSource());
  const startAt = Date.now() + 400;
  const results = await Promise.all([spawnOpener(env, script, startAt), spawnOpener(env, script, startAt)]);
  const expected = { version: DB_USER_VERSION, keys: ["NQ", "AP", "NW"], error: null };
  assert.deepEqual(results, [expected, expected]);
  assert.ok(readFileSync(preV19BackupPath(env)).equals(fixture), "the copy is not the v18 database");
});

test("the read-only registry paths answer with the key on a v18 home once it is migrated", (t) => {
  const { env, path } = v18Home(t, "v19-read-only");
  migrateTestHome(env);
  closeDb(env);
  assert.equal(diskVersion(env), DB_USER_VERSION);
  assert.equal(registeredProject("nightqueue", env).key, "NQ");
  assert.equal(projectFromCwd(path, env).key, "NQ");
  assert.equal(projectFromCwd(path, env).org_key, "DW");
});
