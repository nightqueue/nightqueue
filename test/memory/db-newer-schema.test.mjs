import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dbPath } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { DB_USER_VERSION, openDb, openDbReadOnly, requireCurrentSchema } from "../../src/memory/db.mjs";
import { createServer } from "../../src/mcp/tools.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const { DatabaseSync } = await import("node:sqlite");

// Sha256 of the bytes of a file on disk, so a test can prove an open never wrote to it.
function hashOf(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Writes a database one schema version ahead of this build, with a table and a row so the file is not a trivial header.
function makeFutureHome(t, name) {
  const env = makeHome(t, name);
  ensureHome(env);
  const path = dbPath(env);
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE from_the_future (id INTEGER PRIMARY KEY, note TEXT)");
  db.prepare("INSERT INTO from_the_future (note) VALUES (?)").run("written by a newer nightqueue");
  db.exec(`PRAGMA user_version = ${DB_USER_VERSION + 1}`);
  db.close();
  return env;
}

// The exact one-line refusal a database ahead of this build's schema must produce, for the given path.
function refusalLine(path) {
  return `the database at ${path} is at schema v${DB_USER_VERSION + 1}, newer than this nightqueue (v${DB_USER_VERSION}): update nightqueue / restart the client that runs the old version`;
}

// Neither the main file nor a WAL/SHM sidecar changed: the refusal ran before any pragma or statement could touch the file.
function assertUntouched(path, expectedHash) {
  assert.equal(hashOf(path), expectedHash, "the database bytes changed after a refused open");
  assert.equal(existsSync(`${path}-wal`), false, "a refused open created a -wal file");
  assert.equal(existsSync(`${path}-shm`), false, "a refused open created a -shm file");
}

test("openDb refuses a database newer than this build's schema, closed and untouched", (t) => {
  const env = makeFutureHome(t, "db-newer-open");
  const path = dbPath(env);
  const expectedHash = hashOf(path);

  assert.throws(() => openDb(env), (err) => {
    assert.equal(err.message, refusalLine(path));
    return true;
  });
  assertUntouched(path, expectedHash);
});

test("openDbReadOnly refuses a database newer than this build's schema, closed and untouched", (t) => {
  const env = makeFutureHome(t, "db-newer-readonly");
  const path = dbPath(env);
  const expectedHash = hashOf(path);

  assert.throws(() => openDbReadOnly(env), (err) => {
    assert.equal(err.message, refusalLine(path));
    return true;
  });
  assertUntouched(path, expectedHash);
});

test("requireCurrentSchema refuses a database newer than this build's schema, closed and untouched", (t) => {
  const env = makeFutureHome(t, "db-newer-migrate");
  const path = dbPath(env);
  const expectedHash = hashOf(path);

  assert.throws(() => requireCurrentSchema(env), (err) => {
    assert.equal(err.message, refusalLine(path));
    return true;
  });
  assertUntouched(path, expectedHash);
});

// Connects an in-process MCP client and server pair, closed at the end of the test.
async function connectInProcess(t, env) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(env);
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.after(() => client.close());
  return client;
}

test("the MCP server surfaces the refusal as a tool error and leaves the database untouched", async (t) => {
  const env = makeFutureHome(t, "db-newer-mcp");
  const path = dbPath(env);
  const expectedHash = hashOf(path);

  const client = await connectInProcess(t, env);
  const result = await client.callTool({ name: "queue_status", arguments: {} });

  assert.equal(result.isError, true, "queue_status answered instead of refusing the newer schema");
  const text = result.content.map((block) => block.text).join("\n");
  assert.ok(text.includes(refusalLine(path)), `tool error did not carry the refusal line verbatim: ${text}`);
  assertUntouched(path, expectedHash);
});
