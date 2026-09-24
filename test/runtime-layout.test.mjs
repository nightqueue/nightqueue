import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { finishVersion, stageInstall, switchCurrent, versionStamp } from "../src/cli/runtime-versions.mjs";
import { PACKAGE_NAME, runtimeCurrentLink, runtimePackageDir } from "../src/config/paths.mjs";
import { parsePackOutput } from "../src/host/npm.mjs";
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
  const entry = join(dir, "bin", "nightqueue.mjs");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(entry, "#!/usr/bin/env node\n", { mode: 0o755 });
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0", bin: { nightqueue: "bin/nightqueue.mjs" } }, null, 2)}\n`,
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
  const entry = parsePackOutput(packed.stdout);
  assert.ok(entry, `npm pack printed an output this build cannot read:\n${packed.stdout}`);
  assert.equal(entry.name, PACKAGE_NAME, "npm packed a name this package does not declare");

  const home = { NIGHTQUEUE_HOME: join(base, "home") };
  const stamp = versionStamp();
  const staging = stageInstall(home, stamp);
  const installed = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      staging,
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
  const versionDir = finishVersion(staging, "0.0.0", stamp);
  switchCurrent(versionDir, home);

  assert.ok(existsSync(join(runtimePackageDir(home), "package.json")), "the installed package is not where the path resolution looks for it");
  assert.ok(existsSync(cliEntryPath(home)), "the CLI entry the host is registered against is not the file npm installed");
  assert.equal(realpathSync(runtimeCurrentLink(home)), realpathSync(versionDir), "`current` does not name the version directory npm installed into");
  assert.equal(readlinkSync(runtimeCurrentLink(home)), join("versions", basename(versionDir)), "`current` is not a relative link, so a moved home stops resolving");
  assert.equal(
    realpathSync(runtimePackageDir(home)),
    realpathSync(join(versionDir, "node_modules", PACKAGE_NAME)),
    "the path resolution and npm disagree on where the declared package name lands",
  );
});
