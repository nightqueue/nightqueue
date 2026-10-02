import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { openDbReadOnly, schemaVersionOn } from "../../src/memory/db.mjs";
import { makeHostEnv } from "../../test-support/host.mjs";
import { makeDir } from "../../test-support/memory.mjs";
import { buildV19Home } from "../../test-support/v19-home.mjs";

// A v19 home with a dangling job reference will REFUSE the v20 migration; doctor must not promise a clean migration.
test("doctor on a v19 home with an orphan job_id does not promise a clean migration", async (t) => {
  const host = makeHostEnv(t, "qa-doctor-v19-orphan");
  const checkout = join(makeDir(t, "qa-doctor-v19-orphan-checkout"), "nightqueue");
  mkdirSync(join(checkout, ".git"), { recursive: true });
  buildV19Home(host.env, {
    checkout: realpathSync(checkout),
    extra: (db) => db.prepare("UPDATE roadmap_items SET job_id = 999 WHERE id = 3").run(),
  });

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

  const db = openDbReadOnly(host.env, { anySchema: true });
  try {
    assert.equal(schemaVersionOn(db), 19, "doctor must not migrate");
  } finally {
    db.close();
  }

  assert.match(projects.detail, /dangling|orphan|refus|reference/i, `doctor promises a clean migration on a home that will refuse: ${projects.detail}`);
});
