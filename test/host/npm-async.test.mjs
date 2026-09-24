import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runNpmAsync } from "../../src/host/npm.mjs";

// An in-process child double that prints the given chunks and exits with the given code, unless it is told to hang.
function fakeSpawn({ chunks = [], code = 0, hang = false, calls = [] } = {}) {
  return (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => setImmediate(() => child.emit("close", null, signal));
    calls.push({ file, args, options });
    setImmediate(() => {
      for (const chunk of chunks) child.stdout.emit("data", Buffer.from(chunk));
      if (!hang) child.emit("close", code);
    });
    return child;
  };
}

test("runNpmAsync keeps the tail of the output, echoes it, and answers the exit code without rejecting", async () => {
  const calls = [];
  const echoed = [];
  const big = "x".repeat(9000);
  const result = await runNpmAsync(["test"], { cwd: "/work", env: { NIGHTQUEUE_NPM_BIN: "fake-npm" }, spawnImpl: fakeSpawn({ chunks: [big, "\nnot ok 1"], code: 1, calls }), echo: (text) => echoed.push(text) });
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
  assert.equal(result.timedOut, false);
  assert.equal(result.output.length, 8192);
  assert.ok(result.output.endsWith("\nnot ok 1"));
  assert.equal(echoed.join(""), `${big}\nnot ok 1`);
  assert.equal(calls[0].file, "fake-npm");
  assert.deepEqual(calls[0].args, ["test"]);
  assert.equal(calls[0].options.cwd, "/work");
});

test("runNpmAsync kills a suite that outlives its timeout and says so", async () => {
  const result = await runNpmAsync(["test"], { env: {}, timeoutMs: 20, spawnImpl: fakeSpawn({ hang: true }), echo: () => {} });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
});

test("runNpmAsync answers a spawn that throws as a failed result", async () => {
  const throwing = () => {
    throw Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" });
  };
  const result = await runNpmAsync(["test"], { env: {}, spawnImpl: throwing, echo: () => {} });
  assert.deepEqual(result, { ok: false, status: null, missing: true, output: "spawn npm ENOENT", timedOut: false });
});
