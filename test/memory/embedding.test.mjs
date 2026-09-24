import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { run as embedCommand } from "../../src/cli/embed.mjs";
import { UserError } from "../../src/config/errors.mjs";
import { modelsDir } from "../../src/config/paths.mjs";
import { isModelCached } from "../../src/memory/embedding.mjs";
import { saveLesson } from "../../src/memory/lessons.mjs";
import { recallLessons } from "../../src/memory/search.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

test("with an empty weight cache the recall answers lexically and downloads nothing", async (t) => {
  const env = makeHome(t, "embedding-cold", { embed: true });
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
  assert.equal(isModelCached(env), false);

  const rows = await recallLessons(
    { query: "the worker leaks a file descriptor when the run fails", project: "alpha" },
    env,
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    [id],
  );
  assert.deepEqual(
    rows.map((row) => row.via),
    ["lexical"],
  );
  assert.equal(isModelCached(env), false);
  assert.equal(existsSync(modelsDir(env)), false);
});

test("the backfill refuses to run before the weights are on disk, and never fetches them itself", async (t) => {
  const env = makeHome(t, "embedding-backfill", { embed: true });
  const ctx = { env, out: () => {}, err: () => {} };
  await assert.rejects(embedCommand(["backfill"], ctx), (err) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /no model weight in .*models; run `nightqueue embed download` first/);
    return true;
  });
  assert.equal(existsSync(modelsDir(env)), false);
});
