import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { CHAT_GUARD_DENY, chatDecision, chatWorktree, runChatGuard } from "../../src/hooks/chat-guard.mjs";
import { chatGuardCommand, chatSettings } from "../../src/host/settings.mjs";
import { makeDir, makeHome } from "../../test-support/memory.mjs";

// A temp home with a session worktree entry, a sibling one, two run dirs and a repository outside the home.
function guardHome(t, name) {
  const env = makeHome(t, name);
  const base = realpathSync(makeDir(t, `${name}-host`));
  Object.assign(env, { HOME: join(base, "user-home"), CLAUDE_CONFIG_DIR: join(base, "claude-config") });
  const home = env.NIGHTQUEUE_HOME;
  const worktree = join(home, "worktrees", "p", "s");
  for (const dir of [worktree, join(home, "worktrees", "p", "other"), join(home, "runs", "p", "a"), join(home, "runs", "p", "b"), join(base, "repo", "src")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
  const realHome = realpathSync(home);
  return { env, home: realHome, repo: join(base, "repo"), worktree: join(realHome, "worktrees", "p", "s"), worktreeEnv: { ...env, NIGHTQUEUE_CHAT_WORKTREE: join(realHome, "worktrees", "p", "s") } };
}

// The guard's decision on one Bash command run from a directory.
function bash(env, command, cwd) {
  return chatDecision({ input: { tool_name: "Bash", tool_input: { command }, cwd }, env });
}

// The guard's decision on one Write of a path.
function write(env, filePath, cwd) {
  return chatDecision({ input: { tool_name: "Write", tool_input: { file_path: filePath, content: "x" }, cwd }, env });
}

test("chat guard denies what stays never: force push, a nightqueue home write command, secrets, settings, the home and a mixed delete", (t) => {
  const g = guardHome(t, "chat-guard-deny");
  for (const command of ["git push --force", "nightqueue setup", "rm a; git push --force", "rm a && git clean -fd", `rm ${g.repo}/.env`, `cat ${g.home}/secrets.json`]) {
    const decision = bash(g.env, command, g.repo);
    assert.equal(decision?.decision, "deny", `${command}: ${JSON.stringify(decision)}`);
    assert.match(decision.reason, /^nightqueue chat guard: never \(/);
  }
  for (const target of [join(g.home, "x"), join(g.repo, ".env"), join(g.repo, ".git", "config")]) {
    assert.equal(write(g.env, target, g.repo)?.decision, "deny", target);
  }
});

test("chat guard asks the person before a delete, naming the command", (t) => {
  const g = guardHome(t, "chat-guard-ask");
  for (const command of [`rm ${g.repo}/tmp.txt`, "git rm a.txt", "sh -c 'rm a'", "eval rm a", `find ${g.repo}/src -name x -delete`]) {
    const decision = bash(g.env, command, g.repo);
    assert.equal(decision?.decision, "ask", `${command}: ${JSON.stringify(decision)}`);
    assert.equal(decision.reason, `nightqueue chat guard: deleting files needs your authorization: ${command}`);
  }
});

test("a delete of a whole worktree entry or run dir under the home is denied, never turned into a question (P9 observed)", (t) => {
  const g = guardHome(t, "chat-guard-home-delete");
  for (const command of [`rm -rf ${g.worktree}`, `rm -rf ${g.home}/runs`]) {
    assert.equal(bash(g.env, command, g.repo)?.decision, "deny", command);
  }
});

test("chat guard lets plain commands and edits outside the never band through with no opinion", (t) => {
  const g = guardHome(t, "chat-guard-allow");
  assert.equal(bash(g.env, "git status", g.repo), null);
  assert.equal(write(g.env, join(g.repo, "src", "a.mjs"), g.repo), null);
  assert.equal(chatDecision({ input: { tool_name: "Read", tool_input: { file_path: join(g.home, "secrets.json") } }, env: g.env }), null);
});

test("malformed calls and a guard that throws are denied", (t) => {
  const g = guardHome(t, "chat-guard-malformed");
  for (const toolInput of [null, "rm -rf /", ["x"]]) {
    assert.equal(chatDecision({ input: { tool_name: "Bash", tool_input: toolInput }, env: g.env })?.decision, "deny");
    assert.equal(chatDecision({ input: { tool_name: "Edit", tool_input: toolInput }, env: g.env })?.decision, "deny");
  }
  assert.equal(bash(g.env, "   ", g.repo)?.decision, "deny");
  assert.equal(write(g.env, "relative/path.txt", null)?.decision, "deny");
  const throwing = { get command() { throw new Error("boom"); } };
  const thrown = chatDecision({ input: { tool_name: "Bash", tool_input: throwing, cwd: g.repo }, env: g.env });
  assert.equal(thrown?.decision, "deny");
  assert.match(thrown.reason, /could not check this Bash call \(boom\)/);
});

test("inside the session worktree edits are free but its .git, .env and other worktrees stay never", (t) => {
  const g = guardHome(t, "chat-guard-worktree");
  assert.equal(chatWorktree(g.worktreeEnv), g.worktree);
  assert.equal(write(g.worktreeEnv, join(g.worktree, "src", "a.mjs"), g.worktree), null);
  assert.equal(write(g.worktreeEnv, "src/b.mjs", g.worktree), null, "a relative path resolves against the session cwd");
  for (const target of [join(g.worktree, ".env"), join(g.worktree, ".git"), join(g.home, "worktrees", "p", "other", "a.mjs"), join(g.home, "runs", "x")]) {
    assert.equal(write(g.worktreeEnv, target, g.worktree)?.decision, "deny", target);
  }
  assert.equal(write(g.env, join(g.worktree, "src", "a.mjs"), g.worktree)?.decision, "deny", "without the env key the worktree is the home");
});

test("Bash in the session worktree: plain commands pass, a relative delete asks, a secret is never, absolute home paths get the relative hint", (t) => {
  const g = guardHome(t, "chat-guard-worktree-bash");
  assert.equal(bash(g.worktreeEnv, "npm test", g.worktree), null);
  assert.equal(bash(g.worktreeEnv, "rm tmp.txt", g.worktree)?.decision, "ask");
  assert.equal(bash(g.worktreeEnv, "rm .env", g.worktree)?.decision, "deny", "P10: a relative .env must never be allowed");
  const absolute = bash(g.worktreeEnv, `cat ${g.worktree}/a > ${g.worktree}/b`, g.worktree);
  assert.equal(absolute?.decision, "deny");
  assert.match(absolute.reason, /inside the session worktree, name its files by relative paths$/);
});

test("a NIGHTQUEUE_CHAT_WORKTREE that is not a worktree entry grants nothing", (t) => {
  const g = guardHome(t, "chat-guard-bad-env");
  const outside = realpathSync(makeDir(t, "chat-guard-outside"));
  for (const value of [join(g.home, "runs"), join(g.home, "runs", "p", "a"), join(g.home, "worktrees"), join(g.home, "worktrees", "p"), outside, "relative/dir", join(g.home, "worktrees", "p", "missing")]) {
    const env = { ...g.env, NIGHTQUEUE_CHAT_WORKTREE: value };
    assert.equal(chatWorktree(env), null, value);
    assert.equal(write(env, join(g.home, "runs", "p", "a", "x.mjs"), g.repo)?.decision, "deny", value);
  }
});

test("chatSettings carries only the chat guard on Bash and the edit tools, run by this node and package with a 10 s timeout", () => {
  const settings = chatSettings();
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  assert.deepEqual(Object.keys(settings.hooks), ["PreToolUse"]);
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: chatGuardCommand(), timeout: 10 }] }]);
  assert.match(chatGuardCommand(), /bin\/nightqueue\.mjs" hook chat-guard$/);
  assert.ok(chatGuardCommand().startsWith(JSON.stringify(process.execPath)));
});

