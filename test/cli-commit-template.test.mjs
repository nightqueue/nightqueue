import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commitMessageProblems, findCommitTemplate } from "../src/cli/commit-template.mjs";
import { initGitRepo } from "../test-support/git.mjs";
import { makeDir } from "../test-support/memory.mjs";

const FALLBACK = { source: "nightqueue", path: null, label: "nightqueue (fallback)" };
const REPO = { source: "repo", path: null, label: "commitlint.config.js" };

// A git environment that reads no configuration of the machine, with its own home.
function hermeticEnv(home) {
  return { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
}

// A fresh repository and the hermetic environment to read it with.
function makeRepo(t, name) {
  const repo = initGitRepo(makeDir(t, name));
  return { repo, env: hermeticEnv(makeDir(t, `${name}-home`)) };
}

// Sets git's `commit.template` key in the repository's own config.
function setTemplateKey(repo, value) {
  execFileSync("git", ["-C", repo, "config", "commit.template", value]);
}

test("with nothing declared, the template is nightqueue's fallback", (t) => {
  const { repo, env } = makeRepo(t, "commit-template-fallback");
  assert.deepEqual(findCommitTemplate(repo, env), FALLBACK);
});

test("the repository's convention wins over the fallback, and only `.gitmessage` carries a path", (t) => {
  const { repo, env } = makeRepo(t, "commit-template-repo");
  writeFileSync(join(repo, ".gitmessage"), "type(scope): subject\n");
  assert.deepEqual(findCommitTemplate(repo, env), { source: "repo", path: join(repo, ".gitmessage"), label: ".gitmessage" });
  writeFileSync(join(repo, "commitlint.config.js"), "export default {};\n");
  assert.deepEqual(findCommitTemplate(repo, env), REPO);
});

test("git's `commit.template` wins over the repository's convention, relative to the checkout or under `~`", (t) => {
  const { repo, env } = makeRepo(t, "commit-template-config");
  writeFileSync(join(repo, "commitlint.config.js"), "export default {};\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "commit.txt"), "subject\n");
  setTemplateKey(repo, "docs/commit.txt");
  const relative = join(repo, "docs", "commit.txt");
  assert.deepEqual(findCommitTemplate(repo, env), { source: "config", path: relative, label: `git config commit.template (${relative})` });
  writeFileSync(join(env.HOME, "team.txt"), "subject\n");
  setTemplateKey(repo, "~/team.txt");
  assert.equal(findCommitTemplate(repo, env).path, join(env.HOME, "team.txt"));
});

test("a `commit.template` that names no file falls through to the next source", (t) => {
  const { repo, env } = makeRepo(t, "commit-template-dangling");
  setTemplateKey(repo, "missing.txt");
  assert.deepEqual(findCommitTemplate(repo, env), FALLBACK);
});

test("a conventional message with a body passes the fallback", () => {
  assert.deepEqual(commitMessageProblems("feat(text): add slugify\n\nWe removed the co-authored-by trailer.\n\nTests: npm test\n", FALLBACK), []);
});

test("a `Co-Authored-By:` trailer is rejected in any case, naming its line", () => {
  const message = "fix: x\n\nbody\n\nco-authored-by:  Someone <a@b.c>\n";
  assert.deepEqual(commitMessageProblems(message, FALLBACK), ["line 5 is a `Co-Authored-By:` trailer, which a pipeline commit never carries"]);
});

test("a `Refs:` trailer is rejected under every template", () => {
  assert.deepEqual(commitMessageProblems("Add x\n\nRefs: J-12\n", REPO), ["line 3 is a `Refs:` trailer, which is reserved and never written by an agent"]);
});

test("a body glued to the subject, an empty subject and a comment subject are rejected", () => {
  assert.deepEqual(commitMessageProblems("fix: x\nbody\n", FALLBACK), ["line 2 is not blank: one blank line separates the subject from the body"]);
  assert.deepEqual(commitMessageProblems("\n\nbody\n", REPO), ["line 1, the subject, is empty"]);
  assert.deepEqual(commitMessageProblems("# fix: x\n", FALLBACK), ["the subject starts with `#`, which git reads as a comment"]);
});

test("the Conventional Commits subject is required only under the fallback", () => {
  assert.deepEqual(commitMessageProblems("Add slugify\r\n", REPO), []);
  assert.deepEqual(commitMessageProblems("Add slugify\n", FALLBACK), [
    "the subject `Add slugify` is not `<type>(<scope>): <subject>`, which nightqueue's template requires",
  ]);
});
