import assert from "node:assert/strict";
import { test } from "node:test";
import { newId } from "../../src/config/ids.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { buildV18Home } from "../../test-support/v18-home.mjs";

// A five-letter name c?e?q derives the base key `CE` whatever the two `?` are.
function sameBaseName(n) {
  return `c${String.fromCharCode(97 + (n % 26))}e${String.fromCharCode(97 + Math.floor(n / 26))}q`;
}

// 30 owners whose names all derive the same base key must still migrate, each with a distinct key.
test("v19 migrates a home where 30 projects derive the same base key", (t) => {
  const env = makeHome(t, "qa-v19-exhaustion");
  buildV18Home(env, {
    extra(db, ids) {
      const insert = db.prepare("INSERT INTO projects (id, name, path, org_id) VALUES (?, ?, NULL, ?)");
      for (let n = 0; n < 30; n += 1) insert.run(newId(), sameBaseName(n), ids.orgs.default);
    },
  });
  try {
    const db = openDb(env);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 20);
    const keys = db.prepare("SELECT key FROM projects UNION ALL SELECT key FROM orgs").all().map((row) => row.key);
    assert.equal(new Set(keys).size, keys.length, "keys are not unique");
    for (const key of keys) assert.match(key, /^[A-Z][A-Z0-9]+$/);
  } finally {
    closeDb?.(env);
  }
});
