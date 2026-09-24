import assert from "node:assert/strict";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runGitAsync } from "../../src/host/git.mjs";
import {
  finishNotice,
  inspectRunWorktree,
  keptWorktreeLine,
  lockPid,
  lockState,
  parseWorktreeList,
  removeRunWorktree,
  sameDir,
  withKeptWorktree,
} from "../../src/queue/worktree.mjs";
import { makeDir } from "../../test-support/memory.mjs";
import { addWorktree, deadPid, git, gitVars, localBranches, lockWorktree, makeDirty, publishedCheckout, registeredWorktrees } from "../../test-support/worktrees.mjs";

const ENV = { ...process.env, ...gitVars() };

// The porcelain the triage read from a real checkout: the main worktree, a plain linked one and one Claude Code locked.
const TRIAGE_PORCELAIN = [
  "worktree /Users/me/nightqueue",
  "HEAD 8aee1a84ddb9e5c72a8bd65ac61e2db57304b6f0",
  "branch refs/heads/main",
  "",
  "worktree /Users/me/nightqueue/.claude/worktrees/feat+login",
  "HEAD 8aee1a84ddb9e5c72a8bd65ac61e2db57304b6f0",
  "branch refs/heads/worktree-feat+login",
  "",
  "worktree /Users/me/nightqueue/.claude/worktrees/bug+parser",
  "HEAD 1234abcd1234abcd1234abcd1234abcd1234abcd",
  "branch refs/heads/worktree-bug+parser",
  "locked claude agent agent-a1b2 (pid 48213)",
  "",
  "worktree /Users/me/nightqueue/.claude/worktrees/manual",
  "HEAD 1234abcd1234abcd1234abcd1234abcd1234abcd",
  "detached",
  "locked",
  "",
].join("\n");

const KEPT = { path: "/tmp/wt/feat+x", removable: false, reason: "it has uncommitted changes" };
const KEPT_LINE = "Worktree kept: /tmp/wt/feat+x - it has uncommitted changes.";

test("parseWorktreeList reads the porcelain of the triage, newline or NUL separated, with the lock reason as written", () => {
  const expected = [
    { path: "/Users/me/nightqueue", branch: "refs/heads/main", locked: null },
    { path: "/Users/me/nightqueue/.claude/worktrees/feat+login", branch: "refs/heads/worktree-feat+login", locked: null },
    { path: "/Users/me/nightqueue/.claude/worktrees/bug+parser", branch: "refs/heads/worktree-bug+parser", locked: "claude agent agent-a1b2 (pid 48213)" },
    { path: "/Users/me/nightqueue/.claude/worktrees/manual", branch: null, locked: "" },
  ];
  assert.deepEqual(parseWorktreeList(TRIAGE_PORCELAIN), expected);
  assert.deepEqual(parseWorktreeList(TRIAGE_PORCELAIN.replaceAll("\n", "\0")), expected);
  assert.deepEqual(parseWorktreeList(""), []);
  assert.deepEqual(parseWorktreeList(null), []);
});

test("lockPid reads the pid a lock names, and null for a lock that names none", () => {
  assert.equal(lockPid("claude agent agent-a1b2 (pid 48213)"), 48213);
  assert.equal(lockPid(""), null);
  assert.equal(lockPid("mounted on a portable device"), null);
  assert.equal(lockPid(null), null);
});

test("lockState tells none, live, stale and manual apart", () => {
  assert.equal(lockState({ locked: null }), "none");
  assert.equal(lockState({ locked: `claude agent (pid ${process.pid})` }), "live");
  assert.equal(lockState({ locked: `claude agent (pid ${deadPid()})` }), "stale");
  assert.equal(lockState({ locked: "" }), "manual");
  assert.equal(lockState({ locked: "kept on purpose" }), "manual");
});

test("sameDir resolves every component, so a symlinked intermediate directory still names the same worktree", (t) => {
  const real = makeDir(t, "samedir-real");
  mkdirSync(join(real, "a", "b"), { recursive: true });
  const link = join(makeDir(t, "samedir-link"), "via");
  symlinkSync(join(real, "a"), link);
  assert.equal(sameDir(join(link, "b"), join(real, "a", "b")), true);
  assert.equal(sameDir(join(real, "a"), join(real, "a", "b")), false);
});

