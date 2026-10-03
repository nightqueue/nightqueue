import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { confirmedSchemaProbe, isBusyError, openDb, schemaProbe, withWriteRetry } from "../../src/memory/db.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const WRITER = fileURLToPath(new URL("../../test-support/concurrent-writer.mjs", import.meta.url));
const DURATION_MS = 2000;

// Failure shaped exactly like the one node:sqlite raises when another process holds the write lock.
function busyError() {
  return Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5, errstr: "database is locked" });
}

// Spawns the writer as a real child process; stays async so both writers really overlap.
function writerAsync(env, mode, label, durationMs = DURATION_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WRITER, mode, label, String(durationMs)], {
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
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// Runs the two writers at the same time and asserts that neither of them saw the database locked.
async function raceWriters(t, name, mode) {
  const env = makeHome(t, name);
  const [a, b] = await Promise.all([writerAsync(env, mode, "A"), writerAsync(env, mode, "B")]);
  assert.equal(a.code, 0, `writer A exited ${a.code} (stderr: ${a.stderr})`);
  assert.equal(b.code, 0, `writer B exited ${b.code} (stderr: ${b.stderr})`);
  assert.doesNotMatch(a.stderr, /database is locked|SQLITE_BUSY/i, `writer A saw a lock error: ${a.stderr}`);
  assert.doesNotMatch(b.stderr, /database is locked|SQLITE_BUSY/i, `writer B saw a lock error: ${b.stderr}`);
  const written = [a, b].map((result) => JSON.parse(result.stdout.trim().split("\n").pop()).written);
  assert.ok(written[0] > 0 && written[1] > 0, `a writer wrote nothing: ${written.join(" and ")}`);
  return { env, expected: written[0] + written[1] };
}

test("two real node processes saving lessons at the same time keep every row", async (t) => {
  const { env, expected } = await raceWriters(t, "concurrent-lessons", "lesson");
  const row = openDb(env).prepare("SELECT COUNT(*) AS n FROM lessons WHERE title LIKE 'concurrent %'").get();
  assert.equal(row.n, expected, `expected ${expected} lessons, found ${row.n} (lost write under concurrency)`);
});

test("two real node processes logging pipeline runs at the same time keep every commit", async (t) => {
  const { env, expected } = await raceWriters(t, "concurrent-runs", "run");
  const db = openDb(env);
  const runs = db.prepare("SELECT COUNT(*) AS n FROM pipeline_runs WHERE slug LIKE 'concurrent-%'").get();
  assert.equal(runs.n, expected, `expected ${expected} runs, found ${runs.n} (lost commit under concurrency)`);
  const phases = db.prepare("SELECT COUNT(*) AS n FROM pipeline_phases").get();
  assert.equal(phases.n, expected * 2, "a committed run lost its phases");
});

test("two real node processes opening one fresh home never see the database refused as outdated", async (t) => {
  for (let round = 0; round < 30; round += 1) {
    const env = makeHome(t, `concurrent-fresh-${round}`);
    const [a, b] = await Promise.all([writerAsync(env, "lesson", "A", 50), writerAsync(env, "lesson", "B", 50)]);
    assert.doesNotMatch(`${a.stderr}${b.stderr}`, /expects v/, `round ${round}: a fresh home was refused as outdated: ${a.stderr}${b.stderr}`);
    assert.equal(a.code, 0, `round ${round}: writer A exited ${a.code} (stderr: ${a.stderr})`);
    assert.equal(b.code, 0, `round ${round}: writer B exited ${b.code} (stderr: ${b.stderr})`);
  }
});

// Two connections to one WAL file in a temp home: `creator` writes, `reader` only probes.
function connectionPair(t, name) {
  const home = makeHome(t, name).NIGHTQUEUE_HOME;
  mkdirSync(home, { recursive: true });
  const file = join(home, "probe.db");
  const creator = new DatabaseSync(file);
  creator.exec("PRAGMA journal_mode = WAL");
  const reader = new DatabaseSync(file);
  t.after(() => {
    reader.close();
    creator.close();
  });
  return { creator, reader };
}

test("a probe on another connection never reads version 0 with data once the stamping transaction committed", (t) => {
  const { creator, reader } = connectionPair(t, "probe-atomic");
  assert.deepEqual(schemaProbe(reader), { version: 0, holdsData: false });
  creator.exec("BEGIN IMMEDIATE");
  creator.exec("CREATE TABLE lessons (id INTEGER PRIMARY KEY)");
  creator.exec("INSERT INTO lessons (id) VALUES (1)");
  creator.exec("PRAGMA user_version = 22");
  assert.deepEqual(schemaProbe(reader), { version: 0, holdsData: false });
  creator.exec("COMMIT");
  assert.deepEqual(schemaProbe(reader), { version: 22, holdsData: false });
});

test("a stale version 0 read followed by rows is probed again before it can refuse", (t) => {
  const { creator, reader } = connectionPair(t, "probe-reprobe");
  creator.exec("CREATE TABLE lessons (id INTEGER PRIMARY KEY)");
  creator.exec("INSERT INTO lessons (id) VALUES (1)");
  let stamped = false;
  const racing = {
    exec: (sql) => reader.exec(sql),
    prepare: (sql) => {
      const statement = reader.prepare(sql);
      if (!stamped && sql.startsWith("SELECT 1 FROM lessons")) {
        stamped = true;
        creator.exec("PRAGMA user_version = 22");
      }
      return statement;
    },
  };
  assert.deepEqual(confirmedSchemaProbe(racing), { version: 22, holdsData: false });
});

test("a write refused by the lock is retried instead of surfacing to the caller", () => {
  let calls = 0;
  const value = withWriteRetry(() => {
    calls += 1;
    if (calls < 3) throw busyError();
    return "written";
  });
  assert.equal(value, "written");
  assert.equal(calls, 3);
});

test("only a lock failure is retried: any other error goes straight to the caller", () => {
  assert.equal(isBusyError(busyError()), true);
  assert.equal(isBusyError(new Error("no such table: lessons")), false);
  assert.throws(
    () =>
      withWriteRetry(() => {
        throw new Error("no such table: lessons");
      }),
    /no such table/,
  );
});
