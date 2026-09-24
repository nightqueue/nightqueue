import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { closeDb, DB_USER_VERSION, openDb } from "../../src/memory/db.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const DB_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;
const PR = (n) => `https://github.com/acme/api/pull/${n}`;
const SHIPPED_LINE = "Shipped: PR #1 merged as abc1234 on 2026-09-20";
const OTHER_LINE = "Shipped: PR #10 merged as abc1234 on 2026-09-20";
const QUOTED_LINE = "Shipped: PR #9 merged as fff0000 on 2026-01-01";
const LEGACY_COLUMNS = ["ship_status", "ship", "ship_worker", "ship_lease_until"];

// Turns a fresh home back into the v15 shape: the close columns gone and the ship columns of that build back.
const DOWNGRADE_TO_V15 = `
ALTER TABLE jobs DROP COLUMN close_worker;
ALTER TABLE jobs DROP COLUMN close_status;
ALTER TABLE jobs DROP COLUMN close;
ALTER TABLE jobs DROP COLUMN close_lease_until;
ALTER TABLE jobs ADD COLUMN ship_status TEXT CHECK(ship_status IN ('shipping','shipped','failed'));
ALTER TABLE jobs ADD COLUMN ship TEXT;
ALTER TABLE jobs ADD COLUMN ship_worker TEXT;
ALTER TABLE jobs ADD COLUMN ship_lease_until TEXT;
PRAGMA user_version = 15;
`;

// The rows a v15 build could have left, one per migration branch, keyed by the name each assertion reads them by.
const V15_ROWS = {
  shipped: {
    status: "closed",
    pr_url: PR(1),
    notice_md: `Did it.\n\n${SHIPPED_LINE}`,
    ship_status: "shipped",
    ship: JSON.stringify({ attempts: 1, steps: { merge: { status: "done" } }, data: { merged: true, mergeSha: "abc1234def", noticeLine: SHIPPED_LINE } }),
  },
  closedNoChecklist: { status: "closed", pr_url: PR(2), finished_at: "2026-09-01 10:00:00" },
  closedNoPr: { status: "closed", operator_note: "tidied up by hand" },
  shipping: {
    status: "done",
    pr_url: PR(4),
    ship_status: "shipping",
    ship_worker: "ship:host:1:aaaa",
    ship_lease_until: "2999-01-01 00:00:00",
    ship: JSON.stringify({ attempts: 1, steps: {}, data: {} }),
  },
  shipFailed: {
    status: "done",
    pr_url: PR(5),
    ship_status: "failed",
    ship: JSON.stringify({ attempts: 1, steps: {}, data: {}, failed: { step: "merge", reason: "merge-without-sha" } }),
  },
  job65: {
    status: "closed",
    pr_url: PR(74),
    finished_at: "2026-09-22 18:00:00",
    ship_status: "failed",
    ship: JSON.stringify({
      attempts: 2,
      steps: { preflight: { status: "failed", note: "checks-red - failing: test" } },
      data: { prNumber: 74 },
      failed: { step: "preflight", reason: "checks-red" },
    }),
  },
  mergedWithPr: { status: "merged", pr_url: PR(7) },
  mergedNoPr: { status: "merged", operator_note: "legacy" },
  notJson: { status: "closed", pr_url: PR(9), ship: "not json" },
  emptyPr: { status: "closed", pr_url: "" },
  leftoverWorker: { status: "closed", pr_url: PR(11), ship_worker: "ship:host:1:leftover" },
  quotedLine: {
    status: "closed",
    pr_url: PR(10),
    notice_md: `Did it.\n\n${QUOTED_LINE}`,
    ship_status: "shipped",
    ship: JSON.stringify({ attempts: 1, steps: {}, data: { merged: true, mergeSha: "abc1234def", noticeLine: OTHER_LINE } }),
  },
};

