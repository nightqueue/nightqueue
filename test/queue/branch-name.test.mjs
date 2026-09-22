import assert from "node:assert/strict";
import { test } from "node:test";
import { branchAliases, publishedBranchName, sameBranch, WORKTREE_BRANCH_PREFIX } from "../../src/queue/branch-name.mjs";

// The rename `run pr` applied before the rule moved here, kept verbatim as the reference the module must match.
function legacyFinalBranch(current, { type, slug }) {
  if (!current.startsWith("worktree-")) return current;
  const mangled = current.slice("worktree-".length);
  const separator = mangled.indexOf("+");
  const prefix = type === "bug/error" ? "fix" : "feat";
  return separator > 0 ? `${mangled.slice(0, separator)}/${mangled.slice(separator + 1)}` : `${prefix}/${slug}`;
}

const RENAMES = [
  { current: "worktree-feat+queue-ship", type: "feature", slug: "queue-ship" },
  { current: "worktree-fix+queue-ship-follow-ups", type: "bug/error", slug: "queue-ship-follow-ups" },
  { current: "worktree-login", type: "bug/error", slug: "login" },
  { current: "worktree-login", type: "feature", slug: "login" },
  { current: "worktree-+odd", type: undefined, slug: "odd" },
  { current: "feat/already-published", type: "feature", slug: "already-published" },
  { current: "main", type: undefined, slug: "x" },
];

test("the published name of a branch is the rename run pr always applied", () => {
  assert.equal(WORKTREE_BRANCH_PREFIX, "worktree-");
  for (const { current, type, slug } of RENAMES) {
    assert.equal(publishedBranchName(current, { type, slug }), legacyFinalBranch(current, { type, slug }), current);
  }
});

test("a worktree branch and its published name are the same branch, both ways", () => {
  assert.ok(sameBranch("worktree-feat+queue-ship", "feat/queue-ship"));
  assert.ok(sameBranch("feat/queue-ship", "worktree-feat+queue-ship"));
  assert.ok(sameBranch("worktree-login", "fix/login", { type: "bug/error", slug: "login" }));
  assert.ok(sameBranch("fix/login", "worktree-login", { type: "bug/error", slug: "login" }));
  assert.ok(sameBranch(" feat/x ", "feat/x"), "surrounding blanks made the same name another branch");
});

test("different branches, and absent names, are never the same branch", () => {
  assert.equal(sameBranch("worktree-feat+queue-ship", "scratch/ship-qa-20260921201325"), false);
  assert.equal(sameBranch("worktree-login", "feat/login", { type: "bug/error", slug: "login" }), false);
  assert.equal(sameBranch("main", "develop"), false);
  assert.ok(sameBranch("main", "main"), "a plain name is itself");
  assert.equal(sameBranch("", ""), false);
  assert.equal(sameBranch(null, null), false);
  assert.equal(sameBranch(undefined, "feat/x"), false);
  assert.equal(sameBranch("feat/x", null), false);
});

test("the aliases of a branch are itself, its published form and its worktree form", () => {
  assert.deepEqual(branchAliases("worktree-feat+x"), ["worktree-feat+x", "feat/x"]);
  assert.deepEqual(branchAliases("feat/x"), ["feat/x", "worktree-feat+x"]);
  assert.deepEqual(branchAliases("worktree-login"), ["worktree-login"], "a slugless rename invented a published name");
  assert.deepEqual(branchAliases("main"), ["main"]);
  assert.deepEqual(branchAliases(42), []);
});
