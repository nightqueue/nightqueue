import { existsSync } from "node:fs";
import { dbPath } from "../config/paths.mjs";
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

// The store of this NIGHTSHIFT_HOME, opening and migrating the database on first use.
export function openStore(env = process.env) {
  return cachedStore(readWriteStores, env, false);
}

// The store of this NIGHTSHIFT_HOME for a caller that must never create nor migrate it: it opens nothing until a read needs it, and refuses every write; its connection is cached until `close()`, so a process that polls for hours takes `withReadOnlyStore` instead.
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

// Creates the database of this home when there is none yet, so a read-only caller has something to open; on a home that already has one it opens nothing at all.
export async function ensureStoreExists(env = process.env) {
  if (existsSync(dbPath(env))) return;
  await openStore(env).connect();
}
