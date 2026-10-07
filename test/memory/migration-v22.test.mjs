import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbPath, preV18BackupPath, preV19BackupPath, preV20BackupPath, preV22BackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { MigrationRefused } from "../../src/memory/migration/one-shot.mjs";
import { migrateV21Columns } from "../../src/memory/migration/v21.mjs";
import { openStoreReadOnly } from "../../src/store/open.mjs";
import { buildLegacyHome } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";
import { buildV19Home } from "../../test-support/v19-home.mjs";
import { buildV20Home, V20_LINKS } from "../../test-support/v20-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const PATHS_URL = new URL("../../src/config/paths.mjs", import.meta.url).href;
const V22_URL = new URL("../../src/memory/migration/v22.mjs", import.meta.url).href;
const OLD_WORD = ["road", "map"].join("");
const RENAMED = Object.freeze([
  { from: `${OLD_WORD}_items`, to: "issues" },
  { from: `${OLD_WORD}_item_projects`, to: "issue_projects" },
  { from: `${OLD_WORD}_comments`, to: "issue_comments" },
]);
const V21_VALUES = Object.freeze({
  origin: JSON.stringify({ kind: "tracker", ref: "7" }),
  integrations: JSON.stringify({ tracker: { onClosed: "resolved" } }),
});
const UNTOUCHED = ["decisions", "jobs", "pipeline_runs", "pipeline_phases", "lessons", "memory", "projects", "orgs"];
const OUTDATED_V20 = /database at v20, this nightqueue expects v23: run `nightqueue update`/;
const OUTDATED_V21 = /database at v21, this nightqueue expects v23: run `nightqueue update`/;
const LEASE_REFUSAL = /^the database must migrate to v22, but a runner holds a live lease on J-3: stop the runners \(`nightqueue queue run --stop`\) and run the command again$/;

const AUDIT = Object.freeze({
  "issue_comments.item_id": "issues CASCADE",
  "issue_projects.item_id": "issues CASCADE",
  "issue_projects.job_id": "jobs SET NULL",
  "issue_projects.project_id": "projects RESTRICT",
  "issues.decision_id": "decisions SET NULL",
  "issues.job_id": "jobs SET NULL",
  "issues.org_id": "orgs RESTRICT",
  "issues.project_id": "projects RESTRICT",
});

// A v20 home with its registry ids and the v20 bytes.
function v20Home(t, name, options = {}) {
  const env = makeHome(t, name);
  const ids = buildV20Home(env, options);
  return { env, ids, fixture: readFileSync(dbPath(env)) };
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

// The schema version of the database on disk, read without migrating it.
function diskVersion(env) {
  const db = openDbReadOnly(env, { anySchema: true });
  try {
    return schemaVersionOn(db);
  } finally {
    db.close();
  }
}

// Every row of a table as plain objects, in id order.
function rowsOf(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }));
}

// The AUTOINCREMENT counter of a table, 0 when it has none.
function counterOf(db, table) {
  return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table)?.seq ?? 0;
}

// The rowids a full-text mirror matches for a query.
function matches(db, mirror, query) {
  return db.prepare(`SELECT rowid FROM ${mirror} WHERE ${mirror} MATCH ? ORDER BY rowid`).all(query).map((row) => row.rowid);
}

// The foreign key a column carries, as `parent RULE`, or null.
function foreignKeyOf(db, table, column) {
  const key = db.prepare(`PRAGMA foreign_key_list(${table})`).all().find((fk) => fk.from === column);
  return key ? `${key.table} ${key.on_delete}` : null;
}

// Every schema object by type and name, the renamed tables' quoted names unquoted so a rebuilt table reads like a created one.
function schemaOf(db) {
  return db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .all()
    .map((row) => ({ type: row.type, name: row.name, sql: String(row.sql ?? "").replace(/^CREATE TABLE "(\w+)"/, "CREATE TABLE $1") }));
}

// The schema objects outside the removed tracker, which a fresh home no longer creates and the steps before v24 still build.
function outsideTracker(schema) {
  return schema.filter((row) => !row.name.startsWith("issue"));
}

