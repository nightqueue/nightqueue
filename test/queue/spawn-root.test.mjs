import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_NAME, runnerRegistryPath, runtimeCurrentLink, runtimeDir, runtimeVersionsDir } from "../../src/config/paths.mjs";
import { packageRoot, spawnRoot } from "../../src/host/paths.mjs";
import { staleRuntimeHint } from "../../src/queue/hints.mjs";
import { launchDetachedRunner } from "../../src/queue/runner.mjs";
import { registerForegroundRunner, startQueueRunner } from "../../src/queue/start.mjs";
import { makeHome } from "../../test-support/memory.mjs";

const CHILD_PID = 4242;
const OLDER_VERSION = "0.2.0-20260919T181653Z";
const NEWER_VERSION = "0.2.0-20260921T142701Z";

// Writes a minimal installed version of this package under `runtime/versions/<name>`, holding only the entry point the resolver checks for.
function writeVersion(env, name) {
  const pkgDir = join(runtimeVersionsDir(env), name, "node_modules", PACKAGE_NAME);
  mkdirSync(join(pkgDir, "bin"), { recursive: true });
  writeFileSync(join(pkgDir, "bin", "nightqueue.mjs"), "");
  return pkgDir;
}

// Points `runtime/current` at one version directory, the way an install does.
function switchCurrent(env, name) {
  mkdirSync(runtimeDir(env), { recursive: true });
  symlinkSync(join("versions", name), runtimeCurrentLink(env));
}

// A spawn double: it records every call and answers with a child that has a pid and can be unreferenced.
function fakeSpawn(calls) {
  return (file, args, options) => {
    calls.push({ file, args, options });
    return { pid: CHILD_PID, unref: () => {} };
  };
}

// The registration this pid wrote to the registry.
function registration(pid, env) {
  return JSON.parse(readFileSync(runnerRegistryPath(pid, env), "utf8"));
}

test("with no runtime installed, a detached runner is born from the caller's own tree", async (t) => {
  const env = makeHome(t, "spawn-root-none-installed");

  assert.equal(spawnRoot(env), packageRoot());

  const launched = launchDetachedRunner({ env, spawnImpl: fakeSpawn([]) });
  assert.equal(launched.runtimeDir, packageRoot());

  const calls = [];
  const started = await startQueueRunner({ env, spawnImpl: fakeSpawn(calls), killImpl: () => true });
  assert.equal(calls[0].args[0], join(packageRoot(), "bin", "nightqueue.mjs"));
  assert.equal(registration(started.pid, env).runtimeDir, packageRoot());

  assert.equal(staleRuntimeHint(env), null, "no runtime installed must never read as stale");
});

test("with a current link installed, a detached runner is born from it even when the caller's own tree is older", async (t) => {
  const env = makeHome(t, "spawn-root-newer-current");
  writeVersion(env, OLDER_VERSION);
  const newerPkgDir = realpathSync(writeVersion(env, NEWER_VERSION));
  switchCurrent(env, NEWER_VERSION);

  assert.equal(spawnRoot(env), newerPkgDir);
  assert.notEqual(spawnRoot(env), packageRoot(), "the fixture must exercise a runtime that differs from the caller's own tree");

  const calls = [];
  const launched = launchDetachedRunner({ env, spawnImpl: fakeSpawn(calls) });
  assert.equal(calls[0].args[0], join(newerPkgDir, "bin", "nightqueue.mjs"), "the detached argv did not point at the current installed runtime");
  assert.equal(launched.runtimeDir, newerPkgDir);

  const registerCalls = [];
  const started = await startQueueRunner({ env, spawnImpl: fakeSpawn(registerCalls), killImpl: () => true });
  assert.equal(
    registration(started.pid, env).runtimeDir,
    newerPkgDir,
    "the registration of a detached runner does not name the tree it really loads from",
  );

  const stale = staleRuntimeHint(env);
  assert.equal(
    stale,
    `this MCP server runs a superseded runtime (${packageRoot()}) - restart the MCP client to load ${NEWER_VERSION}`,
  );
});

test("a foreground runner always registers under its own tree, whatever runtime is installed", async (t) => {
  const env = makeHome(t, "spawn-root-foreground-own-tree");
  writeVersion(env, NEWER_VERSION);
  switchCurrent(env, NEWER_VERSION);

  const guard = await registerForegroundRunner({ env, killImpl: () => true });
  assert.equal(guard.registered, true);
  assert.equal(registration(process.pid, env).runtimeDir, packageRoot());
});
