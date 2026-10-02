import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { dbPath } from "../../src/config/paths.mjs";
import { openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { makeHostEnv } from "../../test-support/host.mjs";
import { makeDir } from "../../test-support/memory.mjs";
import { buildV18Home } from "../../test-support/v18-home.mjs";

// doctor on an un-migrated v18 home must name the pending migration, never a raw SQL error, and must not migrate.
test("doctor on a v18 home names the pending v19 migration and does not migrate", async (t) => {
  const host = makeHostEnv(t, "qa-doctor-v18");
  const checkout = join(makeDir(t, "qa-doctor-v18-checkout"), "nightqueue");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  buildV18Home(host.env, { checkout: realpathSync(checkout) });

  const out = [];
  const ctx = {
    ...defaultContext(),
    env: host.env,
    out: (line) => out.push(line),
    err: () => {},
    spawnSyncImpl: (file, args, options) => (file === "gh" ? { status: 0, stdout: "ok", stderr: "" } : spawnSync(file, args, options)),
  };
  await run(["doctor", "--json"], ctx);
  const report = JSON.parse(out[0]);
  const projects = report.checks.find((check) => check.name === "projects");
  assert.ok(projects, "no projects check");
  assert.doesNotMatch(projects.detail, /no such column/, `doctor leaked a SQL error: ${projects.detail}`);
  assert.match(projects.detail, /v18/);
  assert.match(projects.detail, /v22/);

  const db = openDbReadOnly(host.env, { anySchema: true });
  try {
    assert.equal(schemaVersionOn(db), 18, "doctor must not migrate");
  } finally {
    db.close();
  }
  assert.ok(dbPath(host.env));
});
