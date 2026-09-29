import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import { runnersDir } from "../../src/config/paths.mjs";
import { ensureHome } from "../../src/config/store.mjs";
import { listRunnerRecords, liveRunners } from "../../src/queue/registry.mjs";
import { makeHome } from "../../test-support/memory.mjs";

// Makes the registry directory a plain file so `readdirSync` throws ENOTDIR deterministically,
// standing in for any real registry-directory read failure (EACCES, a bad NFS mount, ...).
function breakRegistryDir(env) {
  ensureHome(env);
  writeFileSync(runnersDir(env), "not a directory");
}

test("a registry directory that cannot be read is NOT reported as an empty, never-used registry", (t) => {
  const env = makeHome(t, "registry-unreadable-dir");
  breakRegistryDir(env);

  const records = listRunnerRecords(env);
  assert.ok(
    records.some((record) => record.status === "unreadable"),
    `listRunnerRecords silently returned an empty list for an unreadable registry directory, indistinguishable from a home that never registered a runner: ${JSON.stringify(records)}`,
  );
});

test("liveRunners does not fail open (report zero live runners) when the registry directory cannot be read", (t) => {
  const env = makeHome(t, "registry-unreadable-dir-live");
  breakRegistryDir(env);

  assert.throws(
    () => liveRunners(env),
    /unreadable|cannot be (read|listed)/i,
    "liveRunners returned normally, reporting no live runner for a registry directory it could not even list",
  );
});
