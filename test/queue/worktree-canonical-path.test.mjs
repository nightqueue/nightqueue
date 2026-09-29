import assert from "node:assert/strict";
import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inspectRunWorktree, removeRunWorktree } from "../../src/queue/worktree.mjs";
import { makeDir } from "../../test-support/memory.mjs";
import { addWorktree, gitVars, publishedCheckout, registeredWorktrees } from "../../test-support/worktrees.mjs";

const ENV = { ...process.env, ...gitVars() };

// Group B hypothesis: `inspectRunWorktree` returns the caller's raw, non-canonical
// path (never `entry.path`), and `removeRunWorktree` runs `git worktree remove`
// with that same raw string. The claim under test is that this can leave git in a
// PARTIAL state: the directory removed but the administrative `.git/worktrees/<name>`
// entry orphaned (or the reverse) whenever the raw string reaches the SAME registered
// worktree only through a non-canonical form (an ancestor symlink, a trailing slash,
// a `..` segment).
//
// The correct behavior (user's point of view): removal through a non-canonical path
// must leave git in EXACTLY the same state as removal through the canonical path —
// directory gone AND `git worktree list --porcelain` no longer lists the entry.

test("removing a worktree reached through a symlinked ancestor directory leaves no orphaned admin entry", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-canon-symlink");
  const { path } = addWorktree(checkout, "feat+canon-a");
  const link = join(makeDir(t, "wt-canon-symlink-link"), "checkout");
  symlinkSync(checkout, link);
  const viaLink = join(link, ".claude", "worktrees", "feat+canon-a");

  const inspected = await inspectRunWorktree({ checkout, path: viaLink, env: ENV });
  assert.equal(inspected.removable, true, "the non-canonical path is judged removable");
  assert.equal(inspected.path, viaLink, "inspectRunWorktree hands back the caller's raw, non-canonical path");

  const removed = await removeRunWorktree({ checkout, path: inspected.path, staleLock: inspected.staleLock, env: ENV });
  assert.deepEqual(removed, { ok: true, reason: null });
  assert.equal(existsSync(path), false, "the worktree directory is gone");
  assert.deepEqual(registeredWorktrees(checkout), [], "git no longer lists the entry (no orphaned admin record)");
});

test("removing a worktree through a path with a trailing slash leaves no orphaned admin entry", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-canon-slash");
  const { path } = addWorktree(checkout, "feat+canon-b");
  const withSlash = `${path}/`;

  const inspected = await inspectRunWorktree({ checkout, path: withSlash, env: ENV });
  assert.equal(inspected.removable, true);

  const removed = await removeRunWorktree({ checkout, path: inspected.path, staleLock: inspected.staleLock, env: ENV });
  assert.deepEqual(removed, { ok: true, reason: null });
  assert.equal(existsSync(path), false);
  assert.deepEqual(registeredWorktrees(checkout), []);
});

test("removing a worktree through a path with a `..` segment leaves no orphaned admin entry", async (t) => {
  const { checkout } = publishedCheckout(t, "wt-canon-dotdot");
  const { path } = addWorktree(checkout, "feat+canon-c");
  const viaDotDot = join(checkout, ".claude", "worktrees", "..", "worktrees", "feat+canon-c");

  const inspected = await inspectRunWorktree({ checkout, path: viaDotDot, env: ENV });
  assert.equal(inspected.removable, true);

  const removed = await removeRunWorktree({ checkout, path: inspected.path, staleLock: inspected.staleLock, env: ENV });
  assert.deepEqual(removed, { ok: true, reason: null });
  assert.equal(existsSync(path), false);
  assert.deepEqual(registeredWorktrees(checkout), []);
});
