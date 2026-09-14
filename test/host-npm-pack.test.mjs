import assert from "node:assert/strict";
import { test } from "node:test";
import { npmPack, parsePackOutput } from "../src/host/npm.mjs";

const ENTRY = { id: "@maykonv/nightshift@0.2.0", name: "@maykonv/nightshift", version: "0.2.0", filename: "maykonv-nightshift-0.2.0.tgz", unpackedSize: 960989, files: [] };

test("the pack output is read in the array shape of npm 10/11 and in the keyed-object shape of npm 12", () => {
  assert.deepEqual(parsePackOutput(JSON.stringify([ENTRY])), ENTRY);
  assert.deepEqual(parsePackOutput(JSON.stringify({ "@maykonv/nightshift": ENTRY })), ENTRY);
});

test("an output that describes no tarball reads as none, never as a crash", () => {
  assert.equal(parsePackOutput(""), null);
  assert.equal(parsePackOutput("not json"), null);
  assert.equal(parsePackOutput("[]"), null);
  assert.equal(parsePackOutput("{}"), null);
  assert.equal(parsePackOutput(JSON.stringify([{ name: "x" }])), null);
  assert.equal(parsePackOutput(JSON.stringify({ x: { name: "x" } })), null);
  assert.equal(parsePackOutput(JSON.stringify({ x: 3 })), null);
  assert.equal(parsePackOutput(null), null);
});

test("npmPack resolves the tarball path from either shape, and declares a failure on neither", () => {
  const spawnWith = (stdout) => () => ({ status: 0, stdout, stderr: "" });
  const array = npmPack({ dir: "/src", destDir: "/dest", spawnSyncImpl: spawnWith(JSON.stringify([ENTRY])) });
  const keyed = npmPack({ dir: "/src", destDir: "/dest", spawnSyncImpl: spawnWith(JSON.stringify({ "@maykonv/nightshift": ENTRY })) });
  assert.equal(array.ok, true);
  assert.equal(keyed.ok, true);
  assert.equal(array.file, keyed.file);
  assert.match(array.file, /maykonv-nightshift-0\.2\.0\.tgz$/);
  const none = npmPack({ dir: "/src", destDir: "/dest", spawnSyncImpl: spawnWith("{}") });
  assert.equal(none.ok, false);
  assert.equal(none.file, null);
  assert.match(none.stderr, /printed no tarball name/);
});
