import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { ensureHome } from "../src/config/store.mjs";
import { dbPath } from "../src/config/paths.mjs";
import { closeDb } from "../src/memory/db.mjs";
import { makeHostEnv } from "../test-support/host.mjs";

// Runs the diagnosis in process, the same way the other doctor tests do.
async function diagnose(env) {
  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {}, spawnSyncImpl: () => ({ status: 1, error: { code: "ENOENT" } }) };
  const code = await run(["doctor", "--json"], ctx);
  return { code, report: JSON.parse(out[0]) };
}

// Builds a database that predates the current schema version: base tables only, no evolving
// columns, no indexes, no FTS mirrors and user_version left at SQLite's default (0). This is the
// realistic shape of a nightqueue.db carried over from an older install.
function writeLegacyDatabase(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      title TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      solution TEXT NOT NULL,
      prevention TEXT NOT NULL,
      attempts INTEGER,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      model TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.close();
}

test("nightqueue doctor must not migrate an existing database it only diagnoses", async (t) => {
  const host = makeHostEnv(t, "doctor-readonly-db");
  const path = dbPath(host.env);
  ensureHome(host.env);
  writeLegacyDatabase(path);

  const before = {
    bytes: readFileSync(path),
    mtimeMs: statSync(path).mtimeMs,
    userVersion: new DatabaseSync(path, { readOnly: true }).prepare("PRAGMA user_version").get().user_version,
  };
  assert.equal(before.userVersion, 0, "fixture must start one version behind the current schema");

  await diagnose(host.env);
  closeDb(host.env);

  const after = {
    bytes: readFileSync(path),
    mtimeMs: statSync(path).mtimeMs,
    userVersion: new DatabaseSync(path, { readOnly: true }).prepare("PRAGMA user_version").get().user_version,
  };

  assert.equal(after.userVersion, before.userVersion, "`nightqueue doctor` bumped PRAGMA user_version of a database it should only read");
  assert.deepEqual(after.bytes, before.bytes, "`nightqueue doctor` rewrote the bytes of a database it should only read");
  assert.equal(existsSync(`${path}-wal`), false, "`nightqueue doctor` left a -wal file behind a diagnosis run");
});