// Inserts one v15 row by raw SQL and answers its id.
function insertRow(db, row) {
  const columns = ["project", "prompt", ...Object.keys(row)];
  const values = ["alpha", "a job", ...Object.values(row)];
  const sql = `INSERT INTO jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  return Number(db.prepare(sql).run(...values).lastInsertRowid);
}

// Writes a v15 home holding every row of V15_ROWS, closes it, and answers the id of each row by its name.
function seedV15Home(env) {
  const db = openDb(env);
  db.exec(DOWNGRADE_TO_V15);
  const ids = Object.fromEntries(Object.entries(V15_ROWS).map(([name, row]) => [name, insertRow(db, row)]));
  closeDb(env);
  return ids;
}

// Every job row, every column, oldest first: the snapshot a no-op open must leave byte-identical.
function allRows(db) {
  return db.prepare("SELECT * FROM jobs ORDER BY id").all().map((row) => ({ ...row }));
}

// The close checklist of a row, parsed.
function closeOf(db, id) {
  return JSON.parse(db.prepare("SELECT close FROM jobs WHERE id = ?").get(id).close);
}

// A row by id.
function rowOf(db, id) {
  return { ...db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) };
}

// Source of a child process that opens the home, then reports the changes its own open wrote and every row it reads.
function openerSource() {
  return [
    `import { openDb } from ${JSON.stringify(DB_URL)};`,
    "const startAt = Number(process.argv[2] ?? 0);",
    "while (Date.now() < startAt) {}",
    "try {",
    "  const db = openDb(process.env);",
    '  const changes = db.prepare("SELECT total_changes() AS n").get().n;',
    '  const rows = db.prepare("SELECT * FROM jobs ORDER BY id").all().map((row) => ({ ...row }));',
    '  const version = db.prepare("PRAGMA user_version").get().user_version;',
    '  process.stdout.write(JSON.stringify({ error: null, changes, rows, version }));',
    "} catch (err) {",
    '  process.stdout.write(JSON.stringify({ error: err?.message ?? String(err) }));',
    "}",
  ].join("\n");
}

// Runs one opener as a real separate process and answers what it reported.
function runOpener(env, path, startAt = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path, String(startAt)], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr, ...JSON.parse(stdout || '{"error":"no output"}') }));
  });
}

// Writes the opener script into a directory of the test and answers its path.
function openerPath(t) {
  const path = join(makeDir(t, "close-migration-opener"), "opener.mjs");
  writeFileSync(path, openerSource());
  return path;
}

test("a v15 home opens at v17 with the close columns, no ship column, and the closed invariant in the schema", (t) => {
  const env = makeHome(t, "close-migration-schema");
  seedV15Home(env);
  const db = openDb(env);

  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 17);
  assert.equal(DB_USER_VERSION, 17);
  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((column) => column.name);
  for (const column of ["close_status", "close", "close_lease_until", "close_worker"]) assert.ok(columns.includes(column), `${column} is missing`);
  for (const column of LEGACY_COLUMNS) assert.equal(columns.includes(column), false, `${column} survived the migration`);
  const fresh = makeHome(t, "close-migration-schema-fresh");
  for (const home of [db, openDb(fresh)]) {
    const sql = home.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get().sql;
    assert.match(sql, /close_worker TEXT CHECK \(status <> 'closed' OR \(pr_url IS NOT NULL AND trim\(pr_url\) <> '' AND close_status IS NULL/);
    assert.match(sql, /json_extract\(close, '\$\.data\.merged'\) END\) IS 1/);
  }
});

test("every v15 row lands on its migration branch, lossless, and every closed row satisfies the invariant", (t) => {
  const env = makeHome(t, "close-migration-rows");
  const ids = seedV15Home(env);
  const db = openDb(env);

  const shipped = rowOf(db, ids.shipped);
  assert.deepEqual([shipped.status, shipped.close_status, shipped.close_lease_until], ["closed", null, null]);
  assert.equal(closeOf(db, ids.shipped).data.mergeSha, "abc1234def");
  assert.equal(closeOf(db, ids.shipped).migrated, undefined, "a recorded merge got a synthetic record");
  assert.equal(shipped.notice_md, "Did it.\n\nClosed: PR #1 merged as abc1234 on 2026-09-20");
  assert.equal(closeOf(db, ids.shipped).data.noticeLine, SHIPPED_LINE, "the checklist's own notice line is history and stays");

  const synthetic = closeOf(db, ids.closedNoChecklist);
  assert.equal(rowOf(db, ids.closedNoChecklist).status, "closed");
  assert.deepEqual(synthetic.steps.merge, { status: "skipped", note: "merged outside a close", at: "2026-09-01T10:00:00Z" });
  assert.deepEqual(synthetic.data, { merged: true, mergedBy: "operator" });
  assert.deepEqual(synthetic.migrated, { from: null, previous: null });

  for (const [name, note] of [["closedNoPr", "tidied up by hand"], ["mergedNoPr", "legacy"], ["emptyPr", null]]) {
    const row = rowOf(db, ids[name]);
    assert.equal(row.status, "cancelled", name);
    assert.equal(row.operator_note, "migrated: closed without a pull request", name);
    assert.ok(row.finished_at, `${name}: no finished_at`);
    const result = JSON.parse(row.result);
    assert.equal(result.cancelledFrom, V15_ROWS[name].status, name);
    assert.equal(result.migratedOperatorNote, note, name);
  }

  const shipping = rowOf(db, ids.shipping);
  assert.deepEqual(
    [shipping.status, shipping.close_status, shipping.close_worker, shipping.close_lease_until],
    ["done", "closing", "ship:host:1:aaaa", "2999-01-01 00:00:00"],
  );
  const shipFailed = rowOf(db, ids.shipFailed);
  assert.deepEqual([shipFailed.status, shipFailed.close_status], ["done", "failed"]);
  assert.deepEqual(closeOf(db, ids.shipFailed).failed, { step: "merge", reason: "merge-without-sha" });
  const leftover = rowOf(db, ids.leftoverWorker);
  assert.deepEqual([leftover.status, leftover.close_status, leftover.close_worker], ["closed", null, null], "a finalized row kept a legacy worker");

  const job65 = closeOf(db, ids.job65);
  assert.equal(rowOf(db, ids.job65).status, "closed");
  assert.equal(rowOf(db, ids.job65).close_status, null);
  assert.equal(job65.steps.preflight.status, "failed", "job 65 lost its failed preflight");
  assert.deepEqual(job65.failed, { step: "preflight", reason: "checks-red" });
  assert.equal(job65.attempts, 2);
  assert.equal(job65.data.prNumber, 74);
  assert.deepEqual(job65.steps.merge, { status: "skipped", note: "merged outside a close", at: "2026-09-22T18:00:00Z" });
  assert.equal(job65.data.merged, true);
  assert.equal(job65.data.mergedBy, "operator");
  assert.deepEqual(job65.migrated, { from: "failed", previous: null });

  assert.equal(rowOf(db, ids.mergedWithPr).status, "closed");
  assert.equal(closeOf(db, ids.mergedWithPr).data.mergedBy, "operator");

  const notJson = closeOf(db, ids.notJson);
  assert.equal(notJson.data.merged, true);
  assert.equal(notJson.migrated.previous, "not json", "an unreadable checklist was dropped instead of kept");

  assert.equal(rowOf(db, ids.quotedLine).notice_md, `Did it.\n\n${QUOTED_LINE}`, "a notice line the close did not append was rewritten");

  const violating = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE status = 'closed' AND NOT (pr_url IS NOT NULL AND close_status IS NULL
         AND (CASE WHEN json_valid(close) THEN json_extract(close, '$.data.merged') END) IS 1)`,
    )
    .get().n;
  assert.equal(violating, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'merged'").get().n, 0);
});

