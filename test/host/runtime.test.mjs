import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { legacyShimPath, runtimePackageDir, shimPath } from "../../src/config/paths.mjs";
import { hostPackageRoot } from "../../src/host/paths.mjs";
import {
  legacyShimState,
  packageVersion,
  registrySpec,
  removeLegacyShim,
  removeShim,
  removeShims,
  runtimeReady,
  runtimeVersion,
  shimContent,
  shimState,
  writeShim,
  writeShims,
} from "../../src/host/runtime.mjs";
import { makeDir } from "../../test-support/memory.mjs";

// Environment of an empty configuration home, with nothing installed in it yet.
function makeEnv(t, name) {
  return { NIGHTSHIFT_HOME: join(makeDir(t, name), "home") };
}

// Writes a package.json fixture into the runtime prefix, the way an npm install would leave it.
function installRuntime(env, version) {
  const dir = runtimePackageDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "nightshift", version })}\n`);
  return dir;
}

// Permission bits of a file on disk.
function fileMode(path) {
  return statSync(path).mode & 0o777;
}

test("the running version comes from this package and an empty prefix has no version at all", (t) => {
  const env = makeEnv(t, "runtime-version");
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(runtimeVersion(env), null);
  assert.equal(runtimeReady(env), false);

  installRuntime(env, "9.9.9");
  assert.equal(runtimeVersion(env), "9.9.9");
  assert.equal(runtimeReady(env), true);
});

test("a runtime whose package.json is broken reads as absent instead of throwing", (t) => {
  const env = makeEnv(t, "runtime-broken");
  const dir = runtimePackageDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), "{ not json");
  assert.equal(runtimeVersion(env), null);
  assert.equal(runtimeReady(env), true, "the file is there, only its content is unreadable");
});

test("the registry specifier names the package and the version asked for, defaulting to the newest one", () => {
  assert.equal(registrySpec("1.2.3"), "nightshift@1.2.3");
  assert.equal(registrySpec(), "nightshift@latest");
  assert.equal(registrySpec(""), "nightshift@latest");
});

test("the shim is executable, points at the runtime and survives a space in the path", (t) => {
  const env = makeEnv(t, "runtime-shim");
  const created = writeShim(env);
  assert.equal(created.status, "created");
  assert.equal(created.path, shimPath(env));
  assert.equal(fileMode(created.path), 0o755);
  const content = readFileSync(created.path, "utf8");
  assert.equal(content, shimContent(env));
  assert.equal(content.includes(`"${join(hostPackageRoot(env), "bin", "nightshift.mjs")}"`), true, content);
  assert.match(content, /^#!\/bin\/sh\n/);

  const spaced = { NIGHTSHIFT_HOME: join(makeDir(t, "runtime shim spaced"), "home") };
  assert.match(shimContent(spaced), /exec node "\/.*shim spaced.*\/bin\/nightshift\.mjs" "\$@"/);
});

test("a second write changes nothing, and a shim left without the execute bit is rewritten", (t) => {
  const env = makeEnv(t, "runtime-shim-idempotent");
  writeShim(env);
  assert.equal(writeShim(env).status, "already present");

  chmodSync(shimPath(env), 0o644);
  assert.equal(shimState(env).executable, false);
  assert.equal(writeShim(env).status, "updated");
  assert.equal(fileMode(shimPath(env)), 0o755);
  assert.equal(writeShim(env).status, "already present");
});

test("a shim pointing somewhere else is rewritten, and a shim of another tool is never deleted", (t) => {
  const env = makeEnv(t, "runtime-shim-foreign");
  writeShim(env);
  writeFileSync(shimPath(env), "#!/bin/sh\nexec node /somewhere/else/bin/nightshift.mjs \"$@\"\n");
  assert.equal(shimState(env).current, false);
  assert.equal(removeShim(env).status, "kept");
  assert.equal(existsSync(shimPath(env)), true);

  assert.equal(writeShim(env).status, "updated");
  assert.equal(removeShim(env).status, "removed");
  assert.equal(existsSync(shimPath(env)), false);
  assert.equal(removeShim(env).status, "not present");
});

test("writeShims writes the three command names, and --no-shortcuts writes only the canonical one", (t) => {
  const env = makeEnv(t, "runtime-shims");
  assert.deepEqual(
    writeShims(env).map((shim) => shim.name),
    ["nightshift", "nshift", "nsft"],
  );
  for (const name of ["nightshift", "nshift", "nsft"]) {
    assert.equal(readFileSync(shimPath(env, name), "utf8"), shimContent(env));
    assert.equal(fileMode(shimPath(env, name)), 0o755);
  }

  const lean = makeEnv(t, "runtime-shims-lean");
  assert.deepEqual(
    writeShims(lean, { shortcuts: false }).map((shim) => shim.name),
    ["nightshift"],
  );
  assert.equal(existsSync(shimPath(lean, "nshift")), false);
  assert.equal(existsSync(shimPath(lean, "nsft")), false);
});

test("removeShims takes out every command name, even the shortcuts a --no-shortcuts install never wrote", (t) => {
  const env = makeEnv(t, "runtime-shims-remove");
  writeShims(env, { shortcuts: false });
  assert.deepEqual(
    removeShims(env).map((shim) => shim.status),
    ["removed", "not present", "not present"],
  );
  assert.equal(existsSync(shimPath(env, "nightshift")), false);
});

test("the shim of the previous command name is removed by its shape, and a file of another tool is kept", (t) => {
  const env = makeEnv(t, "runtime-legacy-shim");
  const path = legacyShimPath(env);
  assert.equal(legacyShimState(env).present, false);
  assert.equal(removeLegacyShim(env).status, "not present");

  mkdirSync(join(env.NIGHTSHIFT_HOME, "bin"), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexec node "/some/old/home/runtime/node_modules/nightshift/bin/shift.mjs" "$@"\n');
  assert.deepEqual(legacyShimState(env), { path, present: true, own: true });
  assert.equal(removeLegacyShim(env).status, "removed");
  assert.equal(existsSync(path), false);

  writeFileSync(path, "#!/bin/sh\necho other-tool\n");
  assert.equal(legacyShimState(env).own, false);
  assert.equal(removeLegacyShim(env).status, "kept");
  assert.equal(readFileSync(path, "utf8"), "#!/bin/sh\necho other-tool\n");

  const foreign = '#!/bin/sh\nexec node "/opt/some-other-tool/bin/shift.mjs" "$@"\n';
  writeFileSync(path, foreign);
  assert.equal(legacyShimState(env).own, false, "a shim of another tool must never look like ours");
  assert.equal(removeLegacyShim(env).status, "kept");
  assert.equal(readFileSync(path, "utf8"), foreign);
});
