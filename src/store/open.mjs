import { existsSync } from "node:fs";
import { dbPath } from "../config/paths.mjs";
import { loadRawConfig } from "../config/store.mjs";
import { diskSchema, hasRetiredConnection, migrateHomeDatabase, releaseCachedConnection } from "../memory/db.mjs";
import { hasLegacyRegistry } from "../memory/migration/v18.mjs";
import { homeActivity as readHomeActivity } from "../memory/schema-gate.mjs";
import { createLocalStore } from "./local.mjs";

const readWriteStores = new Map();
const readOnlyStores = new Map();

// One instance per database path, so every caller of a home shares the same store; `close()` evicts it and the next call builds a fresh one.
function cachedStore(cache, env, readOnly) {
  const path = dbPath(env);
  const cached = cache.get(path);
  if (cached) return cached;
  const store = createLocalStore(env, { readOnly, onClose: () => cache.delete(path) });
  cache.set(path, store);
  return store;
}

// The store of this NIGHTQUEUE_HOME, opening and migrating the database on first use.
export function openStore(env = process.env) {
  return cachedStore(readWriteStores, env, false);
}

// The store of this NIGHTQUEUE_HOME for a caller that must never create nor migrate it: it opens nothing until a read needs it, and refuses every write; its connection is cached until `close()`, so a process that polls for hours takes `withReadOnlyStore` instead.
export function openStoreReadOnly(env = process.env) {
  return cachedStore(readOnlyStores, env, true);
}

// A read-only store built outside the cache, for a long-lived process that must read a fresh snapshot on every poll: the connection is opened for this call and always closed, and closing a read-only one never removes `-shm`.
export async function withReadOnlyStore(env, fn) {
  const store = createLocalStore(env, { readOnly: true });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

// The store a READ command reads the registry through, never creating a database for nothing: null on a home with none and no
// v17 registry in config.json to import; the writable store when that import is due, the read-only one otherwise - refusing an older
// database with the `nightqueue update` message, never migrating it.
export async function openRegistryReader(env = process.env) {
  if (!existsSync(dbPath(env))) return hasLegacyRegistry(loadRawConfig(env)) ? openStore(env) : null;
  const store = openStoreReadOnly(env);
  await store.requireCurrentSchema();
  return store;
}

// The schema of the home's database on disk, read from its header without opening it: `{ exists, version, fresh, unknown }`.
export async function homeSchema(env = process.env) {
  return diskSchema(env);
}

// What uses the home's database right now, read on any schema: the jobs and closes holding a live lease, and the `running` rows whose lease expired.
export async function homeActivity(env = process.env) {
  return readHomeActivity(env);
}

// Backs up the home's older database to `backupPath`, then migrates it to this build's schema; only `nightqueue update --schema-only` calls it.
export async function migrateHome(env = process.env, { backupPath } = {}) {
  return migrateHomeDatabase(env, { backupPath });
}

// The writable store of a command that then reads config.json: opened first, so a v17 registry still in the file is imported and its
// bindings moved to org ids before the command reads the config it will write back.
export async function openRegistryWriter(env = process.env) {
  const store = openStore(env);
  await store.connect();
  return store;
}

// Releases this process's own writable connection of the home before a repair moves its files, answering `heldBroken` when a retired handle of it is still held.
export function releaseHomeConnections(env = process.env) {
  releaseCachedConnection(env);
  return { heldBroken: hasRetiredConnection(env) };
}

// Creates the database of this home when there is none yet, so a read-only caller has something to open; on a home that already has one it opens nothing at all.
export async function ensureStoreExists(env = process.env) {
  if (existsSync(dbPath(env))) return;
  await openStore(env).connect();
}
