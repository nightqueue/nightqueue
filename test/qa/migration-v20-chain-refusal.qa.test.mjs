import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dbPath, preV19BackupPath } from "../../src/config/paths.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { buildV18Home } from "../../test-support/v18-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

function versionOf(env) {
  const db = new DatabaseSync(dbPath(env), { readOnly: true });
  try {
    return db.prepare("PRAGMA user_version").get().user_version;
  } finally {
    db.close();
  }
}

test("H1: a refusal that says nothing was written leaves the home as it was (v18 chain)", () => {
  const dir = mkdtempSync(join(tmpdir(), "nq-h1-"));
  const env = { NIGHTQUEUE_HOME: dir };
  try {
    buildV18Home(env, { extra: (db) => db.exec("UPDATE decisions SET job_id = 999 WHERE id = 1") });
    const before = versionOf(env);
    assert.equal(before, 18);
    let message = "";
    try {
      openDb(env);
    } catch (error) {
      message = String(error.message);
    } finally {
      closeDb(env);
    }
    assert.ok(message, "the open must refuse the orphan");
    if (message.includes("nothing was written")) {
      assert.equal(versionOf(env), before, `message claims nothing was written but user_version moved ${before} -> ${versionOf(env)}`);
      assert.equal(existsSync(preV19BackupPath(env)), false, "a .pre-v19 file was published despite 'nothing was written'");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
