import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { PACKAGE_NAME, runtimeDir, runtimePackageDir } from "../src/config/paths.mjs";
import { cliEntryPath } from "../src/host/paths.mjs";
import { makeDir } from "../test-support/memory.mjs";

const NPM_TIMEOUT_MS = 120000;

// Environment that keeps one npm call inside the temporary directory: own home, own cache, own config and a registry no request can reach.
function offlineNpmEnv(dir) {
  return {
    ...process.env,
    HOME: join(dir, "npm-home"),
    npm_config_cache: join(dir, "npm-cache"),
    npm_config_userconfig: join(dir, "npmrc"),
    npm_config_registry: "http://127.0.0.1:1/",
  };
}

// Minimal package that declares the name of this one and no dependency at all, so installing it never needs the network.
function writeFixturePackage(dir) {
  const entry = join(dir, "bin", "nightshift.mjs");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o755 });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0", bin: { nightshift: "bin/nightshift.mjs" } }, null, 2)}\n`,
  );
  return dir;
}

test("npm installs this package under the directory the path resolution derives from its declared name", (t) => {
  const base = makeDir(t, "runtime-layout");
  const pkgDir = writeFixturePackage(join(base, "package"));
  const env = offlineNpmEnv(base);

  const packed = spawnSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--loglevel", "error", "--pack-destination", base, pkgDir],
    { encoding: "utf8", env, timeout: NPM_TIMEOUT_MS },
  );
  if (packed.error || packed.status !== 0) return t.skip("npm did not answer `pack`");
  const entry = JSON.parse(packed.stdout)[0];
  assert.equal(entry.name, PACKAGE_NAME, "npm packed a name this package does not declare");

  const home = { NIGHTSHIFT_HOME: join(base, "home") };
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      runtimeDir(home),
      "--offline",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--loglevel",
      "error",
      join(base, entry.filename),
    ],
    { encoding: "utf8", env, timeout: NPM_TIMEOUT_MS },
  );
  assert.equal(installed.status, 0, installed.stderr);

  assert.ok(existsSync(join(runtimePackageDir(home), "package.json")), "the installed package is not where the path resolution looks for it");
  assert.ok(existsSync(cliEntryPath(home)), "the CLI entry the host is registered against is not the file npm installed");
  assert.equal(
    existsSync(join(runtimeDir(home), "node_modules", "nightshift")),
    false,
    "npm installed the unscoped layout, so a path resolution went back to the hardcoded name",
  );
});
