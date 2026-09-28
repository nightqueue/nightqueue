import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dbPath, homeDir, runDir, runsIdMarkerPath } from "../../src/config/paths.mjs";
import { finishV18, migrateToV18 } from "../../src/memory/migration/v18.mjs";
import { migrateToV19 } from "../../src/memory/migration/v19.mjs";
import { buildLegacyHome, legacyConfig } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const { DatabaseSync } = await import("node:sqlite");

// QA (Group B, PROVER): the runs-by-id merge (finishV18 -> moveRunsToIds) must never overwrite a pre-existing runs/<id>/<slug>
// that was already on disk BEFORE the first open's migration/finish ran, and it must not silently lose the by-name directory's
// content either. The pre-existing runs/<id>/<slug> is created from inside `afterCommit` (fired right after migrateToV18's
// COMMIT, when the registry already knows the project's id, but strictly before finishV18 runs the runs move) so this exercises
// the real "first writable openDb() on a v17 home" sequence end to end, not a synthetic call to finishV18 alone on an
// already-migrated home.
test("a run directory already present under the target id keeps its own bytes, and the by-name directory is kept in place with its bytes too", (t) => {
  const env = makeHome(t, "qa-runs-merge-no-overwrite");
  const checkoutDir = join(makeDir(t, "qa-runs-merge-checkout"), "api");
  mkdirSync(join(checkoutDir, ".git"), { recursive: true });
  const config = legacyConfig({ projects: { api: { path: checkoutDir, org: "default" } } });
  buildLegacyHome(env, { config, runs: { api: ["taken"] } });

  const byNameDir = join(homeDir(env), "runs", "api", "taken");
  writeFileSync(join(byNameDir, "state.json"), "by-name-content\n");

  let preexistingTargetDir = null;
  const preexistingBytes = "PRE-EXISTING-BY-ID-CONTENT-DO-NOT-TOUCH\n";

  const raw = new DatabaseSync(dbPath(env));
  raw.exec("PRAGMA busy_timeout = 5000");
  migrateToV18(raw, env, {
    afterCommit: () => {
      // Registry is populated at this point (COMMIT already ran), but finishV18/moveRunsToIds has not run yet.
      const apiId = raw.prepare("SELECT id FROM projects WHERE name = 'api'").get().id;
      preexistingTargetDir = runDir(apiId, "taken", env);
      mkdirSync(preexistingTargetDir, { recursive: true });
      writeFileSync(join(preexistingTargetDir, "state.json"), preexistingBytes);
    },
  });
  assert.ok(preexistingTargetDir, "afterCommit hook never fired: the migration path changed under the PoC");
  migrateToV19(raw, env);

  const warnings = [];
  finishV18(raw, env, { warn: (line) => warnings.push(line) });
  raw.close();

  // The break this PoC watches for: the pre-existing runs/<id>/<slug> must never be overwritten, byte for byte.
  assert.equal(
    readFileSync(join(preexistingTargetDir, "state.json"), "utf8"),
    preexistingBytes,
    "the pre-existing runs/<id>/taken content was overwritten by the merge from runs/<name>/taken",
  );

  // The by-name directory must not be silently deleted with its content lost when the target is already taken.
  assert.equal(existsSync(byNameDir), true, "runs/api/taken was deleted even though its target was already occupied");
  assert.equal(
    readFileSync(join(byNameDir, "state.json"), "utf8"),
    "by-name-content\n",
    "the conflicting by-name run's content was lost",
  );

  // The conflict must be surfaced, not swallowed silently.
  assert.ok(
    warnings.some((line) => line.includes("already exists")),
    `expected a warning about the pre-existing target, got: ${JSON.stringify(warnings)}`,
  );
});
