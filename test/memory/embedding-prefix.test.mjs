import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { UserError } from "../../src/config/errors.mjs";
import { embeddingDir } from "../../src/config/paths.mjs";
import {
  EMBEDDING_PACKAGE,
  EMBEDDING_PACKAGE_RANGE,
  embeddingLibraryDir,
  embeddingLibraryEntry,
  warmupModel,
} from "../../src/memory/embedding.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { recallLessons } from "../../src/memory/search.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

const ESM_FIXTURE = ["export const env = {};", "export const pipeline = async () => async () => ({ data: [] });", ""].join("\n");
const CJS_FIXTURE = ["module.exports.env = {};", "module.exports.pipeline = async () => async () => ({ data: [] });", ""].join("\n");

// Environment of an isolated home whose embedding prefix is empty.
function makeEnv(t, name) {
  return { NIGHTSHIFT_HOME: join(makeDir(t, name), "home") };
}

// Writes a library fixture into the isolated prefix, the way an npm install into it would.
function installFixture(env, { file, content, type }) {
  const dir = embeddingLibraryDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: EMBEDDING_PACKAGE, version: "4.2.0", main: file, type })}\n`);
  writeFileSync(join(dir, file), content);
  return dir;
}

test("an empty prefix resolves to nothing, and never climbs out of it to find a copy elsewhere", (t) => {
  const env = makeEnv(t, "embedding-prefix-empty");
  assert.equal(embeddingLibraryEntry(env), null);
  assert.equal(embeddingLibraryDir(env), join(embeddingDir(env), "node_modules", "@huggingface", "transformers"));
  assert.equal(EMBEDDING_PACKAGE_RANGE.startsWith("^4"), true);
});

test("a prefix whose copy is broken resolves to nothing, never to a copy living above the prefix", (t) => {
  const env = makeEnv(t, "embedding-prefix-broken");
  const dir = embeddingLibraryDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: EMBEDDING_PACKAGE, main: "never-written.mjs" })}\n`);

  const entry = embeddingLibraryEntry(env);
  assert.equal(entry, null, `a broken prefix answered ${entry}, which can only come from outside the prefix`);
});

test("the library is resolved from the prefix and loaded whether it ships ESM or CommonJS", async (t) => {
  const esm = makeEnv(t, "embedding-prefix-esm");
  const esmDir = installFixture(esm, { file: "index.mjs", content: ESM_FIXTURE, type: "module" });
  assert.equal(embeddingLibraryEntry(esm), join(realpathSync(esmDir), "index.mjs"));

  const cjs = makeEnv(t, "embedding-prefix-cjs");
  const cjsDir = installFixture(cjs, { file: "index.cjs", content: CJS_FIXTURE, type: "commonjs" });
  assert.equal(embeddingLibraryEntry(cjs), join(realpathSync(cjsDir), "index.cjs"));

  for (const env of [esm, cjs]) {
    await assert.rejects(warmupModel({ allowDownload: false }, env), (err) => {
      assert.equal(err instanceof UserError, false, "the fixture was loaded, so absence must not be the failure");
      assert.match(err.message, /model returned 0 dims/);
      return true;
    });
  }
});

test("a missing library is a user error pointing at the install command, never a stack", async (t) => {
  const env = makeEnv(t, "embedding-prefix-missing");
  await assert.rejects(warmupModel({ allowDownload: false }, env), (err) => {
    assert.ok(err instanceof UserError, `expected a UserError, got ${err?.name}`);
    assert.match(err.message, /is not installed in .*embedding; run `nightshift embed install`/);
    return true;
  });
});

test("a recall with an empty prefix answers lexically instead of failing", async (t) => {
  const env = makeHome(t, "embedding-prefix-recall", { embed: true });
  makeProject(t, env, "alpha");
  const { id } = saveLesson(
    {
      project: "alpha",
      title: "the worker leaks a file descriptor on failure",
      root_cause: "the early return skipped the close",
      solution: "close it in a finally block",
      prevention: "always close the file descriptor in a finally block",
    },
    env,
  );

  const rows = await recallLessons({ query: "the worker leaks a file descriptor", project: "alpha" }, env);
  assert.deepEqual(rows.map((row) => row.id), [id]);
  assert.deepEqual(rows.map((row) => row.via), ["lexical"]);
});