test("a clean worktree whose branch is pushed is removable, and removing it keeps the branch", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-clean");
  const { path, branch } = addWorktree(checkout, "feat+clean");

  const inspected = await inspectRunWorktree({ checkout, path, env: ENV });
  assert.deepEqual(inspected, { path, removable: true, staleLock: false });

  const removed = await removeRunWorktree({ checkout, path, env: ENV });
  assert.deepEqual(removed, { ok: true, reason: null });
  assert.equal(existsSync(path), false, "the worktree dir is still on disk");
  assert.deepEqual(registeredWorktrees(checkout), [], "git still registers the removed worktree");
  assert.ok(localBranches(checkout).includes(branch), "the removal deleted the local branch");
});

test("a dirty worktree is kept, whatever else is true of it", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-dirty");
  const { path } = addWorktree(checkout, "feat+dirty");
  makeDirty(path);

  assert.deepEqual(await inspectRunWorktree({ checkout, path, prRecorded: true, env: ENV }), { path, removable: false, reason: "it has uncommitted changes" });
});

test("a branch never pushed is kept, unless a pull request is recorded", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-unpushed");
  const { path } = addWorktree(checkout, "feat+unpushed", { push: false });

  assert.deepEqual(await inspectRunWorktree({ checkout, path, env: ENV }), { path, removable: false, reason: "its branch was never pushed" });
  assert.deepEqual(await inspectRunWorktree({ checkout, path, prRecorded: true, env: ENV }), { path, removable: true, staleLock: false });
});

test("commits ahead of the upstream keep the worktree, named in the singular and in the plural", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-ahead");
  const { path } = addWorktree(checkout, "feat+ahead");
  const commit = ["-C", path, "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-q", "-m", "more"];
  git(commit);
  assert.equal((await inspectRunWorktree({ checkout, path, env: ENV })).reason, "its branch has 1 commit that was never pushed");
  git(commit);
  assert.equal((await inspectRunWorktree({ checkout, path, env: ENV })).reason, "its branch has 2 commits that were never pushed");
});

test("a lock whose pid is gone is lifted and the worktree removed; a live one keeps it", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-locks");
  const stale = addWorktree(checkout, "feat+stale");
  lockWorktree(checkout, stale.path, deadPid());
  const live = addWorktree(checkout, "feat+live");
  lockWorktree(checkout, live.path, process.pid);

  const inspectedStale = await inspectRunWorktree({ checkout, path: stale.path, env: ENV });
  assert.deepEqual(inspectedStale, { path: stale.path, removable: true, staleLock: true });
  assert.deepEqual(await removeRunWorktree({ checkout, path: stale.path, staleLock: true, env: ENV }), { ok: true, reason: null });
  assert.equal(existsSync(stale.path), false);

  assert.deepEqual(await inspectRunWorktree({ checkout, path: live.path, env: ENV }), {
    path: live.path,
    removable: false,
    reason: `it is locked by a live session (pid ${process.pid})`,
  });
  assert.equal(existsSync(live.path), true);
});

test("a manual lock keeps the worktree and names its reason", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-manual");
  const { path } = addWorktree(checkout, "feat+manual");
  git(["-C", checkout, "worktree", "lock", "--reason", "kept on purpose", path]);
  assert.equal((await inspectRunWorktree({ checkout, path, env: ENV })).reason, "it is locked (kept on purpose)");
  git(["-C", checkout, "worktree", "unlock", path]);
  git(["-C", checkout, "worktree", "lock", path]);
  assert.equal((await inspectRunWorktree({ checkout, path, env: ENV })).reason, "it is locked");
});

test("a path that is not a registered linked worktree of the checkout is never a candidate", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-foreign");
  const plain = makeDir(t, "wt-foreign-plain");
  const other = publishedCheckout(t, "wt-foreign-other");
  const foreign = addWorktree(other.checkout, "feat+foreign");

  assert.equal(await inspectRunWorktree({ checkout, path: checkout, env: ENV }), null, "the checkout itself");
  assert.equal(await inspectRunWorktree({ checkout, path: plain, env: ENV }), null, "a plain directory");
  assert.equal(await inspectRunWorktree({ checkout, path: foreign.path, env: ENV }), null, "a worktree of another checkout");
  assert.equal(await inspectRunWorktree({ checkout, path: join(checkout, "missing"), env: ENV }), null, "a path that is gone");
  assert.equal(await inspectRunWorktree({ checkout, path: "relative/path", env: ENV }), null, "a relative path");
  assert.equal(await inspectRunWorktree({ checkout, path: null, env: ENV }), null, "no path");
  assert.equal(await inspectRunWorktree({ checkout: null, path: plain, env: ENV }), null, "no checkout");
});