test("the invariant refuses a closed row with no recorded merge once the home is migrated", (t) => {
  const env = makeHome(t, "close-migration-check");
  const ids = seedV15Home(env);
  const db = openDb(env);
  assert.throws(() => db.prepare("UPDATE jobs SET status = 'closed' WHERE id = ?").run(ids.shipFailed), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE jobs SET close = NULL WHERE id = ?").run(ids.shipped), /CHECK constraint failed/);
  assert.throws(() => db.prepare("UPDATE jobs SET close_status = 'closing' WHERE id = ?").run(ids.shipped), /CHECK constraint failed/);
});

test("a second open in a fresh process writes nothing and reads the rows byte-identical", async (t) => {
  const env = makeHome(t, "close-migration-noop");
  seedV15Home(env);
  const before = allRows(openDb(env));
  closeDb(env);

  const reopened = await runOpener(env, openerPath(t));

  assert.equal(reopened.code, 0, reopened.stderr);
  assert.equal(reopened.error, null);
  assert.equal(reopened.changes, 0, "an already migrated home was written on open");
  assert.deepEqual(reopened.rows, before);
});

test("two processes migrating the same v15 file both succeed and agree on every row", async (t) => {
  const env = makeHome(t, "close-migration-race");
  seedV15Home(env);
  const path = openerPath(t);
  const startAt = Date.now() + 300;

  const [first, second] = await Promise.all([runOpener(env, path, startAt), runOpener(env, path, startAt)]);

  for (const racer of [first, second]) {
    assert.equal(racer.code, 0, racer.stderr);
    assert.equal(racer.error, null);
    assert.equal(racer.version, DB_USER_VERSION);
  }
  assert.deepEqual(first.rows, second.rows);
  assert.deepEqual(allRows(openDb(env)), first.rows);
});
