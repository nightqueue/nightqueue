import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dbPath } from "../../src/config/paths.mjs";
import { closeDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightshift.mjs", import.meta.url));

// Runs the real CLI in its own process, with the isolated home of the test.
function runCli(env, args, { cwd } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { env, cwd, encoding: "utf8" });
}

test("an org rename interrupted after the config write leaves the org's decision unreachable under every spelling", (t) => {
  const env = makeHome(t, "org-rename-atomicity");
  const cwd = makeProject(t, env, "alpha", { org: "acme" });
  saveDecision({ org: "acme", title: "one queue per product", context: "c", decision: "d" }, env);
  // Flush the WAL into the main file and drop the cached connection, so a read-only
  // main file alone is enough to deny the write the rename needs.
  closeDb(env);

  assert.equal(existsSync(dbPath(env)), true, "the setup must have created the database");
  chmodSync(dbPath(env), 0o444);
  t.after(() => chmodSync(dbPath(env), 0o644));

  const renamed = runCli(env, ["org", "rename", "acme", "acmeweb"], { cwd });
  assert.notEqual(renamed.status, 0, `the DB half of the rename must fail loudly while its file is read-only, not silently succeed\nstdout: ${renamed.stdout}\nstderr: ${renamed.stderr}`);

  // Correct behavior: a decision saved under `acme` before the interrupted rename must
  // still be reachable under SOME spelling of the org afterward.
  const underNew = runCli(env, ["decision", "list", "--org", "acmeweb"], { cwd });
  const underOld = runCli(env, ["decision", "list", "--org", "acme"], { cwd });
  const reachableUnderNew = underNew.status === 0 && underNew.stdout.includes("one queue per product");
  const reachableUnderOld = underOld.status === 0 && underOld.stdout.includes("one queue per product");

  assert.equal(
    reachableUnderNew || reachableUnderOld,
    true,
    [
      "the decision saved under `acme` must be listable under some org name after the interrupted rename",
      `--org acmeweb -> status=${underNew.status} stdout=${JSON.stringify(underNew.stdout)} stderr=${JSON.stringify(underNew.stderr)}`,
      `--org acme    -> status=${underOld.status} stdout=${JSON.stringify(underOld.stdout)} stderr=${JSON.stringify(underOld.stderr)}`,
    ].join("\n"),
  );
});
