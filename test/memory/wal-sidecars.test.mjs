import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbPath } from "../../src/config/paths.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const DB_MODULE = fileURLToPath(new URL("../../src/memory/db.mjs", import.meta.url));

// The write-ahead log and its index, as the home has them on disk.
function sidecars(env) {
  return readdirSync(dirname(dbPath(env)))
    .filter((name) => name.startsWith("nightqueue.db-"))
    .sort();
}

// Writes to the home from a CHILD process that then exits normally: the delete-on-last-close this guards against can
// only be observed at a real process exit, never from inside the process that holds the connections.
function writeInChildAndExit(env, extra = "") {
  const script = `import { openDb } from ${JSON.stringify(DB_MODULE)};
const db = openDb(process.env);
db.exec("CREATE TABLE IF NOT EXISTS probe(x)");
db.exec("INSERT INTO probe VALUES (1)");
${extra}`;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], { env, stdio: "pipe" });
}

test("a process that exits leaves the write-ahead log and its index behind", (t) => {
  const env = makeHome(t, "wal-sidecars");

  writeInChildAndExit(env);

  assert.deepEqual(sidecars(env), ["nightqueue.db-shm", "nightqueue.db-wal"]);
});

test("the sidecars survive a process that opened the home many times", (t) => {
  const env = makeHome(t, "wal-sidecars-reopened");

  writeInChildAndExit(env, 'openDb(process.env).exec("INSERT INTO probe VALUES (2)");\n');

  assert.deepEqual(sidecars(env), ["nightqueue.db-shm", "nightqueue.db-wal"]);
});

test("everything a process committed is readable by the next one", (t) => {
  const env = makeHome(t, "wal-sidecars-data");

  writeInChildAndExit(env);

  assert.equal(openDb(env).prepare("SELECT COUNT(*) AS n FROM probe").get().n, 1);
});

test("closing a home releases its pin, so the next open of it pins the file it really has", (t) => {
  const env = makeHome(t, "wal-sidecars-close");
  openDb(env).exec("CREATE TABLE IF NOT EXISTS probe(x)");

  closeDb(env);
  const reopened = openDb(env);
  reopened.exec("INSERT INTO probe VALUES (1)");

  assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM probe").get().n, 1);
  assert.deepEqual(sidecars(env), ["nightqueue.db-shm", "nightqueue.db-wal"]);
});
