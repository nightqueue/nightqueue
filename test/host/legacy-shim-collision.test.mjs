import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { assertIsolatedEnv, makeHostEnv, writeLegacyShim } from "../../test-support/host.mjs";

// A shim named `shift` that belongs to a wholly different tool, but happens to end in `/bin/shift.mjs`, must survive setup.
test("a third-party shim that only coincidentally matches our legacy shape is kept, never deleted", async (t) => {
  const host = makeHostEnv(t, "legacy-shim-collision");
  const foreign = '#!/bin/sh\nexec node "/opt/some-other-tool/bin/shift.mjs" "$@"\n';
  writeLegacyShim(host, foreign);
  const out = [];
  const ctx = {
    ...defaultContext(),
    env: assertIsolatedEnv(host.env),
    out: (line) => out.push(line),
    err: (line) => out.push(line),
    stdin: { isTTY: false },
    stdout: new PassThrough(),
  };

  assert.equal(await run(["setup", "--no-path", "--no-embedding"], ctx), 0);
  assert.equal(existsSync(host.legacyShim), true);
  assert.equal(readFileSync(host.legacyShim, "utf8"), foreign);
  assert.ok(out.includes(`legacy shim: kept (${host.legacyShim} was not written by nightshift)`), out.join("\n"));
});
