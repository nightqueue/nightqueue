import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import {
  LEGACY_RUNTIME_PACKAGE_TRAIL,
  resolvedRuntimeDir,
  runtimePackageDir,
} from "../src/config/paths.mjs";
import { hostManifestPath } from "../src/host/paths.mjs";
import { legacyShimState, runtimeReady, runtimeVersion, shimContent } from "../src/host/runtime.mjs";
import { writeRunnerPidfile } from "../src/queue/pidfile.mjs";
import { assertIsolatedEnv, makeHostEnv, readSettingsFile } from "../test-support/host.mjs";

const SETUP = ["setup", "--no-path", "--no-embedding"];
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

// Context that captures the output and refuses to run against anything but an isolated environment.
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

// Names of the version directories on disk, staging prefixes included so a leftover is visible.
function versionNames(host) {
  return existsSync(host.runtimeVersions) ? readdirSync(host.runtimeVersions).sort() : [];
}

// A version directory of an install nobody remembers, old enough to be the first one pruned.
function writeOldVersion(host, name) {
  const dir = join(host.runtimeVersions, name);
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  const old = new Date("2020-01-01T00:00:00Z");
  utimesSync(dir, old, old);
  return dir;
}

// A home whose runtime still sits where an installation before the versioned layout wrote it.
function writeLegacyRuntime(host, version) {
  const dir = join(host.home, LEGACY_RUNTIME_PACKAGE_TRAIL);
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "@maykonv/nightshift", version })}\n`);
  writeFileSync(join(dir, "bin", "nightshift.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
  return dir;
}

test("an install writes a version directory of its own and `current` is a relative link onto it", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-layout");
  const { ctx, err } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0, err.join("\n"));
  const names = versionNames(host);
  assert.equal(names.length, 1, names.join(", "));
  assert.match(names[0], new RegExp(`^${VERSION}-\\d{8}T\\d{6}Z$`));
  assert.equal(lstatSync(host.runtimeCurrent).isSymbolicLink(), true, "`current` is not a link");
  assert.equal(readlinkSync(host.runtimeCurrent), join("versions", names[0]));
  assert.equal(resolvedRuntimeDir(host.env), realpathSync(join(host.runtimeVersions, names[0])));
  assert.equal(existsSync(join(host.runtimePackage, "package.json")), true);
});

test("every host entry point resolves through `current`, never through a version directory", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-host");
  const { ctx, err } = makeCtx(host.env);

  assert.equal(await run(SETUP, ctx), 0, err.join("\n"));
  assert.equal(host.entry.startsWith(join(host.runtimeCurrent, "node_modules")), true, host.entry);
  assert.equal(readFileSync(host.shim, "utf8"), `#!/bin/sh\nexec node "${host.entry}" "$@"\n`);
  assert.equal(shimContent(host.env), `#!/bin/sh\nexec node "${host.entry}" "$@"\n`);
  assert.equal(
    readSettingsFile(host.configDir).hooks.SessionStart[0].hooks[0].command,
    `node ${host.entry} hook session-start`,
  );
  const registered = JSON.parse(readFileSync(join(host.configDir, ".claude.json"), "utf8"));
  assert.deepEqual(registered.mcpServers.nightshift.args, [host.entry, "mcp"]);
  assert.equal(existsSync(hostManifestPath(host.env)), true, "the marketplace manifest is not reachable through `current`");
});

test("a reinstall leaves the directory the running process loaded from untouched and only moves the link", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-reinstall");
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  const loaded = resolvedRuntimeDir(host.env);
  const witness = join(loaded, "loaded-by-a-live-process");
  writeFileSync(witness, "still running\n");

  const { ctx, err } = makeCtx(host.env);
  assert.equal(await run(["update"], ctx), 0, err.join("\n"));
  assert.equal(existsSync(witness), true, "the reinstall overwrote the tree a live process loaded from");
  assert.notEqual(resolvedRuntimeDir(host.env), loaded, "the install never moved `current` onto the new version");
  assert.equal(versionNames(host).length, 2, versionNames(host).join(", "));
});

