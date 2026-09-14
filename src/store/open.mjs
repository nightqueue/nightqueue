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

// The store of this NIGHTSHIFT_HOME for a caller that must never create nor migrate it: it opens nothing until a read needs it, and refuses every write.
export function openStoreReadOnly(env = process.env) {
  return cachedStore(readOnlyStores, env, true);
}
