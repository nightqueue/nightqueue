import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbPath } from "../../src/config/paths.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { DB_USER_VERSION } from "../../src/memory/schema.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { makeHome, makeProject, seedLegacyV8Home } from "../../test-support/memory.mjs";
import { migrateTestHome } from "../../test-support/migrate.mjs";

const REDRAW = "\u001b[0J";
const OUTDATED = /database at v8, this nightqueue expects v22: run `nightqueue update`/;

// The schema version and the shape of `jobs` on disk right now, read on a fresh connection.
function schemaState(env) {
  const db = openDb(env);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const hasLegacyColumn = db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "pr_checked_at");
  const statuses = db.prepare("SELECT status FROM jobs ORDER BY id").all().map((row) => row.status);
  return { version, hasLegacyColumn, statuses };
}

// A v8 home with `rows` merged jobs, closed so its file is the whole database.
function v8Home(t, name, rows) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  seedLegacyV8Home(env, { rows });
  closeDb(env);
  return env;
}

test("a one-shot `queue status` on a v8 home refuses with the update message and writes nothing", async (t) => {
  const env = v8Home(t, "v9-trigger-one-shot", 2);
  const before = readFileSync(dbPath(env));

  const err = [];
  const ctx = { ...defaultContext(), env, out: () => {}, err: (line) => err.push(line) };
  const code = await run(["queue", "status"], ctx);

  assert.equal(code, 1);
  assert.match(err.join("\n"), OUTDATED);
  assert.ok(readFileSync(dbPath(env)).equals(before), "a refused read wrote to the database");
});

test("once `nightqueue update` migrated a v8 home, `queue status` renders the retired `merged` rows as closed", async (t) => {
  const env = v8Home(t, "v9-trigger-migrated", 2);
  migrateTestHome(env);

  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {} };
  const code = await run(["queue", "status"], ctx);

  assert.equal(code, 0, out.join("\n"));
  assert.deepEqual(schemaState(env), { version: DB_USER_VERSION, hasLegacyColumn: false, statuses: ["closed", "closed"] });
  assert.match(out.find((line) => line.startsWith("J-1 ")) ?? "", /closed/, "the table still showed the retired `merged` status");
});

test("a `--follow` on a v8 home refuses before it draws a frame", async (t) => {
  const env = v8Home(t, "v9-trigger-follow", 1);
  const before = readFileSync(dbPath(env));

  const frames = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: () => {},
    err: (line) => err.push(line),
    stdout: { isTTY: true, columns: 200, write: (text) => text.includes(REDRAW) && frames.push(text) },
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);

  assert.equal(code, 1);
  assert.equal(frames.length, 0, "a frame was drawn on an older database");
  assert.match(err.join("\n"), OUTDATED);
  assert.ok(readFileSync(dbPath(env)).equals(before), "a refused read wrote to the database");
});

test("the runner refuses a v8 home at the start of a cycle instead of migrating it or backing off", async (t) => {
  const env = v8Home(t, "v9-trigger-runner", 1);
  const before = readFileSync(dbPath(env));

  await assert.rejects(runCycle({ env, keepAwake: false }), (err) => err.code === "SCHEMA_OUTDATED" && OUTDATED.test(err.message));

  assert.ok(readFileSync(dbPath(env)).equals(before), "the runner wrote to an older database");
});
