import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { closeDb, openDb, openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { followDriftedJobs, getRoadmapItemDetail, saveRoadmapItem } from "../../src/memory/roadmap.mjs";
import { openStore, openStoreReadOnly, withReadOnlyStore } from "../../src/store/open.mjs";
import { makeHostEnv } from "../../test-support/host.mjs";
import { makeDir, makeHome, makeOrg, makeProject, seedClosedJob, seedLegacyV16Roadmap } from "../../test-support/memory.mjs";

const DB_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;

// The INDEXES string of the v16 build, verbatim: an older process still running re-executes it on every open.
const V16_INDEXES = `
CREATE INDEX IF NOT EXISTS lessons_recall_idx ON lessons(archived, project, created_at);
CREATE INDEX IF NOT EXISTS lessons_embedding_idx ON lessons(embedding_model);
CREATE INDEX IF NOT EXISTS memory_project_idx ON memory(project, created_at);
CREATE INDEX IF NOT EXISTS project_index_project_idx ON project_index(project, updated_at);
CREATE INDEX IF NOT EXISTS pipeline_runs_project_idx ON pipeline_runs(project, created_at);
CREATE INDEX IF NOT EXISTS pipeline_phases_run_idx ON pipeline_phases(run_id, seq);
CREATE INDEX IF NOT EXISTS jobs_claim_idx ON jobs(status, priority, created_at);
CREATE INDEX IF NOT EXISTS jobs_project_slug_idx ON jobs(project, slug);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_number_idx ON decisions(project, number);
CREATE INDEX IF NOT EXISTS roadmap_items_order_idx ON roadmap_items(project, horizon, position);
CREATE INDEX IF NOT EXISTS roadmap_items_job_idx ON roadmap_items(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_org_number_idx ON decisions(org, number) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS roadmap_items_org_order_idx ON roadmap_items(org, horizon, position) WHERE scope = 'org';
CREATE INDEX IF NOT EXISTS decisions_job_idx ON decisions(job_id) WHERE job_id IS NOT NULL;
`;

const JOBS = [
  { id: 1, project: "alpha", status: "pending" },
  { id: 2, project: "alpha", status: "failed" },
  { id: 3, project: "nightqueue", status: "running" },
];

// Every legacy status x horizon for a project, org rows, and the nightqueue items #9 and #36 the migration bumps.
const ITEMS = [
  { id: 1, project: "alpha", horizon: "now", status: "open", position: 1 },
  { id: 2, project: "alpha", horizon: "next", status: "open", position: 1 },
  { id: 3, project: "alpha", horizon: "later", status: "open", position: 1 },
  { id: 4, project: "alpha", horizon: "now", status: "queued", position: 2, job_id: 1 },
  { id: 5, project: "alpha", horizon: "next", status: "queued", position: 2, job_id: 2 },
  { id: 6, project: "alpha", horizon: "later", status: "done", position: 2 },
  { id: 7, project: "alpha", horizon: "now", status: "dropped", position: 3 },
  { id: 8, org: "acme", horizon: "next", status: "open", position: 1 },
  { id: 9, project: "nightqueue", horizon: "later", status: "open", position: 1 },
  { id: 10, project: "nightqueue", horizon: "now", status: "open", position: 1 },
  { id: 12, org: "acme", horizon: "now", status: "done", position: 1 },
  { id: 36, project: "nightqueue", horizon: "now", status: "queued", position: 2, job_id: 3 },
];

const EXPECTED = {
  1: { status: "todo", priority: 5, position: 1, job_status_seen: null, closed: false },
  4: { status: "in_progress", priority: 5, position: 2, job_status_seen: "pending", closed: false },
  7: { status: "cancelled", priority: 5, position: 3, job_status_seen: null, closed: false },
  2: { status: "backlog", priority: 5, position: 4, job_status_seen: null, closed: false },
  5: { status: "in_progress", priority: 5, position: 5, job_status_seen: null, closed: false },
  3: { status: "backlog", priority: 5, position: 6, job_status_seen: null, closed: false },
  6: { status: "done", priority: 5, position: 7, job_status_seen: null, closed: true },
  12: { status: "done", priority: 5, position: 1, job_status_seen: null, closed: true },
  8: { status: "backlog", priority: 5, position: 2, job_status_seen: null, closed: false },
  10: { status: "todo", priority: 5, position: 1, job_status_seen: null, closed: false },
  36: { status: "in_progress", priority: 3, position: 1, job_status_seen: "running", closed: false },
  9: { status: "backlog", priority: 3, position: 2, job_status_seen: null, closed: false },
};

// A legacy v16 home with the seeded matrix, its projects and org registered.
function legacyHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  makeProject(t, env, "nightqueue");
  makeOrg(env, "acme");
  seedLegacyV16Roadmap(env, { items: ITEMS, jobs: JOBS });
  return env;
}

