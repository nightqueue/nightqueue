import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { addOrg } from "../src/config/orgs.mjs";
import { dbPath, orgRenamePendingPath } from "../src/config/paths.mjs";
import { loadConfig, saveConfig } from "../src/config/store.mjs";
import { makeHome } from "../test-support/memory.mjs";

// H1A: `org rename` / `org repair` / `org remove` reach `store.orgs.*` through `openStore(env)`
// (src/cli/org.mjs:97,115,120,161), and `createLocalStore`'s eager `openDb(env)` (src/store/local.mjs:200)
// now creates `nightqueue.db` before `renameOrgRows`'s own `existsSync(dbPath(env))` guard
// (src/memory/orgs.mjs:19) ever runs - a home that never had a database gets one anyway. Pre-refactor, that
// guard lived first and made the call a safe no-op.

function runCli(env, argv) {
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env, out: (line) => out.push(line), err: (line) => err.push(line) };
  return run(argv, ctx).then((code) => ({ code, out, err }));
}

test("`nightqueue org rename` leaves no database behind on a home that never had one", async (t) => {
  const env = makeHome(t, "org-rename-no-db");
  assert.equal(existsSync(dbPath(env)), false, "the home already had a database before the command under test ran");

  const result = await runCli(env, ["org", "rename", "default", "widgets"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(existsSync(dbPath(env)), false, "`org rename` created nightqueue.db on a home that never had one");
});

test("`nightqueue org remove` leaves no database behind on a home that never had one", async (t) => {
  const env = makeHome(t, "org-remove-no-db");
  saveConfig(addOrg(loadConfig(env, { warn: () => {} }), "widgets"), env);
  assert.equal(existsSync(dbPath(env)), false, "the home already had a database before the command under test ran");

  const result = await runCli(env, ["org", "remove", "widgets"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(existsSync(dbPath(env)), false, "`org remove` created nightqueue.db on a home that never had one");
});

test("`nightqueue org repair` settling a pending rename leaves no database behind on a home that never had one", async (t) => {
  const env = makeHome(t, "org-repair-no-db");
  saveConfig(addOrg(loadConfig(env, { warn: () => {} }), "widgets"), env);
  writeFileSync(orgRenamePendingPath(env), `${JSON.stringify({ from: "default", to: "widgets", at: new Date().toISOString() })}\n`);
  assert.equal(existsSync(dbPath(env)), false, "the home already had a database before the command under test ran");

  const result = await runCli(env, ["org", "repair"]);

  assert.equal(result.code, 0, result.err.join("\n"));
  assert.equal(existsSync(dbPath(env)), false, "`org repair` created nightqueue.db on a home that never had one");
});
