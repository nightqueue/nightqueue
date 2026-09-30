import { chmodSync, copyFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { StoreUnavailableError } from "../src/config/errors.mjs";
import { dbPath, homeDir } from "../src/config/paths.mjs";
import { closeDb, openDb } from "../src/memory/db.mjs";
import { openStore } from "../src/store/open.mjs";
import { makeHome } from "./memory.mjs";

// Turns a home's database into fixture (iii) - the main file replaced by text, which SQLite really refuses with NOTADB (errcode 26) - and answers how to put the good file back.
export function makeSickHome(env) {
  const path = dbPath(env);
  const good = join(dirname(homeDir(env)), "good.db");
  openDb(env).exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDb(env);
  copyFileSync(path, good);
  for (const sidecar of ["-wal", "-shm"]) rmSync(`${path}${sidecar}`, { force: true });
  writeFileSync(path, "this is not a database, it is text\n");
  return {
    restore() {
      copyFileSync(good, path);
    },
  };
}

// The skip reason of a chmod fixture when this process runs as root, which ignores file modes; false otherwise.
export function unreadableSkip() {
  return typeof process.getuid === "function" && process.getuid() === 0 ? "root ignores chmod" : false;
}

// Makes a home's existing database unopenable (mode 000, SQLite answers CANTOPEN, errcode 14) and puts the mode back after the test.
export function makeUnreadableHome(t, env) {
  const path = dbPath(env);
  openDb(env).exec("PRAGMA wal_checkpoint(TRUNCATE)");
  closeDb(env);
  chmodSync(path, 0o000);
  t.after(() => chmodSync(path, 0o600));
}

// A real StoreUnavailableError captured once from a fixture-(iii) home, for a store wrapper to rethrow where a test cannot inject the store.
export async function capturedUnavailableError(t) {
  const env = makeHome(t, "captured-unavailable");
  openDb(env);
  makeSickHome(env);
  try {
    await openStore(env).jobs.listJobs();
  } catch (err) {
    if (err instanceof StoreUnavailableError) return err;
    throw new Error(`capturedUnavailableError: fixture (iii) failed with something else: ${err?.message ?? err}`);
  }
  throw new Error("capturedUnavailableError: fixture (iii) did not fail");
}
