import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BLOCK_CODES, blockingStatusPaths, preflight } from "../../src/queue/preflight.mjs";
import { makeHome, makeProject, projectIdOf } from "../../test-support/memory.mjs";

const JOB = { id: 1, project: "alpha", prompt: "fix the worker" };
const WRITING_GIT_VERBS = ["add", "commit", "checkout", "switch", "reset", "stash", "clean", "worktree", "push", "fetch", "pull"];

// A git double that answers each read from a table and records every command it was asked to run.
function fakeGit({ status = "", branch = "main", originHead = "origin/main" } = {}) {
  const calls = [];
  const answers = { status, "rev-parse": branch, "symbolic-ref": originHead };
  const impl = ({ args, cwd }) => {
    calls.push({ args, cwd });
    const answer = answers[args[0]];
    if (answer === null || answer === undefined) throw new Error(`git ${args[0]} failed`);
    return `${answer}\n`;
  };
  impl.calls = calls;
  return impl;
}

// The resolver of the `claude` binary, either finding it or not.
function fakeBin(found) {
  return () => (found ? { bin: "/opt/homebrew/bin/claude", via: "candidate" } : { bin: null, via: "missing" });
}

// Runs the preflight of the test job with every external answer injected.
function check(env, { git = fakeGit(), exists = () => true, bin = fakeBin(true), job = { ...JOB, project_id: projectIdOf(env, "alpha") } } = {}) {
  return preflight({ job, env, gitImpl: git, existsImpl: exists, resolveBinImpl: bin });
}

// A home with the project of the test job registered.
function makeQueue(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  return env;
}

test("a clean checkout on the default branch passes and hands the runner the directory to run in", (t) => {
  const env = makeQueue(t, "preflight-ok");
  const git = fakeGit({ originHead: "origin/trunk", branch: "trunk" });
  const result = check(env, { git });
  assert.equal(result.ok, true);
  assert.equal(result.branch, "trunk");
  assert.ok(result.cwd.length > 0);
  const verbs = git.calls.map((call) => call.args[0]);
  assert.deepEqual(verbs, ["check-ignore", "status", "rev-parse", "symbolic-ref"]);
  assert.equal(existsSync(join(result.cwd, "main", "info", "exclude")), false, "a fake git that cannot answer check-ignore must never lead to a write");
  for (const call of git.calls) {
    assert.equal(WRITING_GIT_VERBS.includes(call.args[0]), false, `the preflight ran a git command that writes: ${call.args.join(" ")}`);
  }
});

test("a project that is not registered is blocked before anything touches the disk", (t) => {
  const env = makeQueue(t, "preflight-unknown");
  const git = fakeGit();
  const result = check(env, {
    git,
    job: { ...JOB, project: "ghost" },
    exists: () => {
      throw new Error("the preflight looked at the disk of an unknown project");
    },
  });
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: BLOCK_CODES.UNKNOWN_PROJECT });
  assert.match(result.message, /unknown project `ghost`/);
  assert.equal(git.calls.length, 0);
});

test("a checkout that is gone, or has no .git, is blocked as a missing checkout", (t) => {
  const env = makeQueue(t, "preflight-missing");
  assert.equal(check(env, { exists: () => false }).code, BLOCK_CODES.MISSING_CHECKOUT);
  assert.equal(check(env, { exists: (path) => !path.endsWith(".git") }).code, BLOCK_CODES.MISSING_CHECKOUT);
  const broken = check(env, { git: fakeGit({ status: null }) });
  assert.deepEqual({ ok: broken.ok, code: broken.code }, { ok: false, code: BLOCK_CODES.MISSING_CHECKOUT });
});

test("a missing `claude` binary is blocked with the message that names the override", (t) => {
  const env = makeQueue(t, "preflight-claude");
  const result = check(env, { bin: fakeBin(false) });
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: BLOCK_CODES.CLAUDE_MISSING });
  assert.match(result.message, /NIGHTQUEUE_CLAUDE_BIN/);
});

test("uncommitted changes in the canonical checkout block the job", (t) => {
  const env = makeQueue(t, "preflight-dirty");
  const result = check(env, { git: fakeGit({ status: " M src/queue/runner.mjs" }) });
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: BLOCK_CODES.DIRTY_CHECKOUT });
  assert.match(result.message, /uncommitted changes \(src\/queue\/runner\.mjs\)/);
});

test("the porcelain parser drops only the untracked Claude Code local paths and keeps every other entry", () => {
  const raw = [
    "?? .claude/worktrees/fix+x/",
    "?? .claude/settings.local.json",
    "?? .claude/commands/x.md",
    " M .claude/settings.json",
    "R  new.mjs",
    "old.mjs",
    " M src/a.mjs",
    "",
  ].join("\0");
  assert.deepEqual(blockingStatusPaths(raw), [".claude/commands/x.md", ".claude/settings.json", "new.mjs", "src/a.mjs"]);
  assert.deepEqual(blockingStatusPaths("?? .claude/\0"), [".claude/"], "a collapsed `.claude/` entry is not one of the allowed paths");
  assert.deepEqual(blockingStatusPaths(""), []);
});

test("the dirty-checkout message names the first three paths and counts the rest", (t) => {
  const env = makeQueue(t, "preflight-dirty-many");
  const status = ["?? a", "?? b", "?? c", "?? d", "?? e", ""].join("\0");
  const result = check(env, { git: fakeGit({ status }) });
  assert.match(result.message, /uncommitted changes \(a, b, c and 2 more\)/);
});

test("the ensure step runs before the dirty check and a throw of its own never blocks the job", (t) => {
  const env = makeQueue(t, "preflight-ensure-throws");
  const order = [];
  const git = fakeGit();
  const ensureExcludeImpl = ({ cwd }) => {
    order.push(["ensure", cwd]);
    throw new Error("disk on fire");
  };
  const result = preflight({ job: { ...JOB, project_id: projectIdOf(env, "alpha") }, env, gitImpl: git, existsImpl: () => true, resolveBinImpl: fakeBin(true), ensureExcludeImpl });
  assert.equal(result.ok, true);
  assert.deepEqual(order, [["ensure", result.cwd]]);
});

test("a checkout parked on another branch is blocked, naming the branch it should be on", (t) => {
  const env = makeQueue(t, "preflight-branch");
  const result = check(env, { git: fakeGit({ branch: "feat/queue-runner", originHead: "origin/main" }) });
  assert.deepEqual({ ok: result.ok, code: result.code }, { ok: false, code: BLOCK_CODES.WRONG_BRANCH });
  assert.match(result.message, /`feat\/queue-runner`, expected `main`/);
});

test("without origin/HEAD the default branch falls back to main, and a repository with no commit still passes", (t) => {
  const env = makeQueue(t, "preflight-fallback");
  assert.equal(check(env, { git: fakeGit({ branch: "main", originHead: null }) }).ok, true);
  assert.equal(check(env, { git: fakeGit({ branch: "master", originHead: null }) }).code, BLOCK_CODES.WRONG_BRANCH);
  const fresh = check(env, { git: fakeGit({ branch: null, originHead: null }) });
  assert.deepEqual({ ok: fresh.ok, branch: fresh.branch }, { ok: true, branch: "main" });
});
