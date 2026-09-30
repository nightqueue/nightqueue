import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ensureProject, makeHome } from "../test-support/memory.mjs";
import { makeSickHome, makeUnreadableHome, unreadableSkip } from "../test-support/sick-home.mjs";

const CLI = fileURLToPath(new URL("../bin/nightqueue.mjs", import.meta.url));

test("queue status on fixture (iii) exits 1 with exactly one stderr line and no stack", (t) => {
  const env = makeHome(t, "cli-store-unavailable");
  ensureProject(env, "alpha");
  makeSickHome(env);
  const result = spawnSync(process.execPath, [CLI, "queue", "status"], { env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stderr.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 1, result.stderr);
  assert.match(lines[0], /^nightqueue: the nightqueue database at .+ is unavailable \(SQLITE_NOTADB: file is not a database\); run `nightqueue doctor --fix`$/);
  assert.doesNotMatch(result.stderr, /\n\s+at /, "a stack trace leaked");
});

test("queue status on a database it cannot open (CANTOPEN) exits 1 with exactly one stderr line", { skip: unreadableSkip() }, (t) => {
  const env = makeHome(t, "cli-store-cantopen");
  ensureProject(env, "alpha");
  makeUnreadableHome(t, env);
  const result = spawnSync(process.execPath, [CLI, "queue", "status"], { env, encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const lines = result.stderr.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 1, result.stderr);
  assert.match(lines[0], /^nightqueue: the nightqueue database at .+ is unavailable \(SQLITE_CANTOPEN: unable to open database file\); run `nightqueue doctor --fix`$/);
});