// Runs `nightqueue hook chat-guard` with one event on stdin, capturing stdout.
async function runHook(env, input) {
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env, stdin: Readable.from([JSON.stringify(input)]), out: (line) => out.push(line), err: (line) => err.push(line) };
  const code = await run(["hook", "chat-guard"], ctx);
  return { code, out, err };
}

test("`nightqueue hook chat-guard` answers ask JSON for a delete and deny JSON for a .env write", async (t) => {
  const g = guardHome(t, "chat-guard-cli");
  const asked = await runHook(g.env, { tool_name: "Bash", tool_input: { command: `rm ${g.repo}/tmp.txt` }, cwd: g.repo });
  assert.equal(asked.code, 0, asked.err.join("\n"));
  assert.equal(JSON.parse(asked.out[0]).hookSpecificOutput.permissionDecision, "ask");
  const denied = await runHook(g.env, { tool_name: "Write", tool_input: { file_path: join(g.repo, ".env") }, cwd: g.repo });
  assert.deepEqual(Object.keys(JSON.parse(denied.out[0]).hookSpecificOutput), ["hookEventName", "permissionDecision", "permissionDecisionReason"]);
  assert.equal(JSON.parse(denied.out[0]).hookSpecificOutput.permissionDecision, "deny");
  const allowed = await runHook(g.env, { tool_name: "Bash", tool_input: { command: "git status" }, cwd: g.repo });
  assert.deepEqual(allowed.out, []);
  assert.equal(runChatGuard({ input: { tool_name: "Bash", tool_input: { command: "git status" }, cwd: g.repo }, env: g.env }), "");
  assert.equal(JSON.parse(CHAT_GUARD_DENY).hookSpecificOutput.permissionDecision, "deny");
});
