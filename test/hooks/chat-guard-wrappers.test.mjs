import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { chatDecision } from "../../src/hooks/chat-guard.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

// A temp home with a session worktree entry, the env that names it and its path.
function wrapperHome(t, name) {
  const env = makeHome(t, name);
  const base = realpathSync(makeDir(t, `${name}-host`));
  Object.assign(env, { HOME: join(base, "user-home"), CLAUDE_CONFIG_DIR: join(base, "claude-config") });
  const worktree = join(env.NIGHTQUEUE_HOME, "worktrees", "p", "s");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
  const real = realpathSync(worktree);
  return { env: { ...env, NIGHTQUEUE_CHAT_WORKTREE: real }, worktree: real };
}

// The chat guard's decision on one Bash command run from the session worktree.
function decide(g, command) {
  return chatDecision({ input: { tool_name: "Bash", tool_input: { command }, cwd: g.worktree }, env: g.env });
}

test("a shell's inline script behind a combined flag is read: force push is denied, a delete asks", (t) => {
  const g = wrapperHome(t, "wrappers");
  for (const shell of ["bash -lc", "sh -ec", "bash -xec", "zsh -c", "bash -l -c"]) {
    assert.equal(decide(g, `${shell} 'git push --force'`)?.decision, "deny", shell);
    assert.equal(decide(g, `${shell} 'rm x'`)?.decision, "ask", shell);
    assert.equal(decide(g, `${shell} 'eval "git push --force"'`)?.decision, "deny", `${shell} eval`);
  }
});

test("options after a shell's `-c`, stdin-fed scripts and wrappers outside the operator's list are read", (t) => {
  const g = wrapperHome(t, "wrappers-forms");
  for (const command of ["bash -c -x 'git push --force'", "sh -c -o errexit 'git push --force'", "echo 'git push --force' | sh", "bash <<< 'git push --force'", "setsid bash -c 'git push --force'"]) {
    assert.equal(decide(g, command)?.decision, "deny", command);
  }
  for (const command of ["bash -c -x 'rm x'", "printf 'rm x' | bash", "sh < script.sh", "setsid rm x", "stdbuf -o0 rm x", "doas -u root rm x"]) {
    assert.equal(decide(g, command)?.decision, "ask", command);
  }
  for (const command of ["bash scripts/build.sh", "bash -c 'echo ok'", "git status"]) {
    assert.equal(decide(g, command), null, command);
  }
});

test("a delete of a glob that could match `.git`, or of a computed path, is denied", (t) => {
  const g = wrapperHome(t, "wrappers-git-glob");
  for (const command of ["rm -rf .g[i]t", "rm -rf .gi?", "rm -rf .git*", "rm -rf sub/.g?t/hooks", 'rm -rf "$(printf .git)"', "rm -rf `echo .git`", 'rm -rf "$G"']) {
    assert.equal(decide(g, command)?.decision, "deny", command);
  }
  for (const command of ["rm -rf *.log", "rm -rf build"]) {
    assert.equal(decide(g, command)?.decision, "ask", command);
  }
});

test("a shell flag cluster carrying `c` with no script is denied", (t) => {
  const g = wrapperHome(t, "wrappers-empty");
  const decision = decide(g, "bash -lc");
  assert.equal(decision?.decision, "deny");
  assert.match(decision.reason, /a shell's -c with no command text/);
});

test("a long ask reason quotes the command up to 200 characters", (t) => {
  const g = wrapperHome(t, "wrappers-long");
  const command = `rm ${"x".repeat(300)}`;
  const decision = decide(g, command);
  assert.equal(decision?.decision, "ask");
  assert.ok(decision.reason.endsWith(`${command.slice(0, 200)}…`), decision.reason);
});
