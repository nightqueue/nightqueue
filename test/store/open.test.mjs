import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { dbPath } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { openStore, openStoreReadOnly } from "../../src/store/open.mjs";
import { makeHome } from "../../test-support/memory.mjs";

test("one store per database path, and one per kind", (t) => {
  const env = makeHome(t, "store-open");
  const other = makeHome(t, "store-open-other");

  assert.equal(openStore(env), openStore(env), "the same home shares one store");
  assert.notEqual(openStore(env), openStore(other), "two homes never share a store");
  assert.notEqual(openStore(env), openStoreReadOnly(env), "the read-only store is a store of its own");
});

test("a read-only store opens nothing until a read needs it, and never creates the database", async (t) => {
  const env = makeHome(t, "store-readonly-lazy");
  const store = openStoreReadOnly(env);
  assert.equal(existsSync(dbPath(env)), false, "creating the store opened no database");

  const health = await store.health();

  assert.equal(existsSync(dbPath(env)), false, "a read on a home with no database created none");
  assert.equal(health.schemaVersion, null);
  assert.equal(typeof health.errors.schemaVersion, "string", "the failure of the read is reported, never thrown");
});

test("a read-only store refuses a write by name instead of falling back to a writable connection", async (t) => {
  const env = makeHome(t, "store-readonly-fence");
  openDb(env);
  const store = openStoreReadOnly(env);

  await assert.rejects(() => store.jobs.addJob({ project: "alpha", prompt: "write me" }), /`jobs\.addJob`/);
  await assert.rejects(() => store.orgs.rename("a", "b"), /`orgs\.rename`/);
  assert.equal(await store.jobs.status(1), null, "an allowed read still answers: there is no job 1");
});

test("closing a read-write store releases the instance and never closes the connection of the home", async (t) => {
  const env = makeHome(t, "store-close");
  const store = openStore(env);
  const connection = openDb(env);

  await store.close();

  assert.equal(openDb(env), connection, "the connection of the home survives the close");
  assert.equal(connection.prepare("SELECT 1 AS n").get().n, 1, "the connection is still usable");
  assert.notEqual(openStore(env), store, "the closed instance was evicted, so the next open builds a fresh one");
});
