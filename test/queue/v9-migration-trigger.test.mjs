import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { DB_USER_VERSION } from "../../src/memory/schema.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { makeHome, makeProject, seedLegacyV8Home } from "../../test-support/memory.mjs";

const REDRAW = "\u001b[0J";

// The schema version and the shape of `jobs` on disk right now, read on a fresh connection.
function schemaState(env) {
  const db = openDb(env);
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const hasLegacyColumn = db.prepare("PRAGMA table_info(jobs)").all().some((column) => column.name === "pr_checked_at");
  const statuses = db.prepare("SELECT status FROM jobs ORDER BY id").all().map((row) => row.status);
  return { version, hasLegacyColumn, statuses };
}

test("a single one-shot `queue status` migrates a v8 home to v9 before it renders", async (t) => {
  const env = makeHome(t, "v9-trigger-one-shot");
  makeProject(t, env, "alpha");
  seedLegacyV8Home(env, { rows: 2 });

  const out = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: () => {} };
  const code = await run(["queue", "status"], ctx);

  assert.equal(code, 0, out.join("\n"));
  assert.deepEqual(schemaState(env), { version: DB_USER_VERSION, hasLegacyColumn: false, statuses: ["closed", "closed"] });
  assert.match(out.find((line) => line.startsWith("#1 ")) ?? "", /closed/, "the table still showed the retired `merged` status");
});

test("a single `--follow` frame migrates a v8 home to v9 before it draws the first frame", async (t) => {
  const env = makeHome(t, "v9-trigger-follow");
  makeProject(t, env, "alpha");
  seedLegacyV8Home(env, { rows: 1 });

  const frames = [];
  const ctx = {
    ...defaultContext(),
    env,
    out: () => {},
    err: () => {},
    stdout: { isTTY: true, columns: 200, write: (text) => text.includes(REDRAW) && frames.push(text) },
    killImpl: () => {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    },
  };
  const code = await run(["queue", "status", "--follow", "--until-idle"], ctx);

  assert.equal(code, 0);
  assert.ok(frames.length >= 1, "no frame was drawn");
  assert.match(frames[0], /closed/, "the first frame still showed the retired `merged` status");
  assert.deepEqual(schemaState(env), { version: DB_USER_VERSION, hasLegacyColumn: false, statuses: ["closed"] });
});

test("the runner migrates a v8 home to v9 at the start of a cycle", async (t) => {
  const env = makeHome(t, "v9-trigger-runner");
  makeProject(t, env, "alpha");
  seedLegacyV8Home(env, { rows: 1 });

  const cycle = await runCycle({ env });

  assert.equal(cycle.reason, "empty-queue", "setup: the fixture should have nothing claimable");
  assert.deepEqual(schemaState(env), { version: DB_USER_VERSION, hasLegacyColumn: false, statuses: ["closed"] });
});