// The migrated rows keyed by id, with only the columns the migration decides.
function migratedRows(db) {
  const rows = db.prepare("SELECT id, status, priority, position, job_status_seen, closed_at, updated_at FROM roadmap_items").all();
  return Object.fromEntries(
    rows.map((row) => [
      row.id,
      {
        status: row.status,
        priority: row.priority,
        position: row.position,
        job_status_seen: row.job_status_seen,
        closed: row.closed_at !== null,
      },
    ]),
  );
}

// The columns an index covers, in order.
function indexColumns(db, name) {
  return db.prepare(`PRAGMA index_info(${name})`).all().map((column) => column.name);
}

test("the v17 migration maps every legacy status and horizon, bumps nightqueue #9 and #36, and drops the horizon", (t) => {
  const env = legacyHome(t, "roadmap-v17-map");
  const db = openDb(env);

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 17);
  const columns = db.prepare("PRAGMA table_info(roadmap_items)").all().map((column) => column.name);
  assert.equal(columns.includes("horizon"), false);
  for (const column of ["priority", "job_status_seen", "closed_at"]) assert.ok(columns.includes(column), column);
  assert.deepEqual(migratedRows(db), Object.fromEntries(Object.entries(EXPECTED).map(([id, row]) => [id, row])));
  const done = db.prepare("SELECT closed_at, updated_at FROM roadmap_items WHERE id = 6").get();
  assert.equal(done.closed_at, done.updated_at);
  assert.deepEqual(indexColumns(db, "roadmap_items_order_idx"), ["scope", "project", "org", "priority", "position"]);
  assert.deepEqual(indexColumns(db, "roadmap_items_org_order_idx"), ["org", "priority", "position"]);
  assert.deepEqual(indexColumns(db, "roadmap_items_job_idx"), ["job_id"]);
});

test("a reopen of the migrated database changes nothing, and the v16 INDEXES still execute against it", (t) => {
  const env = legacyHome(t, "roadmap-v17-reopen");
  const before = migratedRows(openDb(env));
  closeDb(env);
  const reopened = openDb(env);
  assert.deepEqual(migratedRows(reopened), before);
  assert.doesNotThrow(() => reopened.exec(V16_INDEXES));
  assert.deepEqual(indexColumns(reopened, "roadmap_items_order_idx"), ["scope", "project", "org", "priority", "position"]);
});

test("the migration keeps the id counter, so a new item never reuses the id of a deleted one", (t) => {
  const env = makeHome(t, "roadmap-v17-sequence");
  makeProject(t, env, "alpha");
  seedLegacyV16Roadmap(env, { items: [{ id: 1, project: "alpha", horizon: "now", status: "open", position: 1 }], sequence: 40 });

  const saved = saveRoadmapItem({ type: "improvement", project: "alpha", title: "new" }, env);
  assert.equal(saved.id, 41);
});

test("an item #9 of another project keeps the default priority", (t) => {
  const env = makeHome(t, "roadmap-v17-other-9");
  makeProject(t, env, "alpha");
  seedLegacyV16Roadmap(env, {
    items: [
      { id: 9, project: "alpha", horizon: "now", status: "open", position: 1 },
      { id: 36, project: "alpha", horizon: "now", status: "open", position: 2 },
    ],
  });
  const rows = openDb(env).prepare("SELECT id, priority FROM roadmap_items ORDER BY id").all();
  assert.deepEqual(rows.map((row) => ({ id: row.id, priority: row.priority })), [
    { id: 9, priority: 5 },
    { id: 36, priority: 5 },
  ]);
});

test("a legacy queued item whose job already failed is re-synced to todo by the first follow of the drift", (t) => {
  const env = legacyHome(t, "roadmap-v17-drift");
  const db = openDb(env);
  assert.equal(db.prepare("SELECT status FROM roadmap_items WHERE id = 5").get().status, "in_progress");
  assert.ok(followDriftedJobs(env) >= 1);
  const row = db.prepare("SELECT status, job_status_seen FROM roadmap_items WHERE id = 5").get();
  assert.deepEqual({ ...row }, { status: "todo", job_status_seen: "failed" });
  assert.equal(db.prepare("SELECT status FROM roadmap_items WHERE id = 4").get().status, "in_progress");
  assert.equal(followDriftedJobs(env), 0);
});