test("a worktree reached through a symlinked intermediate directory is still recognised as registered", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-symlink");
  const { path } = addWorktree(checkout, "feat+linked");
  const link = join(makeDir(t, "wt-symlink-link"), "checkout");
  symlinkSync(checkout, link);
  const viaLink = join(link, ".claude", "worktrees", "feat+linked");
  assert.deepEqual(await inspectRunWorktree({ checkout: link, path: viaLink, env: ENV }), { path: viaLink, removable: true, staleLock: false });
  assert.equal(existsSync(path), true);
});

test("git worktree remove refuses a path it does not register, so nothing outside the checkout is ever deleted", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-refuse");
  const plain = makeDir(t, "wt-refuse-plain");
  const removed = await removeRunWorktree({ checkout, path: plain, env: ENV });
  assert.equal(removed.ok, false);
  assert.match(removed.reason, /is not a working tree/);
  assert.equal(existsSync(plain), true);
});

test("removing a worktree another caller already removed reports it removed, never kept", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-already-gone");
  const { path } = addWorktree(checkout, "feat+gone");
  git(["-C", checkout, "worktree", "remove", path]);
  assert.deepEqual(await removeRunWorktree({ checkout, path, env: ENV }), { ok: true, reason: null });
  assert.deepEqual(registeredWorktrees(checkout), []);
});

test("runGitAsync never rejects: a refusal and a timeout come back as results", async (t) => {
  const dir = makeDir(t, "git-async");
  const refused = await runGitAsync({ args: ["status"], cwd: dir, env: ENV });
  assert.equal(refused.ok, false);
  assert.match(refused.stderr, /not a git repository/);
  const hung = await runGitAsync({ args: ["status"], cwd: dir, env: ENV, timeoutMs: 1, execFileImpl: (file, args, options, done) => done(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }), "", "") });
  assert.deepEqual(hung, { ok: false, stdout: "", stderr: "git did not answer within 1 ms", missing: false });
  const thrown = await runGitAsync({ args: ["status"], execFileImpl: () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); } });
  assert.deepEqual(thrown, { ok: false, stdout: "", stderr: "spawn git ENOENT", missing: true });
});

test("keptWorktreeLine names the path and the reason", () => {
  assert.equal(keptWorktreeLine(KEPT), KEPT_LINE);
});

test("finishNotice (i): a run notice gets the kept line appended after a blank line", () => {
  assert.equal(finishNotice({ runNotice: "the run notice", rowNotice: "older", worktree: KEPT }), `the run notice\n\n${KEPT_LINE}`);
});

test("finishNotice (ii): with no run notice the line is appended to the row's earlier notice, never replacing it", () => {
  assert.equal(finishNotice({ runNotice: null, rowNotice: "answered gate reason", worktree: KEPT }), `answered gate reason\n\n${KEPT_LINE}`);
  assert.equal(finishNotice({ runNotice: "  ", rowNotice: "answered gate reason", worktree: KEPT }), `answered gate reason\n\n${KEPT_LINE}`);
});

test("finishNotice (iii): with no notice anywhere the kept line stands alone", () => {
  assert.equal(finishNotice({ runNotice: null, rowNotice: null, worktree: KEPT }), KEPT_LINE);
});

test("finishNotice (iv): an earlier kept line at the end of the notice is replaced, never stacked", () => {
  const earlier = `answered gate reason\n\nWorktree kept: /tmp/wt/feat+x - its branch was never pushed.`;
  assert.equal(finishNotice({ runNotice: null, rowNotice: earlier, worktree: KEPT }), `answered gate reason\n\n${KEPT_LINE}`);
  assert.equal(finishNotice({ runNotice: null, rowNotice: `${KEPT_LINE}\n`, worktree: KEPT }), KEPT_LINE);
  assert.equal(withKeptWorktree(`mentions ${KEPT_LINE} inline`, KEPT), `mentions ${KEPT_LINE} inline\n\n${KEPT_LINE}`);
});

test("finishNotice (v): no worktree, or a removable one, returns the run notice as is, null included", () => {
  const removable = { path: "/tmp/wt/feat+x", removable: true, staleLock: false };
  for (const worktree of [null, undefined, removable]) {
    assert.equal(finishNotice({ runNotice: "the run notice", rowNotice: "older", worktree }), "the run notice");
    assert.equal(finishNotice({ runNotice: null, rowNotice: "older", worktree }), null);
  }
  assert.equal(withKeptWorktree("as is", removable), "as is");
});
