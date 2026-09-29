import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { pruneVersions } from "../src/cli/runtime-versions.mjs";
import { runnersDir } from "../src/config/paths.mjs";
import { writeRunnerRecord } from "../src/queue/registry.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";

const SETUP = ["setup", "--no-path", "--no-embedding"];

// Context that captures the output and refuses to run against anything but an isolated environment,
// the same shape test/runtime-versions.test.mjs uses.
function makeCtx(env) {
  const out = [];
  const err = [];
  const ctx = {
    ...defaultContext(),
    env: assertIsolatedEnv(env),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    stdin: { isTTY: false },
    stdout: new PassThrough(),
  };
  return { ctx, out, err };
}

// A version directory of an install nobody remembers, old enough to be the first one pruned;
// the exact fixture test/runtime-versions.test.mjs's C10 tests use.
function writeOldVersion(host, name) {
  const dir = join(host.runtimeVersions, name);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(dir, old, old);
  return dir;
}

// Replaces the registry directory, whatever it already holds, with a plain file: `readdirSync`
// then throws ENOTDIR deterministically, standing in for any real registry-directory read failure.
function breakRegistryDir(host) {
  const dir = runnersDir(host.env);
  rmSync(dir, { recursive: true, force: true });
  writeFileSync(dir, "not a directory");
}

test("a live runner's version directory survives a prune even when the registry directory cannot be read", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-registry-unreadable");
  const setup = makeCtx(host.env);
  assert.equal(await run(SETUP, setup.ctx), 0, setup.err.join("\n"));

  const stale = writeOldVersion(host, "0.0.1-20200101T000000Z");
  const live = writeOldVersion(host, "0.0.2-20200102T000000Z");
  writeRunnerRecord({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain", runtimeDir: live }, host.env);

  // Break the registry directory AFTER the live runner registered: an unreadable directory
  // must never be interpreted as "no live runner", or the version it runs from gets deleted.
  breakRegistryDir(host);

  pruneVersions(host.env);

  assert.equal(
    existsSync(live),
    true,
    `the directory the live runner runs from was pruned because the registry directory could not be read: ${live}`,
  );
  // Fail-safe, not a half measure: a registry that could not be read proves NO directory
  // unprotected, so the prune deletes nothing at all - the stale version survives too, and
  // is collected by the next prune that can read the registry.
  assert.equal(existsSync(stale), true, "a prune that cannot read the registry must delete nothing at all");
});
