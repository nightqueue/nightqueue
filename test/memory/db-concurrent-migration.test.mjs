import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const DB_URL = new URL("../../src/memory/db.mjs", import.meta.url).href;
const BARRIER_MS = 300;
const ITERATIONS = 12;
const RACERS = 6;
const MERGE_COLUMNS = ["merged_at", "merge_sha", "pr_checked_at"];

// Everything a database written before the merge sweep does NOT have yet (mirrors db.test.mjs's DOWNGRADE_TO_V3).
const DOWNGRADE_TO_V3 = `
ALTER TABLE jobs DROP COLUMN merged_at;
ALTER TABLE jobs DROP COLUMN merge_sha;
ALTER TABLE jobs DROP COLUMN pr_checked_at;
PRAGMA user_version = 3;
`;

// Source of a racer process: opens the SAME v3 database from a real separate OS process, at a shared instant.
function racerSource() {
  return [
    `import { openDb } from ${JSON.stringify(DB_URL)};`,
    "",
    "async function main() {",
    "  const startAt = Number(process.argv[2]);",
    "  while (Date.now() < startAt) {",
    "    // busy-wait: keeps every racer inside the SAME migration window instead of drifting on setTimeout granularity",
    "  }",
    "  const db = openDb(process.env);",
    '  const version = db.prepare("PRAGMA user_version").get().user_version;',
    '  const columns = db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);',
    '  process.stdout.write(JSON.stringify({ error: null, version, columns }) + "\\n");',
    "}",
    "",
    "main().catch((err) => {",
    '  process.stdout.write(JSON.stringify({ error: err?.message ?? String(err), version: null, columns: null }) + "\\n");',
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

test(`${RACERS} processes racing to migrate the SAME v3 database converge on v4, ${ITERATIONS} times over`, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nightshift-db-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const workerPath = join(dir, "racer.mjs");
  writeFileSync(workerPath, racerSource());

  for (let pass = 0; pass < ITERATIONS; pass += 1) {
    const env = makeHome(t, `db-race-${pass}`);
    const seed = openDb(env);
    seed
      .prepare("INSERT INTO jobs (project, prompt, status, pr_url) VALUES (?, ?, 'done', ?)")
      .run("alpha", "fix the worker", "https://github.com/acme/api/pull/42");
    seed.exec(DOWNGRADE_TO_V3);
    assert.equal(seed.prepare("PRAGMA user_version").get().user_version, 3, `pass ${pass}: seed did not reach v3`);
    closeDb(env);

    const results = await raceOnce(env, workerPath, RACERS);

    for (const [idx, result] of results.entries()) {
      assert.equal(result.code, 0, `pass ${pass} racer ${idx} exited ${result.code}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.error, null, `pass ${pass} racer ${idx} threw an unhandled error: ${parsed.error}`);
      assert.equal(parsed.version, 7, `pass ${pass} racer ${idx} ended at user_version ${parsed.version}, not 7`);
      assert.deepEqual(
        MERGE_COLUMNS.filter((name) => parsed.columns.includes(name)).sort(),
        [...MERGE_COLUMNS].sort(),
        `pass ${pass} racer ${idx} is missing a merge column: ${parsed.columns.join(", ")}`,
      );
    }

    const after = openDb(env);
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 7, `pass ${pass}: final user_version`);
    const columns = after.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name);
    for (const name of MERGE_COLUMNS) {
      assert.equal(columns.filter((c) => c === name).length, 1, `pass ${pass}: ${name} duplicated: ${columns.join(", ")}`);
    }
    const row = after.prepare("SELECT * FROM jobs").get();
    assert.equal(row.pr_url, "https://github.com/acme/api/pull/42", `pass ${pass}: pre-existing row lost or altered`);
    assert.equal(row.status, "done", `pass ${pass}: pre-existing row status lost or altered`);
    closeDb(env);
  }
});
