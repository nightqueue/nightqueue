import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { run as runHook } from "../../src/cli/hook.mjs";
import { MERGER_DENY_ALL, runMergerGuard } from "../../src/hooks/merger-guard.mjs";
import { makeDir } from "../../test-support/memory.mjs";

// A throwaway worktree with one conflicted file and one other file, reached through a symlinked alias like macOS's /var -> /private/var.
function stoppedWorktree(t) {
  const root = makeDir(t, "merger-guard");
  const real = join(root, "real");
  mkdirSync(join(real, "src"), { recursive: true });
  writeFileSync(join(real, "src", "a.mjs"), "<<<<<<< HEAD\n");
  writeFileSync(join(real, "src", "other.mjs"), "x\n");
  const alias = join(root, "alias");
  symlinkSync(real, alias, "dir");
  const env = { NIGHTQUEUE_MERGER_DIR: alias, NIGHTQUEUE_MERGER_FILES: JSON.stringify([join(alias, "src", "a.mjs")]) };
  return { real: realpathSync(real), alias, env };
}

// The permission decision of one guard answer.
function decisionOf(answer) {
  return JSON.parse(answer).hookSpecificOutput.permissionDecision;
}

test("Edit is allowed on a conflicted file only, through either side of a symlinked path", (t) => {
  const { real, alias, env } = stoppedWorktree(t);
  const edit = (filePath, cwd = alias) => decisionOf(runMergerGuard({ input: { tool_name: "Edit", cwd, tool_input: { file_path: filePath } }, env }));
  assert.equal(edit(join(alias, "src", "a.mjs")), "allow");
  assert.equal(edit(join(real, "src", "a.mjs")), "allow", "the real path of a conflicted file was refused");
  assert.equal(edit("src/a.mjs", real), "allow", "a relative path from the session directory was refused");
  assert.equal(edit(join(alias, "src", "other.mjs")), "deny");
  assert.equal(edit("/etc/hosts"), "deny");
});

test("Edit on a conflicted file that is a symlink to a file outside the worktree is denied", (t) => {
  const root = realpathSync(makeDir(t, "merger-guard-escape"));
  const dir = join(root, "wt");
  const outside = join(root, "outside-secret.txt");
  mkdirSync(dir);
  writeFileSync(outside, "x\n");
  const link = join(dir, "conflicted.txt");
  symlinkSync(outside, link);
  const env = { NIGHTQUEUE_MERGER_DIR: dir, NIGHTQUEUE_MERGER_FILES: JSON.stringify([link]) };
  const edit = (filePath) => decisionOf(runMergerGuard({ input: { tool_name: "Edit", cwd: dir, tool_input: { file_path: filePath } }, env }));
  assert.equal(edit(link), "deny");
  assert.equal(edit(outside), "deny");
});

test("Read is allowed inside the worktree only", (t) => {
  const { real, alias, env } = stoppedWorktree(t);
  const read = (filePath) => decisionOf(runMergerGuard({ input: { tool_name: "Read", cwd: alias, tool_input: { file_path: filePath } }, env }));
  assert.equal(read(join(real, "src", "other.mjs")), "allow");
  assert.equal(read(join(alias, "src", "a.mjs")), "allow");
  assert.equal(read(join(real, "..", "outside.txt")), "deny");
  assert.equal(read("/etc/hosts"), "deny");
});

test("every other tool is denied: Bash, Agent, Write", (t) => {
  const { alias, env } = stoppedWorktree(t);
  for (const tool of ["Bash", "Agent", "Task", "Write", "Grep", "mcp__nightqueue__queue_add"]) {
    const answer = runMergerGuard({ input: { tool_name: tool, cwd: alias, tool_input: { file_path: join(alias, "src", "a.mjs"), command: "ls" } }, env });
    assert.equal(decisionOf(answer), "deny", `${tool} was not denied`);
  }
});

test("a missing or malformed fence denies everything", () => {
  const input = { tool_name: "Edit", tool_input: { file_path: "/tmp/a.mjs" } };
  for (const env of [{}, { NIGHTQUEUE_MERGER_DIR: "/tmp" }, { NIGHTQUEUE_MERGER_DIR: "/tmp", NIGHTQUEUE_MERGER_FILES: "not json" }, { NIGHTQUEUE_MERGER_DIR: "relative", NIGHTQUEUE_MERGER_FILES: "[\"/tmp/a.mjs\"]" }, { NIGHTQUEUE_MERGER_DIR: "/tmp", NIGHTQUEUE_MERGER_FILES: "[\"a.mjs\"]" }]) {
    assert.equal(runMergerGuard({ input, env }), MERGER_DENY_ALL);
  }
  assert.equal(decisionOf(MERGER_DENY_ALL), "deny");
});

test("the hook dispatcher runs merger-guard and answers deny for a malformed stdin", async (t) => {
  const { env } = stoppedWorktree(t);
  const out = [];
  const stdin = new PassThrough();
  stdin.end("{ not json");
  await runHook(["merger-guard"], { stdin, env, out: (text) => out.push(text), err: () => {} });
  assert.equal(decisionOf(out[0]), "deny");
});