// The names in the schema and in the counters that still carry the old word.
function oldNames(db) {
  const pattern = `%${OLD_WORD}%`;
  return [
    ...db.prepare("SELECT name FROM sqlite_master WHERE name LIKE ? OR tbl_name LIKE ?").all(pattern, pattern),
    ...db.prepare("SELECT name FROM sqlite_sequence WHERE name LIKE ?").all(pattern),
  ].map((row) => row.name);
}

// The temporary copies a migration left in the home.
function leftoverTmps(env) {
  return readdirSync(dirname(dbPath(env))).filter((name) => /\.pre-v22\..*\.tmp$/.test(name));
}

// The error the migration throws, asserting it is a one-line refusal.
function refusalOf(env) {
  let caught = null;
  try {
    migrateTestHome(env);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MigrationRefused, `expected a MigrationRefused, got ${caught?.stack ?? caught}`);
  assert.equal(caught.message.split("\n").length, 1, `the refusal is not one line: ${caught.message}`);
  return caught.message;
}

// Asserts a refused v22 migration wrote nothing: same bytes, still v20, no copy and no temporary file.
function assertNothingWritten(env, fixture) {
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.equal(diskVersion(env), 20);
  assert.equal(existsSync(preV22BackupPath(env)), false, "a refused migration published a pre-v22 copy");
  assert.deepEqual(leftoverTmps(env), [], "a refused migration left a temporary copy");
}

// A row without the v21 columns, the shape a v20 row had.
function withoutV21Columns({ origin: _origin, integrations: _integrations, ...row }) {
  return withoutV23Columns(row);
}

// A row without the v23 columns every open adds after the v22 migration.
function withoutV23Columns({ attempt_started_at: _attemptStartedAt, next_attempt_fresh: _nextAttemptFresh, ...row }) {
  return { ...row };
}

// Turns a v20 database into the v21 shape a J-114 build leaves: both v21 columns, filled on one job and one project, stamped 21.
function stampV21(db, { projects }) {
  migrateV21Columns(db);
  db.prepare("UPDATE jobs SET origin = ? WHERE id = 1").run(V21_VALUES.origin);
  db.prepare("UPDATE projects SET integrations = ? WHERE id = ?").run(V21_VALUES.integrations, projects.api);
  db.exec("PRAGMA user_version = 21");
}

// A v21 home with its registry ids and the v21 bytes.
function v21Home(t, name) {
  const env = makeHome(t, name);
  const ids = buildV20Home(env, { extra: stampV21 });
  return { env, ids, fixture: readFileSync(dbPath(env)) };
}

