// QA PoC — Group A (05a-qa-analyst.md): finishV18's config.json strip is skipped when the home lock is busy during
// one open, and the analyst's claim is that it completes "on the next open". This proves both halves directly:
// the busy-lock open must NOT strip config.json (must not throw either), and a later open with the lock free must.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { lockPath } from "../../src/config/lock.mjs";
import { configPath } from "../../src/config/paths.mjs";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import * as registry from "../../src/memory/registry.mjs";
import { buildLegacyHome, legacyConfig } from "../../test-support/legacy-home.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

// A checkout directory a v17 config registers.
function checkout(t, name) {
  const dir = join(makeDir(t, `strip-lock-${name}`), name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

test("the config strip deferred by a busy home lock during one open still leaves config.json untouched, and a later open with the lock free finishes it", (t) => {
  const env = makeHome(t, "finish-v18-strip-lock-retry");
  const api = checkout(t, "api");
  const config = legacyConfig({ orgs: { acme: "gh" }, projects: { api: { path: api, org: "acme" } } });
  buildLegacyHome(env, { config });

  // Simulate ANOTHER process already holding the home lock, from OUTSIDE this process's `heldByThisProcess` set —
  // per the test recipe's gotcha, mkdirSync the lock directory directly rather than going through withLockSync/
  // runIfLockFree first, which would let this same process's own next call sail through.
  const lock = lockPath(env);
  mkdirSync(lock);

  let db;
  try {
    // This open must not throw even though the config strip's own lock attempt cannot proceed.
    db = openDb(env);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }

  const deferred = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.ok(Object.hasOwn(deferred, "projects"), "config.json lost its v17 `projects` key on the busy-lock open, instead of deferring the strip");
  assert.ok(Object.hasOwn(deferred, "orgs"), "config.json lost its v17 `orgs` key on the busy-lock open, instead of deferring the strip");

  // The database import itself is NOT gated by the lock (only the config.json rewrite is) — the project must already
  // be in the registry even though the file strip was deferred.
  const apiProject = registry.projectByName(db, "api");
  assert.ok(apiProject, "the registry import did not happen on the busy-lock open");

  // A later open, with the lock now free, is a fresh process in production; simulate it here by dropping the cached
  // connection so the next `openDb` really re-runs `initConnection` -> `finishV18`, exactly as a new process would.
  closeDb(env);
  const db2 = openDb(env);

  const stripped = JSON.parse(readFileSync(configPath(env), "utf8"));
  assert.equal(Object.hasOwn(stripped, "projects"), false, "config.json still carries `projects` after a later open found the lock free");
  assert.equal(Object.hasOwn(stripped, "orgs"), false, "config.json still carries `orgs` after a later open found the lock free");
  assert.deepEqual(stripped.orgConnections, { [registry.orgByName(db2, "acme").id]: { github: "gh" } }, "the org connection did not land by id after the retried strip");
  assert.equal(stripped.defaultOrg, registry.orgByName(db2, "default").id, "the default org is not by id after the retried strip");
});
