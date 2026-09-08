import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { homeDir, runDir } from "../../src/config/paths.mjs";
import { discardRunDir } from "../../src/queue/resume.mjs";
import { makeDir, makeHome, makeProject } from "../../test-support/memory.mjs";

// Builds a foreign tree outside NIGHTSHIFT_HOME with a subdirectory named like the slug and a canary file inside it.
function makeForeignTree(t, slug) {
  const root = makeDir(t, "foreign-tree");
  const slugDir = join(root, slug);
  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, "important.txt"), "do not delete me\n");
  return { root, slugDir };
}

// Symlinks the intermediate "runs/<project>" directory to a foreign tree, so the leaf slug segment resolves through the link by the OS.
function symlinkProjectDir(env, project, target) {
  const runsDir = join(homeDir(env), "runs");
  mkdirSync(runsDir, { recursive: true });
  symlinkSync(target, join(runsDir, project));
}

test("discardRunDir never deletes content reached through a symlinked intermediate path component", (t) => {
  const env = makeHome(t, "retry-intermediate-symlink");
  makeProject(t, env, "alpha");
  const slug = "fix-the-worker";
  const { root: foreignRoot, slugDir: foreignSlugDir } = makeForeignTree(t, slug);
  symlinkProjectDir(env, "alpha", foreignRoot);

  const canary = join(foreignSlugDir, "important.txt");
  assert.equal(existsSync(canary), true, "setup failed: canary file missing before discardRunDir runs");

  const dirBeingResolved = runDir("alpha", slug, env);
  assert.equal(existsSync(dirBeingResolved), true, "setup failed: the symlinked path does not resolve to the foreign directory");

  discardRunDir({ project: "alpha", slug, env });

  assert.equal(
    existsSync(canary),
    true,
    "discardRunDir deleted content behind a symlinked intermediate path component (homeDir/runs/<project>)",
  );
});
