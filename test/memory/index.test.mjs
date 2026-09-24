import assert from "node:assert/strict";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { recallProjectIndex, saveProjectIndex } from "../../src/memory/index.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// Creates a file inside the repository, with its parent directories.
function writeRepoFile(repoRoot, relative, content) {
  const absolute = join(repoRoot, relative);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
  return absolute;
}

// Freshness of one indexed path, as the recall reports it.
function fileOf(index, path) {
  return index.files.find((file) => file.path === path);
}

test("the index upserts by path and by lib instead of stacking rows", (t) => {
  const env = makeHome(t, "index-upsert");
  const repo = makeProject(t, env, "alpha");
  writeRepoFile(repo, "src/a.mjs", "export const a = 1;\n");

  saveProjectIndex(
    {
      project: "alpha",
      repoRoot: repo,
      files: [{ path: "src/a.mjs", responsibility: "first responsibility" }],
      libs: [{ lib: "zod", version: "3.0.0" }],
    },
    env,
  );
  const second = saveProjectIndex(
    {
      project: "alpha",
      repoRoot: repo,
      files: [{ path: "src/a.mjs", responsibility: "second responsibility" }],
      libs: [{ lib: "zod", version: "4.5.4" }],
    },
    env,
  );
  assert.deepEqual(second, { files: 1, libs: 1 });

  const index = recallProjectIndex({ project: "alpha", repoRoot: repo }, env);
  assert.equal(index.files.length, 1);
  assert.equal(index.files[0].responsibility, "second responsibility");
  assert.deepEqual(
    index.libs.map((lib) => [lib.lib, lib.version]),
    [["zod", "4.5.4"]],
  );
});

test("an absolute path inside the repository is stored relative to its root", (t) => {
  const env = makeHome(t, "index-relative");
  const repo = makeProject(t, env, "alpha");
  const absolute = writeRepoFile(repo, "src/a.mjs", "export const a = 1;\n");
  saveProjectIndex(
    { project: "alpha", repoRoot: repo, files: [{ path: absolute, responsibility: "the module" }] },
    env,
  );
  const index = recallProjectIndex({ project: "alpha", repoRoot: repo }, env);
  assert.deepEqual(
    index.files.map((file) => file.path),
    ["src/a.mjs"],
  );
});

test("the recall reports the real freshness of every indexed file", (t) => {
  const env = makeHome(t, "index-freshness");
  const repo = makeProject(t, env, "alpha");
  writeRepoFile(repo, "src/untouched.mjs", "export const a = 1;\n");
  const changed = writeRepoFile(repo, "src/changed.mjs", "export const b = 1;\n");
  const removed = writeRepoFile(repo, "src/removed.mjs", "export const c = 1;\n");
  saveProjectIndex(
    {
      project: "alpha",
      repoRoot: repo,
      files: [
        { path: "src/untouched.mjs", responsibility: "stable module" },
        { path: "src/changed.mjs", responsibility: "module that moves" },
        { path: "src/removed.mjs", responsibility: "module that disappears" },
      ],
    },
    env,
  );
  const future = new Date(Date.now() + 60000);
  utimesSync(changed, future, future);
  rmSync(removed);

  const index = recallProjectIndex({ project: "alpha", repoRoot: repo }, env);
  assert.deepEqual(fileOf(index, "src/untouched.mjs"), {
    path: "src/untouched.mjs",
    responsibility: "stable module",
    updated_at: fileOf(index, "src/untouched.mjs").updated_at,
    missing: false,
    stale: false,
  });
  assert.equal(fileOf(index, "src/changed.mjs").stale, true);
  assert.equal(fileOf(index, "src/changed.mjs").missing, false);
  assert.equal(fileOf(index, "src/removed.mjs").missing, true);
  assert.equal(fileOf(index, "src/removed.mjs").stale, true);
});

test("the index query matches both the path and the responsibility", (t) => {
  const env = makeHome(t, "index-query");
  const repo = makeProject(t, env, "alpha");
  writeRepoFile(repo, "src/queue.mjs", "export const q = 1;\n");
  writeRepoFile(repo, "src/report.mjs", "export const r = 1;\n");
  saveProjectIndex(
    {
      project: "alpha",
      repoRoot: repo,
      files: [
        { path: "src/queue.mjs", responsibility: "runs the jobs" },
        { path: "src/report.mjs", responsibility: "renders the invoice" },
      ],
    },
    env,
  );
  assert.deepEqual(
    recallProjectIndex({ project: "alpha", repoRoot: repo, query: "queue" }, env).files.map((file) => file.path),
    ["src/queue.mjs"],
  );
  assert.deepEqual(
    recallProjectIndex({ project: "alpha", repoRoot: repo, query: "invoice" }, env).files.map((file) => file.path),
    ["src/report.mjs"],
  );
});

test("an unregistered project cannot be indexed and recalls nothing", (t) => {
  const env = makeHome(t, "index-unregistered");
  assert.throws(
    () =>
      saveProjectIndex(
        { project: "ghost", repoRoot: "/tmp", files: [{ path: "src/a.mjs", responsibility: "the module" }] },
        env,
      ),
    (err) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /project `ghost` is not registered; run `nightqueue init`/);
      return true;
    },
  );
  assert.deepEqual(recallProjectIndex({ project: "ghost" }, env), { files: [], libs: [] });
});
