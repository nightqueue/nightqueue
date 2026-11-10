import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { chatDecision } from "../../src/hooks/chat-guard.mjs";
import { neverBashReason } from "../../src/host/never-band.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

const RELATIVE_PATHS_HINT = "name its files by relative paths";

// A temp home under the user home, with a session worktree entry and a repository outside the home.
function parityHome(t, name) {
  const env = makeHome(t, name);
  const base = realpathSync(makeDir(t, `${name}-host`));
  const home = realpathSync(dirname(env.NIGHTQUEUE_HOME));
  Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: join(base, "claude-config") });
  const nqHome = join(home, "home");
  const worktree = join(nqHome, "worktrees", "p", "s");
  const repo = join(base, "repo");
  for (const dir of [join(worktree, "src"), join(nqHome, "runs", "p", "a"), join(repo, "src"), join(repo, ".git")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
  for (const file of [join(nqHome, "secrets.json"), join(nqHome, "config.json"), join(worktree, "src", "a.mjs"), join(repo, "src", "a.mjs")]) writeFileSync(file, "x\n");
  return { env, nqHome, worktree, repo, out: join(base, "out"), worktreeEnv: { ...env, NIGHTQUEUE_CHAT_WORKTREE: worktree } };
}

// The chat guard's decision on one Bash command run from a directory: `deny`, `ask` or `allow` when it has no opinion.
function decide(env, command, cwd) {
  return chatDecision({ input: { tool_name: "Bash", tool_input: { command }, cwd }, env })?.decision ?? "allow";
}

// The rows of the parity table: each command spelled relative and absolute, the directory it runs from and the expected decision.
function parityRows(g) {
  const wt = { cwd: g.worktree, env: g.worktreeEnv };
  const repo = { cwd: g.repo, env: g.env };
  return [
    { ...wt, relative: "cat ../../../secrets.json", absolute: `cat ${g.nqHome}/secrets.json`, expected: "deny" },
    { ...wt, relative: `cp ../../../secrets.json ${g.out}`, absolute: `cp ${g.nqHome}/secrets.json ${g.out}`, expected: "deny" },
    { ...wt, relative: "echo x | tee ../../../config.json", absolute: `echo x | tee ${g.nqHome}/config.json`, expected: "deny" },
    { ...wt, relative: "mv x ../../runs/p/a/state.json", absolute: `mv x ${g.nqHome}/runs/p/a/state.json`, expected: "deny" },
    { ...wt, relative: "rm -rf .git", absolute: `rm -rf ${g.worktree}/.git`, expected: "deny" },
    { ...wt, relative: "rm -rf ..", absolute: `rm -rf ${g.nqHome}/worktrees/p`, expected: "deny" },
    { ...wt, relative: "rm -rf .", absolute: `rm -rf ${g.worktree}`, expected: "deny" },
    { ...wt, relative: "rm -rf ~", absolute: `rm -rf ${g.env.HOME}`, expected: "deny" },
    { ...repo, relative: "rm -rf .", absolute: `rm -rf ${g.repo}`, expected: "ask" },
    { ...repo, relative: "rm -rf .git", absolute: `rm -rf ${g.repo}/.git`, expected: "deny" },
    { ...repo, relative: "cat src/../.env", absolute: `cat ${g.repo}/.env`, expected: "deny" },
    { ...repo, relative: "rm src/a.mjs", absolute: `rm ${g.repo}/src/a.mjs`, expected: "ask" },
  ];
}

test("a relative spelling gets the same decision as its absolute twin, from the session worktree and from a repository", (t) => {
  const g = parityHome(t, "parity-table");
  for (const row of parityRows(g)) {
    assert.equal(decide(row.env, row.relative, row.cwd), row.expected, `${row.relative} from ${row.cwd}`);
    assert.equal(decide(row.env, row.absolute, row.cwd), row.expected, `${row.absolute} from ${row.cwd}`);
  }
});

test("the chat is never more permissive than the never band, except for the deletes it asks about", (t) => {
  const g = parityHome(t, "parity-band");
  for (const row of parityRows(g)) {
    for (const command of [row.relative, row.absolute]) {
      const band = neverBashReason(command, { cwd: row.cwd, env: row.env });
      const decision = decide(row.env, command, row.cwd);
      if (band === "deleting files") assert.notEqual(decision, "allow", command);
      else if (band !== null) assert.equal(decision, "deny", `${command}: ${band}`);
    }
  }
});

test("ordinary work inside the session worktree is free by its relative spelling", (t) => {
  const g = parityHome(t, "parity-free");
  for (const command of ["cat src/a.mjs", "npm test", "git status", "grep -r foo .", "echo x > src/b.mjs", "grep -r foo --exclude-dir=.git ."]) {
    assert.equal(decide(g.worktreeEnv, command, g.worktree), "allow", command);
    assert.equal(decide(g.worktreeEnv, command, join(g.worktree, "src")), "allow", `${command} from src`);
  }
  assert.equal(decide(g.worktreeEnv, "cat ../../../../secrets.json", join(g.worktree, "src")), "deny");
});

test("an absolute spelling into the session worktree is pinned: allowed, or denied with the relative-paths hint", (t) => {
  const g = parityHome(t, "parity-absolute");
  const decision = chatDecision({ input: { tool_name: "Bash", tool_input: { command: `cat ${g.worktree}/src/a.mjs` }, cwd: g.worktree }, env: g.worktreeEnv });
  assert.equal(decision?.decision, "deny");
  assert.ok(decision.reason.includes(RELATIVE_PATHS_HINT), decision.reason);
});

test("a bare word naming a protected path is denied in chat as a path (R15), a flag value is not resolved", (t) => {
  const g = parityHome(t, "parity-r15");
  assert.equal(decide(g.env, "find . -name .git -prune", g.repo), "deny");
  assert.equal(decide(g.env, "grep -r foo --exclude-dir=.git .", g.repo), "allow");
});