// Source of a child process that opens the database and reports what it found.
function openerSource() {
  return [
    `import { openDb } from ${JSON.stringify(DB_URL)};`,
    "const db = openDb(process.env);",
    'const version = db.prepare("PRAGMA user_version").get().user_version;',
    'const horizon = db.prepare("PRAGMA table_info(roadmap_items)").all().some((c) => c.name === "horizon");',
    'const total = db.prepare("SELECT COUNT(*) AS n FROM roadmap_items").get().n;',
    'process.stdout.write(JSON.stringify({ version, horizon, total }) + "\\n");',
    "",
  ].join("\n");
}

// Runs one opener as a real child process, so the two rebuild attempts really cross inside SQLite.
function spawnOpener(env, path) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

test("two processes opening the same legacy database both succeed and the rows are rebuilt once", async (t) => {
  const env = legacyHome(t, "roadmap-v17-race");
  const path = join(makeDir(t, "roadmap-v17-opener"), "opener.mjs");
  writeFileSync(path, openerSource());
  const results = await Promise.all([spawnOpener(env, path), spawnOpener(env, path)]);
  for (const result of results) {
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { version: 17, horizon: false, total: ITEMS.length });
  }
  assert.deepEqual(migratedRows(openDb(env)), EXPECTED);
});

// Schema version of the home's database on disk, read without migrating it.
function diskVersion(env) {
  const db = openDbReadOnly(env);
  try {
    return schemaVersionOn(db);
  } finally {
    db.close();
  }
}

// Runs `nightqueue doctor --json` in process, with `gh` answered by a double, and answers the parsed report.
async function doctorReport(env) {
  const out = [];
  const fakeGh = () => ({ status: 0, stdout: "Logged in", stderr: "" });
  await run(["doctor", "--json"], { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, spawnSyncImpl: fakeGh });
  assert.equal(out.length, 1, out.join("\n"));
  return JSON.parse(out[0]);
}

test("a v16 home is diagnosed read-only without a crash, then migrated for a read-only reader that lists the rebuilt rows", async (t) => {
  const host = makeHostEnv(t, "roadmap-v17-read-only");
  const { env } = host;
  makeProject(t, env, "alpha");
  seedLegacyV16Roadmap(env, { items: [{ id: 1, project: "alpha", horizon: "now", status: "open", position: 1, title: "legacy item" }] });

  const report = await doctorReport(env);
  const database = report.checks.find((check) => check.name === "database");
  assert.equal(database.status, "warn");
  assert.match(database.detail, /schema v16, expected v17/);
  assert.equal(report.checks.some((check) => check.name === "roadmap workflow"), false);
  assert.equal(diskVersion(env), 16);

  await openStoreReadOnly(env).migrateIfOutdated();
  const listed = await withReadOnlyStore(env, (store) => store.roadmap.listRoadmap("alpha", {}));
  assert.deepEqual(
    listed.items.map((item) => ({ id: item.id, status: item.status, priority: item.priority })),
    [{ id: 1, status: "todo", priority: 5 }],
  );
  assert.equal(diskVersion(env), 17);
});

test("a legacy queued item whose job was closed (merged) needs no roadmap step: the sweep closes it with the merge sha", async (t) => {
  const env = makeHome(t, "roadmap-v17-closed-job");
  makeProject(t, env, "alpha");
  const jobId = seedClosedJob(env);
  seedLegacyV16Roadmap(env, { items: [{ id: 1, project: "alpha", horizon: "now", status: "queued", position: 1, job_id: jobId }] });

  const migrated = openDb(env).prepare("SELECT status, job_status_seen FROM roadmap_items WHERE id = 1").get();
  assert.deepEqual({ ...migrated }, { status: "in_progress", job_status_seen: null });

  await openStore(env).jobs.sweepOrphans();
  const item = getRoadmapItemDetail(1, {}, env);
  assert.equal(item.status, "done");
  assert.ok(item.closed_at, "closed_at is set");
  const closed = item.comments.filter((comment) => comment.kind === "closed");
  assert.equal(closed.length, 1);
  assert.equal(closed[0].refs.sha, "abc1234def567890");
});
