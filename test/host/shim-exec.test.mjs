// H2a (group H2): real execution proof of the shim written by `writeShim`, with and without
// a space in NIGHTSHIFT_HOME. `shimContent`/`shimState` were only exercised as strings
// (test/host/runtime.test.mjs:63-75); this test runs `sh <shim>` for real, through
// `/bin/sh`, against a real CLI materialized inside the isolated runtime.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runtimePackageDir, shimPath } from "../../src/config/paths.mjs";
import { writeShim } from "../../src/host/runtime.mjs";
import { makeDir } from "../../test-support/memory.mjs";

const CHECKOUT_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Materializes a real `bin/shift.mjs` inside the runtime prefix, the same way the real
// `npm install` would leave it (mirrors test-support/fake-npm.mjs#installNightshift),
// but pointed straight at this checkout's CLI so no network/npm is involved at all.
function installRealCli(env) {
  const dir = runtimePackageDir(env);
  const entry = join(dir, "bin", "shift.mjs");
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(
    entry,
    [
      "#!/usr/bin/env node",
      `import { run } from ${JSON.stringify(join(CHECKOUT_ROOT, "src", "cli", "index.mjs"))};`,
      "process.exitCode = await run(process.argv.slice(2));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return entry;
}

// Writes the shim of an isolated home (its path may contain a space) and runs it for real
// through `/bin/sh`, returning exit code, stdout and stderr the way a user's shell would see them.
function runShim(t, name, args) {
  const home = join(makeDir(t, name), "home");
  const env = { NIGHTSHIFT_HOME: home };
  installRealCli(env);
  const shim = writeShim(env);
  assert.equal(shim.status, "created");
  assert.equal(shimPath(env), shim.path);

  const result = spawnSync("/bin/sh", [shim.path, ...args], {
    env: { PATH: process.env.PATH ?? "", NIGHTSHIFT_HOME: home },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined, `sh failed to spawn: ${result.error}`);
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("the shim runs the real CLI through sh, with and without a space in the home path", (t) => {
  const plain = runShim(t, "shim-exec-plain", ["--help"]);
  const spaced = runShim(t, "shim exec spaced", ["--help"]);

  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(spaced.code, 0, spaced.stderr);
  assert.match(plain.stdout, /^shift — nightshift configuration/);
  assert.equal(spaced.stdout, plain.stdout, "a space in NIGHTSHIFT_HOME must not change what the shim prints");
});

test("the shim forwards argv byte for byte through $@, including an argument that itself has a space", (t) => {
  const plain = runShim(t, "shim-argv-plain", ["mystery-command", "an argument with spaces"]);
  const spaced = runShim(t, "shim argv spaced", ["mystery-command", "an argument with spaces"]);

  assert.equal(plain.code, 1);
  assert.equal(spaced.code, 1);
  assert.match(plain.stderr, /unknown command `mystery-command`/);
  assert.equal(spaced.stderr, plain.stderr, "a space in NIGHTSHIFT_HOME must not change argv forwarding");
});
