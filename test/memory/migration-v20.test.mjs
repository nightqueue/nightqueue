import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dbPath, preV18BackupPath, preV19BackupPath, preV20BackupPath } from "../../src/config/paths.mjs";
import { closeDb, migrateIfOutdated, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { DATA_TABLES } from "../../src/memory/ddl.mjs";
import { MigrationRefused } from "../../src/memory/migration/one-shot.mjs";
import { buildLegacyHome } from "../../test-support/legacy-home.mjs";
import { ensureProject, makeDir, makeHome } from "../../test-support/memory.mjs";
import { buildV18Home } from "../../test-support/v18-home.mjs";
import { buildV19Home, V19_LINKS } from "../../test-support/v19-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

const PATHS_URL = new URL("../../src/config/paths.mjs", import.meta.url).href;
const V20_URL = new URL("../../src/memory/migration/v20.mjs", import.meta.url).href;
const COUNTED_TABLES = [...DATA_TABLES, "pipeline_phases"];
const REBUILT_TABLES = ["decisions", "roadmap_items", "roadmap_item_projects", "roadmap_comments", "pipeline_runs"];
const LINKED_BY_JOB = ["roadmap_items", "roadmap_item_projects", "decisions", "pipeline_runs"];
const LEASE_REFUSAL = /^the database must migrate to v20, but a runner holds a live lease on J-3: stop the runners \(`nightqueue queue run --stop`\) and run the command again$/;

const AUDIT = Object.freeze({
  "roadmap_comments.item_id": "roadmap_items CASCADE",
  "roadmap_item_projects.item_id": "roadmap_items CASCADE",
  "roadmap_item_projects.job_id": "jobs SET NULL",
  "roadmap_items.job_id": "jobs SET NULL",
  "roadmap_items.decision_id": "decisions SET NULL",
  "decisions.job_id": "jobs SET NULL",
  "decisions.superseded_by": "decisions RESTRICT",
  "pipeline_runs.job_id": "jobs SET NULL",
});

// One orphan per converted column: the row it breaks and the raw v19 SQL that plants it.
const ORPHANS = Object.freeze([
  { table: "roadmap_comments", column: "item_id", parent: "roadmap_items", row: 500, plant: (db) => db.exec("INSERT INTO roadmap_comments (id, item_id, kind, author, body) VALUES (500, 999, 'note', 'operator', 'lost')") },
  { table: "roadmap_item_projects", column: "item_id", parent: "roadmap_items", row: 500, plant: (db, { projects }) => db.prepare("INSERT INTO roadmap_item_projects (id, item_id, project_id) VALUES (500, 999, ?)").run(projects.api) },
  { table: "roadmap_item_projects", column: "job_id", parent: "jobs", row: 1, plant: (db) => db.exec("UPDATE roadmap_item_projects SET job_id = 999 WHERE id = 1") },
  { table: "roadmap_items", column: "job_id", parent: "jobs", row: 3, plant: (db) => db.exec("UPDATE roadmap_items SET job_id = 999 WHERE id = 3") },
  { table: "roadmap_items", column: "decision_id", parent: "decisions", row: 3, plant: (db) => db.exec("UPDATE roadmap_items SET decision_id = 999 WHERE id = 3") },
  { table: "decisions", column: "job_id", parent: "jobs", row: 3, plant: (db) => db.exec("UPDATE decisions SET job_id = 999 WHERE id = 3") },
  { table: "decisions", column: "superseded_by", parent: "decisions", row: 3, plant: (db) => db.exec("UPDATE decisions SET superseded_by = 999 WHERE id = 3") },
  { table: "pipeline_runs", column: "job_id", parent: "jobs", row: 1, plant: (db) => db.exec("UPDATE pipeline_runs SET job_id = 999 WHERE id = 1") },
]);

// Values no job id can be, each with how the refusal prints it (L379).
const ADVERSARIAL = Object.freeze([
  { sql: "'abc'", printed: '"abc"' },
  { sql: "0", printed: "0" },
  { sql: "-1", printed: "-1" },
  { sql: "1.5", printed: "1.5" },
  { sql: "x'00'", printed: "x'00'" },
  { sql: "'a' || char(10) || 'b'", printed: '"a\\nb"' },
]);

// A v19 home with its registry ids and the v19 bytes.
function v19Home(t, name, options = {}) {
  const env = makeHome(t, name);
  const ids = buildV19Home(env, options);
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
  const db = openDbReadOnly(env);
  try {
    return schemaVersionOn(db);
  } finally {
    db.close();
  }
}

// The row count of every data table and of the run phases.
function counts(db) {
  return Object.fromEntries(COUNTED_TABLES.map((table) => [table, db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
}

// Every row of a table as plain objects, in id order.
function rowsOf(db, table) {
  return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((row) => ({ ...row }));
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

// The temporary copies a migration left in the home.
function leftoverTmps(env) {
  return readdirSync(dirname(dbPath(env))).filter((name) => /\.pre-v20\..*\.tmp$/.test(name));
}

// The error an open throws, asserting it is a one-line refusal.
function refusalOf(env) {
  let caught = null;
  try {
    openDb(env);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof MigrationRefused, `expected a MigrationRefused, got ${caught?.stack ?? caught}`);
  assert.equal(caught.message.split("\n").length, 1, `the refusal is not one line: ${caught.message}`);
  return caught.message;
}

// Asserts a refused v20 migration wrote nothing: same bytes, still v19, no copy and no temporary file.
function assertNothingWritten(env, fixture) {
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused migration wrote to the database");
  assert.equal(diskVersion(env), 19);
  assert.equal(existsSync(preV20BackupPath(env)), false, "a refused migration published a pre-v20 copy");
  assert.deepEqual(leftoverTmps(env), [], "a refused migration left a temporary copy");
}

test("a v19 home migrates to v20: every row and counter kept, every reference enforced, the mirrors reindexed, a pre-v20 copy", (t) => {
  const { env, fixture } = v19Home(t, "v20-migrate");
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 20);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);

  assert.ok(readFileSync(preV20BackupPath(env)).equals(fixture), "the pre-v20 copy is not the v19 database byte for byte");
  const before = readRaw(preV20BackupPath(env), (raw) => ({
    version: schemaVersionOn(raw),
    counts: counts(raw),
    rows: Object.fromEntries(REBUILT_TABLES.map((table) => [table, rowsOf(raw, table)])),
  }));
  assert.equal(before.version, 19);
  assert.deepEqual(counts(db), before.counts, "a table lost or gained rows");
  for (const table of REBUILT_TABLES) assert.deepEqual(rowsOf(db, table), before.rows[table], `${table} changed a row`);

  for (const [name, rule] of Object.entries(AUDIT)) {
    const [table, column] = name.split(".");
    assert.equal(foreignKeyOf(db, table, column), rule, `${name} carries the wrong foreign key`);
  }

  assert.deepEqual(matches(db, "decisions_fts", "global"), [4]);
  assert.deepEqual(matches(db, "roadmap_items_fts", '"item 5"'), [5]);
  assert.deepEqual(matches(db, "roadmap_comments_fts", V19_LINKS.commentWord), [3]);
});

test("the counters of the rebuilt tables survive: a deleted highest row is never reused", (t) => {
  const { env, ids } = v19Home(t, "v20-counters");
  const db = openDb(env);
  const decision = db.prepare("INSERT INTO decisions (scope, project_id, number, title, context, decision) VALUES ('project', ?, 10, 'new', 'c', 'd')").run(ids.projects.api);
  const item = db.prepare("INSERT INTO roadmap_items (scope, project_id, number, title, position) VALUES ('project', ?, 50, 'new item', 1)").run(ids.projects.api);
  const run = db.prepare("INSERT INTO pipeline_runs (project_id, slug, tier, outcome) VALUES (?, 'new-run', 'M', 'done')").run(ids.projects.api);
  const comment = db.prepare("INSERT INTO roadmap_comments (item_id, kind, author, body) VALUES (1, 'note', 'operator', 'new')").run();
  assert.deepEqual(
    [decision, item, run, comment].map((result) => Number(result.lastInsertRowid)),
    [6, 10, 3, 5],
  );
});

test("a second open of a v20 home changes nothing and takes no second copy", (t) => {
  const { env } = v19Home(t, "v20-reopen");
  const db = openDb(env);
  const rows = rowsOf(db, "roadmap_items");
  const copied = statSync(preV20BackupPath(env)).mtimeMs;
  closeDb(env);
  const again = openDb(env);
  assert.deepEqual(rowsOf(again, "roadmap_items"), rows);
  assert.equal(again.prepare("SELECT total_changes() AS n").get().n, 0, "a second open wrote to the database");
  assert.equal(statSync(preV20BackupPath(env)).mtimeMs, copied, "a second open took another copy");
});

for (const orphan of ORPHANS) {
  test(`an orphan in ${orphan.table}.${orphan.column} refuses the v20 migration naming its row, and nothing is written`, async (t) => {
    const { env, fixture } = v19Home(t, `v20-orphan-${orphan.table}-${orphan.column}`, { extra: orphan.plant });
    const message = refusalOf(env);
    assert.ok(message.startsWith("the database must migrate to v20, but 1 row(s) point at a row that does not exist: "), message);
    assert.ok(message.includes(`\`${orphan.table}\` row ${orphan.row} has ${orphan.column} 999 (no \`${orphan.parent}\` row 999)`), message);
    assert.ok(message.includes(dbPath(env)), message);
    assert.ok(message.endsWith("nothing was written"), message);
    await assert.rejects(async () => migrateIfOutdated(env), (err) => err.message === message);
    assertNothingWritten(env, fixture);
  });
}

test("25 orphans: the refusal names the first 20 and counts the other 5", (t) => {
  const plant = (db) => {
    const comment = db.prepare("INSERT INTO roadmap_comments (id, item_id, kind, author, body) VALUES (?, 999, 'note', 'operator', 'lost')");
    for (let id = 500; id < 525; id += 1) comment.run(id);
  };
  const { env, fixture } = v19Home(t, "v20-orphans-25", { extra: plant });
  const message = refusalOf(env);
  assert.ok(message.includes("25 row(s) point at a row that does not exist"), message);
  assert.equal(message.match(/`roadmap_comments` row \d+ has item_id 999/g).length, 20);
  assert.ok(message.includes("`roadmap_comments` row 519 has item_id 999"), message);
  assert.ok(!message.includes("row 520 "), message);
  assert.ok(message.includes("; and 5 more; fix or clear them"), message);
  assertNothingWritten(env, fixture);
});

test("a reference holding a value no row id can be is refused as an orphan naming its row, never another error", (t) => {
  for (const { sql, printed } of ADVERSARIAL) {
    const plant = (db) => db.exec(`UPDATE roadmap_items SET job_id = ${sql} WHERE id = 3`);
    const { env, fixture } = v19Home(t, `v20-adversarial-${ADVERSARIAL.findIndex((entry) => entry.sql === sql)}`, { extra: plant });
    const message = refusalOf(env);
    assert.ok(message.includes(`\`roadmap_items\` row 3 has job_id ${printed} (no \`jobs\` row ${printed})`), `${sql}: ${message}`);
    assertNothingWritten(env, fixture);
  }
});

test("a runner holding a live lease refuses the v20 migration with one line and publishes no copy", async (t) => {
  const live = (db, { projects }) => {
    db.prepare("INSERT INTO jobs (project_id, prompt, status, worker, lease_until, started_at) VALUES (?, 'p', 'running', 'w', datetime('now', '+1 hour'), datetime('now'))").run(projects.api);
  };
  const { env, fixture } = v19Home(t, "v20-live-lease", { extra: live });
  assert.match(refusalOf(env), LEASE_REFUSAL);
  await assert.rejects(async () => migrateIfOutdated(env), (err) => LEASE_REFUSAL.test(err.message));
  assertNothingWritten(env, fixture);
});

test("an expired lease of a crashed runner does not block the v20 migration", (t) => {
  const expired = (db, { projects }) => {
    db.prepare("INSERT INTO jobs (project_id, prompt, status, worker, lease_until, started_at) VALUES (?, 'p', 'running', 'w', datetime('now', '-1 hour'), datetime('now', '-2 hours'))").run(projects.api);
  };
  const { env } = v19Home(t, "v20-expired-lease", { extra: expired });
  assert.equal(openDb(env).prepare("PRAGMA user_version").get().user_version, 20);
  assert.ok(existsSync(preV20BackupPath(env)));
});

test("a v17 home reaches v20 in one open, keeping the pre-v18, pre-v19 and pre-v20 copies", (t) => {
  const env = makeHome(t, "v20-from-v17");
  buildLegacyHome(env, {
    seed: (db) => db.prepare("INSERT INTO roadmap_items (scope, project, title, position) VALUES ('project', 'alpha', 'old item', 1)").run(),
  });
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 20);
  assert.equal(readRaw(preV18BackupPath(env), (raw) => schemaVersionOn(raw)), 17);
  assert.equal(readRaw(preV19BackupPath(env), (raw) => schemaVersionOn(raw)), 18);
  assert.equal(readRaw(preV20BackupPath(env), (raw) => schemaVersionOn(raw)), 19);
  assert.deepEqual(db.prepare("SELECT title FROM roadmap_items").all().map((row) => row.title), ["old item"]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

test("a v18 home reaches v20 in one open, keeping the pre-v19 and pre-v20 copies", (t) => {
  const env = makeHome(t, "v20-from-v18");
  buildV18Home(env);
  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 20);
  assert.equal(readRaw(preV19BackupPath(env), (raw) => schemaVersionOn(raw)), 18);
  assert.equal(readRaw(preV20BackupPath(env), (raw) => schemaVersionOn(raw)), 19);
  assert.equal(foreignKeyOf(db, "roadmap_items", "job_id"), "jobs SET NULL");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});

// Asserts an older home refused for an orphan before its first step: same bytes, same version, no copy of a pending step.
function assertOlderHomeUntouched(env, { fixture, version }) {
  assert.ok(readFileSync(dbPath(env)).equals(fixture), "a refused chain wrote to the database");
  assert.equal(diskVersion(env), version);
  const pending = [[17, preV18BackupPath(env)], [18, preV19BackupPath(env)], [19, preV20BackupPath(env)]].filter(([from]) => from >= version);
  for (const [, copy] of pending) assert.equal(existsSync(copy), false, `a refused chain published ${copy}`);
}

test("a v18 home with an orphan is refused before its v19 step, and nothing is written", (t) => {
  const env = makeHome(t, "v20-orphan-from-v18");
  buildV18Home(env, { extra: (db) => db.exec("UPDATE decisions SET job_id = 999 WHERE id = 1") });
  const fixture = readFileSync(dbPath(env));
  const message = refusalOf(env);
  assert.ok(message.includes("`decisions` row 1 has job_id 999 (no `jobs` row 999)"), message);
  assert.ok(message.endsWith("nothing was written"), message);
  assertOlderHomeUntouched(env, { fixture, version: 18 });
});

test("a v17 home with an orphan is refused before its v18 step, and nothing is written", (t) => {
  const env = makeHome(t, "v20-orphan-from-v17");
  buildLegacyHome(env, {
    seed: (db) => db.prepare("INSERT INTO roadmap_items (id, scope, project, title, position, job_id) VALUES (7, 'project', 'alpha', 'old item', 1, 999)").run(),
  });
  const fixture = readFileSync(dbPath(env));
  const message = refusalOf(env);
  assert.ok(message.includes("`roadmap_items` row 7 has job_id 999 (no `jobs` row 999)"), message);
  assert.ok(message.endsWith("nothing was written"), message);
  assertOlderHomeUntouched(env, { fixture, version: 17 });
});

test("a v19 column the v20 shape lacks refuses the migration naming it, and its data stays", (t) => {
  const plant = (db) => db.exec("ALTER TABLE decisions ADD COLUMN operator_note TEXT; UPDATE decisions SET operator_note = 'keep me' WHERE id = 1");
  const { env } = v19Home(t, "v20-extra-column", { extra: plant });
  assert.throws(() => openDb(env), /the v20 shape has no decisions\.operator_note, so its data would be lost/);
  assert.equal(diskVersion(env), 19);
  const note = readRaw(dbPath(env), (raw) => raw.prepare("SELECT operator_note AS v FROM decisions WHERE id = 1").get().v);
  assert.equal(note, "keep me");
});

// Seeds, on a fresh v20 home, the same links the v19 fixture carries, and names them the same way.
function seedFreshLinks(env) {
  const projectId = ensureProject(env, "alpha");
  const db = openDb(env);
  const orgId = db.prepare("SELECT org_id FROM projects WHERE id = ?").get(projectId).org_id;
  const insert = (sql, ...params) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const job = insert("INSERT INTO jobs (project_id, prompt) VALUES (?, 'linked job')", projectId);
  insert("INSERT INTO jobs (project_id, prompt) VALUES (?, 'other job')", projectId);
  const decision = "INSERT INTO decisions (scope, project_id, number, title, context, decision, job_id) VALUES ('project', ?, ?, ?, 'c', 'd', ?)";
  const superseded = insert(decision, projectId, 1, "superseded", null);
  const supersededTarget = insert(decision, projectId, 2, "successor", null);
  const linkedDecision = insert(decision, projectId, 3, "linked", job);
  db.prepare("UPDATE decisions SET status = 'superseded', superseded_by = ? WHERE id = ?").run(supersededTarget, superseded);
  const orgItem = insert("INSERT INTO roadmap_items (scope, org_id, number, title, position) VALUES ('org', ?, 1, 'org item', 1)", orgId);
  const otherItem = insert("INSERT INTO roadmap_items (scope, project_id, number, title, position, job_id) VALUES ('project', ?, 1, 'job item', 1, ?)", projectId, job);
  insert("INSERT INTO roadmap_items (scope, project_id, number, title, position, decision_id) VALUES ('project', ?, 2, 'decided item', 2, ?)", projectId, linkedDecision);
  insert("INSERT INTO roadmap_item_projects (item_id, project_id, job_id) VALUES (?, ?, ?)", orgItem, projectId, job);
  insert("INSERT INTO roadmap_comments (item_id, kind, author, body) VALUES (?, 'note', 'operator', 'a zebra crossed the org item')", orgItem);
  insert("INSERT INTO roadmap_comments (item_id, kind, author, body) VALUES (?, 'note', 'operator', 'a giraffe on the job item')", otherItem);
  const run = insert("INSERT INTO pipeline_runs (project_id, slug, tier, outcome, job_id) VALUES (?, 'run-linked', 'M', 'done', ?)", projectId, job);
  insert("INSERT INTO pipeline_phases (run_id, seq, phase) VALUES (?, 1, 'triage')", run);
  insert("INSERT INTO pipeline_phases (run_id, seq, phase) VALUES (?, 2, 'plan')", run);
  return { job, orgItem, otherItem, supersededTarget, linkedDecision, run, commentWord: "zebra" };
}

// The ids of the rows of a table whose column points at the given row.
function idsLinking(db, table, column, id) {
  return db.prepare(`SELECT id FROM ${table} WHERE ${column} = ? ORDER BY id`).all(id).map((row) => row.id);
}

// Deleting a job keeps every row that named it and clears the link.
function assertJobDeleteSetsNull(db, { job }) {
  const linked = Object.fromEntries(LINKED_BY_JOB.map((table) => [table, idsLinking(db, table, "job_id", job)]));
  for (const table of LINKED_BY_JOB) assert.ok(linked[table].length > 0, `the fixture links no ${table} row to the job`);
  db.prepare("DELETE FROM jobs WHERE id = ?").run(job);
  for (const table of LINKED_BY_JOB) {
    const after = db.prepare(`SELECT id, job_id FROM ${table} WHERE id IN (${linked[table].join(", ")}) ORDER BY id`).all();
    assert.deepEqual(after.map((row) => [row.id, row.job_id]), linked[table].map((id) => [id, null]), `${table} did not keep its rows with job_id NULL`);
  }
}

// A successor cannot be deleted; a decision an item only links can, and the item forgets it.
function assertDecisionDeleteRules(db, { supersededTarget, linkedDecision }) {
  assert.throws(() => db.prepare("DELETE FROM decisions WHERE id = ?").run(supersededTarget), /FOREIGN KEY constraint failed/);
  const items = idsLinking(db, "roadmap_items", "decision_id", linkedDecision);
  assert.ok(items.length > 0, "the fixture links no item to the decision");
  db.prepare("DELETE FROM decisions WHERE id = ?").run(linkedDecision);
  const after = db.prepare(`SELECT decision_id FROM roadmap_items WHERE id IN (${items.join(", ")})`).all();
  assert.deepEqual(after.map((row) => row.decision_id), items.map(() => null));
}

// Deleting a run takes its phases with it.
function assertRunDeleteCascades(db, { run }) {
  assert.ok(idsLinking(db, "pipeline_phases", "run_id", run).length > 0, "the fixture gives the run no phase");
  db.prepare("DELETE FROM pipeline_runs WHERE id = ?").run(run);
  assert.deepEqual(idsLinking(db, "pipeline_phases", "run_id", run), []);
}

// A comment is never edited nor deleted on its own; deleting its item takes the thread, the per-project rows and the index entries.
function assertItemDeleteCascades(db, { orgItem, otherItem, commentWord }) {
  assert.throws(() => db.prepare("DELETE FROM roadmap_comments WHERE item_id = ?").run(otherItem), /roadmap comments are append-only/);
  assert.throws(() => db.prepare("UPDATE roadmap_comments SET body = 'edited' WHERE item_id = ?").run(otherItem), /roadmap comments are append-only/);
  const otherComments = idsLinking(db, "roadmap_comments", "item_id", otherItem);
  assert.ok(idsLinking(db, "roadmap_comments", "item_id", orgItem).length > 0, "the fixture gives the org item no comment");
  assert.ok(idsLinking(db, "roadmap_item_projects", "item_id", orgItem).length > 0, "the fixture gives the org item no project row");
  assert.ok(matches(db, "roadmap_comments_fts", commentWord).length > 0, "the comment word is not indexed");
  db.prepare("DELETE FROM roadmap_items WHERE id = ?").run(orgItem);
  assert.deepEqual(idsLinking(db, "roadmap_comments", "item_id", orgItem), []);
  assert.deepEqual(idsLinking(db, "roadmap_item_projects", "item_id", orgItem), []);
  assert.deepEqual(idsLinking(db, "roadmap_comments", "item_id", otherItem), otherComments);
  assert.deepEqual(matches(db, "roadmap_comments_fts", commentWord), [], "the index still finds a deleted comment");
}

// Every delete rule of the v20 references, on an open v20 database.
function assertReferentialActions(db, links) {
  assertJobDeleteSetsNull(db, links);
  assertDecisionDeleteRules(db, links);
  assertRunDeleteCascades(db, links);
  assertItemDeleteCascades(db, links);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

test("on a migrated home, every reference follows its delete rule", (t) => {
  const { env } = v19Home(t, "v20-actions-migrated");
  assertReferentialActions(openDb(env), V19_LINKS);
});

test("on a fresh home, every reference follows its delete rule", (t) => {
  const env = makeHome(t, "v20-actions-fresh");
  const links = seedFreshLinks(env);
  assertReferentialActions(openDb(env), links);
});

// Source of a process that runs the v20 migration on a raw connection and kills itself right after it rebuilt a table.
function crashingMigratorSource() {
  return [
    'import { DatabaseSync } from "node:sqlite";',
    `import { dbPath } from ${JSON.stringify(PATHS_URL)};`,
    `import { migrateToV20 } from ${JSON.stringify(V20_URL)};`,
    "const [, , table] = process.argv;",
    "const db = new DatabaseSync(dbPath(process.env));",
    'db.exec("PRAGMA busy_timeout = 5000");',
    'migrateToV20(db, process.env, { afterTable: (name) => name === table && process.kill(process.pid, "SIGKILL") });',
    'process.stdout.write("survived\\n");',
    "",
  ].join("\n");
}

// Runs the crashing migrator as a real child process and answers how it ended.
function crashMigration(t, env, table) {
  const script = join(makeDir(t, "v20-crash-script"), "migrator.mjs");
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

test("a v20 migration killed right after it rebuilt roadmap_items leaves v19 intact, and the next open migrates it", async (t) => {
  const { env } = v19Home(t, "v20-kill-mid");
  const before = readRaw(dbPath(env), (raw) => Object.fromEntries(REBUILT_TABLES.map((table) => [table, rowsOf(raw, table)])));
  const crashed = await crashMigration(t, env, "roadmap_items");
  assert.equal(crashed.signal, "SIGKILL", `the migrator was not killed: ${crashed.stdout}`);

  const raw = new DatabaseSync(dbPath(env));
  const state = {
    version: raw.prepare("PRAGMA user_version").get().user_version,
    tables: raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
    itemKey: foreignKeyOf(raw, "roadmap_items", "job_id"),
    decisionKey: foreignKeyOf(raw, "decisions", "superseded_by"),
    guard: raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'roadmap_comments_no_delete'").get()?.sql ?? null,
    rows: Object.fromEntries(REBUILT_TABLES.map((table) => [table, rowsOf(raw, table)])),
  };
  raw.close();
  assert.equal(state.version, 19);
  assert.equal(state.tables.some((name) => name.endsWith("_v20")), false, `a half-built table survived: ${state.tables.join(", ")}`);
  assert.equal(state.itemKey, null, "the killed rebuild of roadmap_items survived");
  assert.equal(state.decisionKey, null, "the killed rebuild of decisions survived");
  assert.ok(state.guard && !state.guard.includes("WHEN EXISTS"), `the v19 comment guard was not restored: ${state.guard}`);
  assert.deepEqual(state.rows, before);

  const db = openDb(env);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 20);
  for (const table of REBUILT_TABLES) assert.deepEqual(rowsOf(db, table), before[table], `${table} changed a row`);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