test("old versions are pruned to the last two, and never the one `current` names", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-prune");
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  const first = resolvedRuntimeDir(host.env);
  for (const name of ["0.0.1-20200101T000000Z", "0.0.2-20200102T000000Z"]) writeOldVersion(host, name);
  assert.equal(versionNames(host).length, 3);

  const { ctx, err } = makeCtx(host.env);
  assert.equal(await run(["update"], ctx), 0, err.join("\n"));
  const names = versionNames(host);
  assert.equal(names.length, 2, names.join(", "));
  assert.ok(names.includes(basename(resolvedRuntimeDir(host.env))), `\`current\` was pruned: ${names.join(", ")}`);
  assert.ok(names.includes(basename(first)), `the version a process may still run from was pruned: ${names.join(", ")}`);
  assert.equal(existsSync(join(host.runtimeVersions, "0.0.1-20200101T000000Z")), false);
  assert.equal(existsSync(join(host.runtimeVersions, "0.0.2-20200102T000000Z")), false);
});

test("the version a live runner recorded survives the prune, whatever its age", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-prune-live");
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  const stale = writeOldVersion(host, "0.0.1-20200101T000000Z");
  const live = writeOldVersion(host, "0.0.2-20200102T000000Z");
  writeRunnerPidfile({ pid: process.pid, startedAt: new Date().toISOString(), mode: "drain", runtimeDir: live }, host.env);

  const { ctx, err } = makeCtx(host.env);
  assert.equal(await run(["update", "--force"], ctx), 0, err.join("\n"));
  assert.equal(existsSync(live), true, `the directory the live runner runs from was pruned: ${versionNames(host).join(", ")}`);
  assert.equal(existsSync(stale), false);
});

test("an install npm could not finish leaves `current` where it was and no staging directory behind", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-failed");
  assert.equal(await run(SETUP, makeCtx(host.env).ctx), 0);
  const before = resolvedRuntimeDir(host.env);

  host.env.NIGHTSHIFT_FAKE_NPM_EXIT = "1";
  const { ctx, out } = makeCtx(host.env);
  assert.equal(await run(["update"], ctx), 1);
  assert.ok(out.some((line) => line.startsWith("runtime: failed")), out.join("\n"));
  assert.equal(resolvedRuntimeDir(host.env), before, "a failed install moved `current`");
  assert.deepEqual(versionNames(host), [basename(before)], versionNames(host).join(", "));
});

test("a runtime still at the path of an older installation keeps resolving, and an install moves the host onto `current`", async (t) => {
  const host = makeHostEnv(t, "runtime-versions-legacy");
  const legacy = writeLegacyRuntime(host, "0.0.9");
  const legacyEntry = join(legacy, "bin", "nightshift.mjs");

  assert.equal(runtimePackageDir(host.env), legacy);
  assert.equal(runtimeReady(host.env), true);
  assert.equal(runtimeVersion(host.env), "0.0.9");
  assert.equal(shimContent(host.env), `#!/bin/sh\nexec node "${legacyEntry}" "$@"\n`);
  mkdirSync(host.binDir, { recursive: true });
  writeFileSync(join(host.binDir, "shift"), `#!/bin/sh\nexec node "${join(legacy, "bin", "shift.mjs")}" "$@"\n`, { mode: 0o755 });
  assert.deepEqual(legacyShimState(host.env), { path: join(host.binDir, "shift"), present: true, own: true });

  const { ctx, err } = makeCtx(host.env);
  assert.equal(await run(SETUP, ctx), 0, err.join("\n"));
  assert.equal(existsSync(join(legacy, "package.json")), true, "the install deleted the tree an older installation may still run");
  assert.equal(runtimePackageDir(host.env), host.runtimePackage);
  assert.equal(readFileSync(host.shim, "utf8"), `#!/bin/sh\nexec node "${host.entry}" "$@"\n`);
});
