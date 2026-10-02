import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { dbPath, preV20BackupPath } from "../../src/config/paths.mjs";
import { closeDb, DB_USER_VERSION, openDb } from "../../src/memory/db.mjs";
import { buildLegacyHome } from "../../test-support/legacy-home.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { buildV19Home } from "../../test-support/v19-home.mjs";

const MIGRATE_URL = new URL("../../test-support/migrate.mjs", import.meta.url).href;
const BARRIER_MS = 300;
const ITERATIONS = 12;
const RACERS = 6;
const DROPPED_COLUMNS = ["merged_at", "merge_sha"];

// An old v9 database: still carries the merge columns v10 drops, and the pr_checked_at column migrate() has always dropped, so the racers all drop columns.
const SEED_AT_V9_WITH_DROPPED_COLUMNS = `
ALTER TABLE jobs ADD COLUMN merged_at TEXT;
ALTER TABLE jobs ADD COLUMN merge_sha TEXT;
ALTER TABLE jobs ADD COLUMN pr_checked_at TEXT;
PRAGMA user_version = 9;
`;

// Source of a racer process: opens the SAME v9 database from a real separate OS process, at a shared instant.
function racerSource() {
  return [
    `import { migrateTestHome } from ${JSON.stringify(MIGRATE_URL)};`,
    "",
    "async function main() {",
    "  const startAt = Number(process.argv[2]);",
    "  while (Date.now() < startAt) {",
    "    // busy-wait: keeps every racer inside the SAME migration window instead of drifting on setTimeout granularity",
    "  }",
    "  const db = migrateTestHome(process.env);",
    '  const version = db.prepare("PRAGMA user_version").get().user_version;',
    '  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);',
    '  const statuses = db.prepare("SELECT status FROM jobs ORDER BY id").all().map((row) => row.status);',
    '  process.stdout.write(JSON.stringify({ error: null, version, columns, statuses }) + "\\n");',
    "}",
    "",
    "main().catch((err) => {",
    '  process.stdout.write(JSON.stringify({ error: err?.message ?? String(err), version: null, columns: null, statuses: null }) + "\\n");',
    "});",
    "",
  ].join("\n");
}

// Runs one racer as a real child process, so the migrations really cross inside SQLite and not inside one heap.
function spawnRacer(env, workerPath, startAt) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", workerPath, String(startAt)], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout: stdout.trim(), stderr }));
  });
}

// Fires every racer at the exact same shared instant.
function raceOnce(env, workerPath, count) {
  const startAt = Date.now() + BARRIER_MS;
  return Promise.all(Array.from({ length: count }, () => spawnRacer(env, workerPath, startAt)));
}

test(`${RACERS} processes racing to migrate the SAME v9 database converge on the current schema, ${ITERATIONS} times over`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nightqueue-db-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerPath = join(dir, "racer.mjs");
  writeFileSync(workerPath, racerSource());

  for (let pass = 0; pass < ITERATIONS; pass += 1) {
    const env = makeHome(t, `db-race-${pass}`);
    buildLegacyHome(env, {
      version: 9,
      mutate(seed) {
        seed
          .prepare("INSERT INTO jobs (project, prompt, status, pr_url) VALUES (?, ?, 'done', ?)")
          .run("alpha", "fix the worker", "https://github.com/acme/api/pull/42");
        seed
          .prepare("INSERT INTO jobs (project, prompt, status, pr_url) VALUES (?, ?, 'merged', ?)")
          .run("alpha", "deliver the api", "https://github.com/acme/api/pull/43");
        seed.exec(SEED_AT_V9_WITH_DROPPED_COLUMNS);
        assert.equal(seed.prepare("PRAGMA user_version").get().user_version, 9, `pass ${pass}: seed did not reach v9`);
      },
    });

    const results = await raceOnce(env, workerPath, RACERS);

    for (const [idx, result] of results.entries()) {
      assert.equal(result.code, 0, `pass ${pass} racer ${idx} exited ${result.code}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.error, null, `pass ${pass} racer ${idx} threw an unhandled error: ${parsed.error}`);
      assert.equal(
        parsed.version,
        DB_USER_VERSION,
        `pass ${pass} racer ${idx} ended at user_version ${parsed.version}, not ${DB_USER_VERSION}`,
      );
      for (const name of DROPPED_COLUMNS) {
        assert.equal(parsed.columns.includes(name), false, `pass ${pass} racer ${idx} still sees ${name}`);
      }
      assert.equal(parsed.columns.includes("pr_checked_at"), false, `pass ${pass} racer ${idx} still sees pr_checked_at`);
      assert.deepEqual(parsed.statuses, ["done", "closed"], `pass ${pass} racer ${idx} read statuses ${parsed.statuses}`);
    }

    const after = openDb(env);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, DB_USER_VERSION, `pass ${pass}: final user_version`);
    const columns = after.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
    for (const name of DROPPED_COLUMNS) {
      assert.equal(columns.includes(name), false, `pass ${pass}: ${name} survived: ${columns.join(", ")}`);
    }
    assert.equal(columns.includes("pr_checked_at"), false, `pass ${pass}: pr_checked_at survived: ${columns.join(", ")}`);
    const rows = after.prepare("SELECT * FROM jobs ORDER BY id").all();
    assert.equal(rows[0].pr_url, "https://github.com/acme/api/pull/42", `pass ${pass}: pre-existing row lost or altered`);
    assert.equal(rows[0].status, "done", `pass ${pass}: pre-existing row status lost or altered`);
    assert.equal(rows[1].pr_url, "https://github.com/acme/api/pull/43", `pass ${pass}: merged row lost its pull request`);
    assert.equal(rows[1].status, "closed", `pass ${pass}: merged row was not closed`);
    closeDb(env);
  }
});

test("two processes opening one v19 home at once end with one v20 migration and the v19 bytes in the copy", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nightqueue-db-race-v20-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerPath = join(dir, "racer.mjs");
  writeFileSync(workerPath, racerSource());

  for (let pass = 0; pass < 3; pass += 1) {
    const env = makeHome(t, `db-race-v20-${pass}`);
    buildV19Home(env);
    const fixture = readFileSync(dbPath(env));
    const results = await raceOnce(env, workerPath, 2);
    for (const [idx, result] of results.entries()) {
      assert.equal(result.code, 0, `pass ${pass} racer ${idx} exited ${result.code}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.error, null, `pass ${pass} racer ${idx} threw: ${parsed.error}`);
      assert.equal(parsed.version, DB_USER_VERSION, `pass ${pass} racer ${idx} ended at v${parsed.version}`);
      assert.deepEqual(parsed.statuses, ["done", "failed"], `pass ${pass} racer ${idx} read statuses ${parsed.statuses}`);
    }
    assert.ok(readFileSync(preV20BackupPath(env)).equals(fixture), `pass ${pass}: the copy is not the v19 database`);
    assert.deepEqual(readdirSync(dirname(dbPath(env))).filter((name) => name.endsWith(".tmp")), [], `pass ${pass}: a temporary copy was left`);
    assert.deepEqual(openDb(env).prepare("PRAGMA foreign_key_check").all(), [], `pass ${pass}: a foreign key broke`);
    closeDb(env);
  }
});