// The rows and counters of the old tables and the untouched ones, read from a v20 or v21 database.
function v20Snapshot(raw) {
  return {
    version: schemaVersionOn(raw),
    rows: Object.fromEntries(RENAMED.map(({ from, to }) => [to, rowsOf(raw, from)])),
    counters: Object.fromEntries(RENAMED.map(({ from, to }) => [to, counterOf(raw, from)])),
    untouched: Object.fromEntries(UNTOUCHED.map((table) => [table, raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  };
}

test("a v20 home migrates to v22: every row and counter kept under the new names, a pre-v22 copy byte for byte", (t) => {
  const { env, fixture } = v20Home(t, "v22-migrate");
  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED");
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused open wrote to the database");
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  assert.equal(DB_USER_VERSION, 23);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

  assert.ok(readFileSync(preV22BackupPath(env)).equals(fixture), "the pre-v22 copy is not the v20 database byte for byte");
  const before = readRaw(preV22BackupPath(env), v20Snapshot);
  assert.equal(before.version, 20);
  for (const { to } of RENAMED) {
    assert.ok(before.rows[to].length > 0, `the fixture seeds no ${to} row`);
    assert.deepEqual(rowsOf(db, to), before.rows[to], `${to} changed a row`);
    assert.ok(before.counters[to] > Math.max(...before.rows[to].map((row) => row.id)), `the fixture deleted no highest ${to} row`);
    assert.equal(counterOf(db, to), before.counters[to], `${to} lost its counter`);
  }
  for (const table of UNTOUCHED) {
    const after = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(withoutV21Columns);
    assert.deepEqual(after, before.untouched[table].map(withoutV21Columns), `${table} changed`);
  }
});

test("a v21 home migrates in place to v22: the tracker renamed, jobs.origin and projects.integrations kept with their values", (t) => {
  const { env, ids, fixture } = v21Home(t, "v22-from-v21");
  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED");
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused open wrote to the database");
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(oldNames(db), []);

  assert.ok(readFileSync(preV22BackupPath(env)).equals(fixture), "the pre-v22 copy is not the v21 database byte for byte");
  const before = readRaw(preV22BackupPath(env), v20Snapshot);
  assert.equal(before.version, 21);
  for (const { to } of RENAMED) {
    assert.ok(before.rows[to].length > 0, `the fixture seeds no ${to} row`);
    assert.deepEqual(rowsOf(db, to), before.rows[to], `${to} changed a row`);
    assert.equal(counterOf(db, to), before.counters[to], `${to} lost its counter`);
  }
  for (const table of UNTOUCHED) {
    const after = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(withoutV23Columns);
    assert.deepEqual(after, before.untouched[table].map(withoutV23Columns), `${table} changed`);
  }
  assert.equal(db.prepare("SELECT origin FROM jobs WHERE id = 1").get().origin, V21_VALUES.origin);
  assert.equal(db.prepare("SELECT integrations FROM projects WHERE id = ?").get(ids.projects.api).integrations, V21_VALUES.integrations);
});

test("doctor reads a v21 home as pending, every command refuses it, and once the migration ran, doctor reads schema v22", (t) => {
  const env = makeHome(t, "v22-doctor-v21");
  const cwd = join(makeDir(t, "v22-doctor-v21-checkout"), "nightqueue");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  buildV20Home(env, { checkout: realpathSync(cwd), extra: stampV21 });

  assert.match(runCli(env, ["doctor"], cwd).stdout, /warn\s+database\s+schema v21, this nightqueue expects v23/);
  const status = runCli(env, ["queue", "status"], cwd);
  assert.equal(status.status, 1, status.stdout);
  assert.match(status.stderr, OUTDATED_V21);
  assert.equal(diskVersion(env), 21);
  migrateTestHome(env);
  closeDb(env);
  assert.equal(diskVersion(env), 23);
  assert.equal(runCli(env, ["queue", "status"], cwd).status, 0);
  assert.match(runCli(env, ["doctor"], cwd).stdout, /ok\s+database\s+schema v23/);
});

test("the migrated tables keep every foreign key rule, and their counters never reuse a deleted id", (t) => {
  const { env, ids } = v20Home(t, "v22-keys");
  const db = migrateTestHome(env);
  for (const [name, rule] of Object.entries(AUDIT)) {
    const [table, column] = name.split(".");
    assert.equal(foreignKeyOf(db, table, column), rule, `${name} carries the wrong foreign key`);
  }
  const counters = Object.fromEntries(RENAMED.map(({ to }) => [to, counterOf(db, to)]));
  const item = db.prepare("INSERT INTO issues (scope, project_id, number, title, position) VALUES ('project', ?, 77, 'new item', 1)").run(ids.projects.api);
  const itemId = Number(item.lastInsertRowid);
  const row = db.prepare("INSERT INTO issue_projects (item_id, project_id) VALUES (?, ?)").run(itemId, ids.projects.api);
  const comment = db.prepare("INSERT INTO issue_comments (item_id, kind, author, body) VALUES (?, 'note', 'operator', 'new')").run(itemId);
  assert.deepEqual(
    [item, row, comment].map((result) => Number(result.lastInsertRowid)),
    [counters.issues + 1, counters.issue_projects + 1, counters.issue_comments + 1],
  );
});

test("the issue mirrors find the seeded words, and a comment is never edited nor deleted on its own", (t) => {
  const { env } = v20Home(t, "v22-mirrors");
  const db = migrateTestHome(env);
  assert.deepEqual(matches(db, "issues_fts", '"item 5"'), [5]);
  assert.deepEqual(matches(db, "issue_comments_fts", V20_LINKS.commentWord), [3]);
  assert.deepEqual(matches(db, "issue_comments_fts", "scratch"), [], "the index finds a deleted comment");
  assert.throws(() => db.prepare("UPDATE issue_comments SET body = 'edited' WHERE id = 3").run(), /issue comments are append-only/);
  assert.throws(() => db.prepare("DELETE FROM issue_comments WHERE id = 3").run(), /issue comments are append-only/);
  db.prepare("UPDATE issues SET title = 'renamed zebra title' WHERE id = 5").run();
  assert.deepEqual(matches(db, "issues_fts", "renamed"), [5]);
});

test("no schema object nor counter carries the old name, and the schema is exactly that of a fresh home", (t) => {
  const { env } = v20Home(t, "v22-shape");
  const migrated = migrateTestHome(env);
  assert.deepEqual(oldNames(migrated), []);
  const fresh = openDb(makeHome(t, "v22-fresh"));
  assert.deepEqual(outsideTracker(schemaOf(migrated)), schemaOf(fresh));
});

test("a second open of a migrated v22 home changes nothing, and a second migration takes no second copy", (t) => {
  const { env } = v20Home(t, "v22-reopen");
  const db = migrateTestHome(env);
  const schema = schemaOf(db);
  const rows = rowsOf(db, "issues");
  const copied = statSync(preV22BackupPath(env)).mtimeMs;
  closeDb(env);
  const reopened = openDb(env);
  assert.deepEqual(schemaOf(reopened), schema);
  assert.equal(reopened.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
  closeDb(env);
  const again = migrateTestHome(env);
  assert.deepEqual(schemaOf(again), schema);
  assert.deepEqual(rowsOf(again, "issues"), rows);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second migration wrote to the database");
  assert.equal(statSync(preV22BackupPath(env)).mtimeMs, copied, "a second migration took another copy");
});

test("a runner holding a live lease refuses the v22 migration with one line and publishes no copy", async (t) => {
  const live = (db, { projects }) => {
    db.prepare("INSERT INTO jobs (project_id, prompt, status, worker, lease_until, started_at) VALUES (?, 'p', 'running', 'w', datetime('now', '+1 hour'), datetime('now'))").run(projects.api);
  };
  const { env, fixture } = v20Home(t, "v22-live-lease", { extra: live });
  assert.match(refusalOf(env), LEASE_REFUSAL);
  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED");
  assertNothingWritten(env, fixture);
});

test("an orphan in a v20 home refuses the v22 migration naming its row, and doctor counts the same rows", async (t) => {
  const plant = (db) => db.exec(`INSERT INTO ${OLD_WORD}_comments (id, item_id, kind, author, body) VALUES (500, 999, 'note', 'operator', 'lost')`);
  const { env, fixture } = v20Home(t, "v22-orphan", { extra: plant });
  const store = openStoreReadOnly(env);
  let health = null;
  try {
    health = await store.health();
  } finally {
    await store.close();
  }
  const message = refusalOf(env);
  assert.ok(message.startsWith("the database must migrate to v23, but 1 row(s) point at a row that does not exist: "), message);
  assert.ok(message.includes(`\`${OLD_WORD}_comments\` row 500 has item_id 999 (no \`${OLD_WORD}_items\` row 999)`), message);
  assert.ok(message.endsWith("nothing was written"), message);
  assert.equal(health.danglingReferences, 1, "doctor does not count the row the migration refuses");
  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED");
  assertNothingWritten(env, fixture);
});

test("a v19 home reaches v22 in one migration, keeping the pre-v20 and pre-v22 copies", (t) => {
  const env = makeHome(t, "v22-from-v19");
  buildV19Home(env);
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  assert.equal(readRaw(preV20BackupPath(env), (raw) => schemaVersionOn(raw)), 19);
  assert.equal(readRaw(preV22BackupPath(env), (raw) => schemaVersionOn(raw)), 20);
  assert.equal(foreignKeyOf(db, "issues", "job_id"), "jobs SET NULL");
  assert.deepEqual(oldNames(db), []);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a v17 home reaches v22 in one migration, keeping every copy on the way", (t) => {
  const env = makeHome(t, "v22-from-v17");
  buildLegacyHome(env, {
    seed: (db) => db.prepare(`INSERT INTO ${OLD_WORD}_items (scope, project, title, position) VALUES ('project', 'alpha', 'old item', 1)`).run(),
  });
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  assert.equal(readRaw(preV18BackupPath(env), (raw) => schemaVersionOn(raw)), 17);
  assert.equal(readRaw(preV19BackupPath(env), (raw) => schemaVersionOn(raw)), 18);
  assert.equal(readRaw(preV20BackupPath(env), (raw) => schemaVersionOn(raw)), 19);
  assert.equal(readRaw(preV22BackupPath(env), (raw) => schemaVersionOn(raw)), 20);
  assert.deepEqual(db.prepare("SELECT title FROM issues").all().map((row) => row.title), ["old item"]);
  assert.deepEqual(matches(db, "issues_fts", "old"), [1]);
  assert.deepEqual(oldNames(db), []);
});

// Source of a process that runs the v22 migration on a raw connection and kills itself right after it built a table.
function crashingMigratorSource() {
  return [
    'import { DatabaseSync } from "node:sqlite";',
    `import { dbPath } from ${JSON.stringify(PATHS_URL)};`,
    `import { migrateToV22 } from ${JSON.stringify(V22_URL)};`,
    "const [, , table] = process.argv;",
    "const db = new DatabaseSync(dbPath(process.env));",
    'db.exec("PRAGMA busy_timeout = 5000");',
    'migrateToV22(db, process.env, { afterTable: (name) => name === table && process.kill(process.pid, "SIGKILL") });',
    'process.stdout.write("survived\\n");',
    "",
  ].join("\n");
}

// Runs the crashing migrator as a real child process and answers how it ended.
function crashMigration(t, env, table) {
  const script = join(makeDir(t, "v22-crash-script"), "migrator.mjs");
  writeFileSync(script, crashingMigratorSource());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", script, table], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout }));
  });
}

test("a v22 migration killed right after it built issues leaves v20 intact, and the next migration takes it", async (t) => {
  const { env } = v20Home(t, "v22-kill-mid");
  const before = readRaw(dbPath(env), v20Snapshot);
  const crashed = await crashMigration(t, env, "issues");
  assert.equal(crashed.signal, "SIGKILL", `the migrator was not killed: ${crashed.stdout}`);

  const after = readRaw(dbPath(env), (raw) => ({
    snapshot: v20Snapshot(raw),
    tables: raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
  }));
  assert.equal(after.snapshot.version, 20);
  assert.equal(after.tables.includes("issues"), false, `the killed copy survived: ${after.tables.join(", ")}`);
  assert.ok(after.tables.includes(`${OLD_WORD}_items_fts`), "the killed drop of the old mirror survived");
  assert.deepEqual(after.snapshot, before);

  assert.throws(() => openDb(env), (err) => err.code === "SCHEMA_OUTDATED");
  const db = migrateTestHome(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 23);
  for (const { to } of RENAMED) assert.deepEqual(rowsOf(db, to), before.rows[to], `${to} changed a row`);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

test("doctor reads a v20 home as pending, every command refuses it, and once the migration ran, the database as ok", (t) => {
  const env = makeHome(t, "v22-doctor");
  const cwd = join(makeDir(t, "v22-doctor-checkout"), "nightqueue");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  buildV20Home(env, { checkout: realpathSync(cwd) });

  assert.match(runCli(env, ["doctor"], cwd).stdout, /warn\s+database\s+schema v20, this nightqueue expects v23/);
  const status = runCli(env, ["queue", "status"], cwd);
  assert.equal(status.status, 1, status.stdout);
  assert.match(status.stderr, OUTDATED_V20);
  assert.equal(diskVersion(env), 20);
  migrateTestHome(env);
  closeDb(env);
  assert.equal(diskVersion(env), 23);
  assert.equal(runCli(env, ["queue", "status"], cwd).status, 0);
  const report = runCli(env, ["doctor"], cwd).stdout;
  assert.match(report, /ok\s+database\s+schema v23/);
  assert.equal(report.includes("issue workflow"), false, report);
});
