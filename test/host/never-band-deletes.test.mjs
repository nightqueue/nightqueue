import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { commandDeletes, neverBashReason } from "../../src/host/never-band.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

// A temp home with two run dirs and a repository outside it.
function bandHome(t, name) {
  const env = makeHome(t, name);
  const base = realpathSync(makeDir(t, `${name}-host`));
  Object.assign(env, { HOME: join(base, "user-home"), CLAUDE_CONFIG_DIR: join(base, "claude-config") });
  for (const dir of [join(env.NIGHTQUEUE_HOME, "runs", "p", "a"), join(env.NIGHTQUEUE_HOME, "runs", "p", "b"), join(base, "repo")]) mkdirSync(dir, { recursive: true });
  return { env, home: realpathSync(env.NIGHTQUEUE_HOME), repo: join(base, "repo") };
}

test("allowDeletes frees a plain delete and `git rm`, and only those", (t) => {
  const b = bandHome(t, "band-deletes-free");
  const scoped = { cwd: b.repo, env: b.env, allowDeletes: true };
  assert.equal(neverBashReason(`rm ${b.repo}/a.txt`, scoped), null);
  assert.equal(neverBashReason("git rm a.txt", scoped), null);
  assert.equal(neverBashReason("sh -c 'rm a'", scoped), null, "the allowance reaches a shell's -c text");
  assert.equal(neverBashReason("eval rm a", scoped), null, "the allowance reaches eval");
  for (const command of ["git clean -fd", "git push --force", "rm a; git push --force", "git reset --hard", "git branch -D x", `rm -r ${b.home}/runs`, `rm ${b.repo}/.env`, "sh -c 'git push --force'"]) {
    assert.notEqual(neverBashReason(command, scoped), null, command);
  }
});

test("without allowDeletes every delete stays never, as the operator's band has it", (t) => {
  const b = bandHome(t, "band-deletes-default");
  for (const command of [`rm ${b.repo}/a.txt`, "git rm a.txt", "sh -c 'rm a'", "eval rm a"]) {
    assert.equal(neverBashReason(command, { cwd: b.repo, env: b.env }), "deleting files", command);
  }
});

test("commandDeletes sees every delete form, nested ones included, and nothing else", () => {
  for (const command of ["rm a", "find x -delete", "git rm a.txt", "sh -c 'rm a'", "eval rm a", "git worktree remove /abs/wt", "ls; rm a", "sudo rm a", "unlink a"]) {
    assert.equal(commandDeletes(command), true, command);
  }
  for (const command of ["git status", "ls", "npm test", "echo rm", "git log -- rm"]) {
    assert.equal(commandDeletes(command), false, command);
  }
  assert.equal(commandDeletes(null), false);
});
