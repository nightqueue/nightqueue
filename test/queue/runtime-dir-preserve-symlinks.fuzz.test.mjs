import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { makeDir } from "../../test-support/memory.mjs";

const HOST_PATHS_SOURCE = fileURLToPath(new URL("../../src/host/paths.mjs", import.meta.url));
const CONFIG_PATHS_SOURCE = fileURLToPath(new URL("../../src/config/paths.mjs", import.meta.url));
const PACKAGE_NAME = "@maykonv/nightshift";

const ENTRY_SOURCE = [
  'import { packageRoot } from "../src/host/paths.mjs";',
  "process.stdout.write(JSON.stringify({ packageRoot: packageRoot() }));",
  "",
].join("\n");

// Builds a versioned runtime layout (`current` -> `versions/<v>-<stamp>`) around the real, unmodified `packageRoot()` source, so a spawned child exercises the actual production code, not a reimplementation.
function buildVersionedRuntime(t) {
  const base = makeDir(t, "preserve-symlinks");
  const stamp = `1.0.0-${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const versionDir = join(base, "runtime", "versions", stamp);
  const packageDir = join(versionDir, "node_modules", PACKAGE_NAME);
  mkdirSync(join(packageDir, "src", "host"), { recursive: true });
  mkdirSync(join(packageDir, "src", "config"), { recursive: true });
  mkdirSync(join(packageDir, "bin"), { recursive: true });
  writeFileSync(join(packageDir, "src", "host", "paths.mjs"), readFileSync(HOST_PATHS_SOURCE));
  writeFileSync(join(packageDir, "src", "config", "paths.mjs"), readFileSync(CONFIG_PATHS_SOURCE));
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: "0.0.0-test" }));
  writeFileSync(join(packageDir, "bin", "entry.mjs"), ENTRY_SOURCE);
  const currentLink = join(base, "runtime", "current");
  symlinkSync(join("versions", stamp), currentLink);
  const entryPath = join(currentLink, "node_modules", PACKAGE_NAME, "bin", "entry.mjs");
  return { packageDir, entryPath };
}

// Spawns the entry as a real, separate node process, with `NODE_OPTIONS` fully controlled rather than inherited.
function runEntry(entryPath, nodeOptions) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  const result = spawnSync(process.execPath, [entryPath], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr || String(result.error ?? ""));
  return JSON.parse(result.stdout);
}

test("packageRoot() names the version directory by default, never the mutable `current` link", (t) => {
  const { packageDir, entryPath } = buildVersionedRuntime(t);
  const { packageRoot } = runEntry(entryPath, undefined);
  assert.equal(packageRoot, realpathSync(packageDir));
});

test("packageRoot() still names the version directory under NODE_OPTIONS=--preserve-symlinks alone (the plan's literal [P2] trigger)", (t) => {
  const { packageDir, entryPath } = buildVersionedRuntime(t);
  const { packageRoot } = runEntry(entryPath, "--preserve-symlinks");
  assert.equal(packageRoot, realpathSync(packageDir), "packageRoot must still name the version directory, not `current`");
});

test("packageRoot() silently degrades to the mutable `current` link under --preserve-symlinks together with --preserve-symlinks-main", (t) => {
  const { packageDir, entryPath } = buildVersionedRuntime(t);
  const { packageRoot } = runEntry(entryPath, "--preserve-symlinks --preserve-symlinks-main");
  assert.equal(
    packageRoot,
    realpathSync(packageDir),
    "packageRoot must name the version directory the process actually loaded, not the mutable `current` link",
  );
});
