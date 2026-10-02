import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, truncateSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { walUserVersion } from "../../src/memory/wal-header.mjs";

// A WAL database whose log still holds every commit, with the connection that wrote it kept open.
function walDatabase(t) {
  const dir = mkdtempSync(join(tmpdir(), "nightqueue-wal-header-"));
  const path = join(dir, "x.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v INTEGER)");
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, path, wal: `${path}-wal` };
}

test("the WAL reader answers the user_version of the last committed page 1, which the main file header does not carry yet", (t) => {
  const { db, path, wal } = walDatabase(t);
  db.exec("PRAGMA user_version = 20");
  db.exec("INSERT INTO t VALUES (1)");
  assert.equal(readFileSync(path).readUInt32BE(60), 0, "the header already carried the stamp: the fixture proves nothing");
  assert.equal(walUserVersion(wal), 20);
  db.exec("PRAGMA user_version = 21");
  assert.equal(walUserVersion(wal), 21);
});

test("the WAL reader ignores a torn last frame and a log that is not a valid one", (t) => {
  const { db, wal } = walDatabase(t);
  db.exec("PRAGMA user_version = 20");
  db.exec("PRAGMA user_version = 21");
  truncateSync(wal, statSync(wal).size - 10);
  assert.equal(walUserVersion(wal), 20);
  writeFileSync(wal, Buffer.alloc(64));
  assert.equal(walUserVersion(wal), null);
});
