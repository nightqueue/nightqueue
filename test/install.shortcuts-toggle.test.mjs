import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../src/cli/index.mjs";
import { shimContent } from "../src/host/runtime.mjs";
import { assertIsolatedEnv, makeHostEnv } from "../test-support/host.mjs";

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

// H1a: turning shortcuts back on after a --no-shortcuts install must create nq.
test("setup --no-shortcuts then setup without the flag turns the shortcuts on", async (t) => {
  const host = makeHostEnv(t, "shortcuts-toggle-on");
  const first = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding", "--no-shortcuts"], first.ctx), 0);
  assert.equal(existsSync(host.shims.nq), false);

  const second = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], second.ctx), 0);

  for (const name of ["nq"]) {
    const path = host.shims[name];
    assert.equal(existsSync(path), true, `${name} should exist after re-enabling shortcuts`);
    assert.equal(statSync(path).mode & 0o111, 0o111, `${name} should be executable`);
    assert.equal(readFileSync(path, "utf8"), shimContent(host.env));
    assert.ok(second.out.includes(`shim ${name}: created (${path})`), second.out.join("\n"));
  }
});

// H1b: --no-shortcuts must never delete shortcuts already written by a previous setup.
test("setup then setup --no-shortcuts keeps nq on disk untouched", async (t) => {
  const host = makeHostEnv(t, "shortcuts-toggle-off");
  const first = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding"], first.ctx), 0);
  for (const name of ["nq"]) assert.equal(existsSync(host.shims[name]), true);

  const before = {
    nq: statSync(host.shims.nq).mtimeMs,
  };

  const second = makeCtx(host.env);
  assert.equal(await run(["setup", "--no-path", "--no-embedding", "--no-shortcuts"], second.ctx), 0);

  for (const name of ["nq"]) {
    const path = host.shims[name];
    assert.equal(existsSync(path), true, `${name} must not be removed by --no-shortcuts`);
    assert.equal(readFileSync(path, "utf8"), shimContent(host.env));
    assert.equal(statSync(path).mtimeMs, before[name], `${name} must be left untouched`);
  }
  assert.ok(second.out.includes("shim shortcuts: skipped (--no-shortcuts)"), second.out.join("\n"));
});
