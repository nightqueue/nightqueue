import assert from "node:assert/strict";
import { test } from "node:test";
import { dbPath } from "../../src/config/paths.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { makeHome } from "../../test-support/memory.mjs";
import { buildV19Home } from "../../test-support/v19-home.mjs";

const { DatabaseSync } = await import("node:sqlite");

// H2: a v19 column the v20 ddl does not know must not vanish silently: the open refuses naming it, or the data survives.
test("v20 does not silently drop an operator column of a v19 table", (t) => {
  const env = makeHome(t, "v20-extra-column");
  buildV19Home(env, {
    extra: (db) => {
      db.exec("ALTER TABLE decisions ADD COLUMN operator_note TEXT");
      db.exec("UPDATE decisions SET operator_note = 'keep me' WHERE id = 1");
    },
  });

  let refusal = null;
  try {
    openDb(env);
  } catch (error) {
    refusal = error;
  } finally {
    closeDb?.(env);
  }

  if (refusal) {
    assert.match(String(refusal.message), /operator_note/, "a refusal must name the unmapped column");
    return;
  }
  const raw = new DatabaseSync(dbPath(env), { readOnly: true });
  try {
    const columns = raw.prepare("PRAGMA table_info(decisions)").all().map((c) => c.name);
    assert.ok(columns.includes("operator_note"), `operator_note was dropped silently; decisions columns: ${columns.join(", ")}`);
    assert.equal(raw.prepare("SELECT operator_note AS v FROM decisions WHERE id = 1").get().v, "keep me");
  } finally {
    raw.close();
  }
});
