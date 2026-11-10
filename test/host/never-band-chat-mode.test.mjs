import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { neverBashReason } from "../../src/host/never-band.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

// A temp home and a repository outside it, with a `.git` directory.
function bandHome(t, name) {
  const env = makeHome(t, name);
  const base = realpathSync(makeDir(t, `${name}-host`));
  Object.assign(env, { HOME: join(base, "user-home"), CLAUDE_CONFIG_DIR: join(base, "claude-config") });
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(env.NIGHTQUEUE_HOME, { recursive: true });
  return { env, repo, home: realpathSync(env.NIGHTQUEUE_HOME) };
}

test("without `chat` the operator's verdicts do not move: a combined shell flag and a bare home word stay unread", (t) => {
  const b = bandHome(t, "band-operator");
  assert.equal(neverBashReason("bash -lc 'git push --force'", { cwd: b.repo, env: b.env }), null);
  assert.equal(neverBashReason("cat secrets.json", { cwd: b.home, env: b.env }), null);
  assert.equal(neverBashReason("rm -rf .git", { cwd: b.repo, env: b.env }), "deleting files");
  assert.equal(neverBashReason("bash -c 'git push --force'", { cwd: b.repo, env: b.env }), "a force push or a remote delete");
});

test("with `chat` a bare word resolves against the cwd, a flag value does not", (t) => {
  const b = bandHome(t, "band-chat");
  const chat = { worktree: null };
  assert.match(neverBashReason("cat secrets.json", { cwd: b.home, env: b.env, chat }), /nightqueue home/, "from the home every bare word names the home");
  assert.match(neverBashReason("cat home/secrets.json", { cwd: dirname(b.home), env: b.env, chat }), /secrets/);
  assert.match(neverBashReason("ls .git", { cwd: b.repo, env: b.env, chat }), /\.git/);
  assert.equal(neverBashReason("grep -r foo --exclude-dir=.git .", { cwd: b.repo, env: b.env, chat }), null);
  assert.equal(neverBashReason("bash -lc 'git push --force'", { cwd: b.repo, env: b.env, chat }), "a force push or a remote delete");
});

test("`allowDeletes` reads words in chat mode, so the relative `.git` keeps its protection", (t) => {
  const b = bandHome(t, "band-allow");
  assert.match(neverBashReason("rm -rf .git", { cwd: b.repo, env: b.env, allowDeletes: true }), /\.git/);
  assert.equal(neverBashReason("rm -rf .", { cwd: b.repo, env: b.env, allowDeletes: true }), null);
  assert.equal(neverBashReason("rm -rf .", { cwd: dirname(b.home), env: b.env, allowDeletes: true }), "deleting the nightqueue home or the session worktree");
});
