import assert from "node:assert/strict";
import { test } from "node:test";
import { branchAliases, COMMIT_TYPES, commitTypeOf, publishedBranchName, rungCollisionNote, sameBranch, sameRefName, sameRunBranch, WORKTREE_BRANCH_PREFIX } from "../../src/queue/branch-name.mjs";

// The rename `run pr` applied before the rule moved here, kept verbatim as the reference the module must match.
function legacyFinalBranch(current, { type, slug }) {
  if (!current.startsWith("worktree-")) return current;
  const mangled = current.slice("worktree-".length);
  const separator = mangled.indexOf("+");
  const prefix = type === "bug/error" ? "fix" : "feat";
  return separator > 0 ? `${mangled.slice(0, separator)}/${mangled.slice(separator + 1)}` : `${prefix}/${slug}`;
}

const RENAMES = [
  { current: "worktree-feat+queue-close", type: "feature", slug: "queue-close" },
  { current: "worktree-fix+queue-close-follow-ups", type: "bug/error", slug: "queue-close-follow-ups" },
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
  assert.ok(sameBranch("worktree-feat+queue-close", "feat/queue-close"));
  assert.ok(sameBranch("feat/queue-close", "worktree-feat+queue-close"));
  assert.ok(sameBranch("worktree-login", "fix/login", { type: "bug/error", slug: "login" }));
  assert.ok(sameBranch("fix/login", "worktree-login", { type: "bug/error", slug: "login" }));
  assert.ok(sameBranch(" feat/x ", "feat/x"), "surrounding blanks made the same name another branch");
});

test("different branches, and absent names, are never the same branch", () => {
  assert.equal(sameBranch("worktree-feat+queue-close", "scratch/close-qa-20260921201325"), false);
  assert.equal(sameBranch("worktree-login", "feat/logout", { type: "bug/error", slug: "login" }), false);
  assert.equal(sameBranch("main", "develop"), false);
  assert.ok(sameBranch("main", "main"), "a plain name is itself");
  assert.equal(sameBranch("", ""), false);
  assert.equal(sameBranch(null, null), false);
  assert.equal(sameBranch(undefined, "feat/x"), false);
  assert.equal(sameBranch("feat/x", null), false);
});

test("two spellings of one ref are one name, and an absent name is none", () => {
  assert.equal(sameRefName("Main", "main"), true);
  assert.equal(sameRefName(" FEAT/X ", "feat/x"), true);
  assert.equal(sameRefName(null, null), false);
  assert.equal(sameRefName("", ""), false);
  assert.equal(sameRefName("main", null), false);
  assert.equal(sameRefName("main", "develop"), false);
  assert.equal(sameRefName("straße", "STRASSE"), false, "toLowerCase is no full case fold, and the queue says so");
});

test("branches compare under any case, the published forms included, and every different name stays different", () => {
  assert.equal(sameBranch("FEAT/X", "feat/x"), true);
  assert.equal(sameRunBranch("WORKTREE-x", { slug: "x" }, "fix/x", {}), true);
  assert.equal(sameRunBranch("fix/x", {}, "WORKTREE-x", { slug: "x" }), true);
  assert.equal(sameRunBranch("worktree-x", { slug: "X" }, "FIX/x", {}), true);
  assert.equal(sameBranch("worktree-x-2", "fix/x", { slug: "x" }), false);
  assert.equal(sameBranch("WORKTREE-x-2", "FIX/x", { slug: "x" }), false);
  assert.equal(sameBranch("MAIN", "develop"), false);
});

test("the aliases of a branch keep the spelling they are given, since git receives them", () => {
  assert.deepEqual(branchAliases("Feat/X"), ["Feat/X", "worktree-Feat+X"]);
});

test("the aliases of a branch are itself, its published form and its worktree form", () => {
  assert.deepEqual(branchAliases("worktree-feat+x"), ["worktree-feat+x", "feat/x"]);
  assert.deepEqual(branchAliases("feat/x"), ["feat/x", "worktree-feat+x"]);
  assert.deepEqual(branchAliases("worktree-login"), ["worktree-login"], "a slugless rename invented a published name");
  assert.deepEqual(branchAliases("main"), ["main"]);
  assert.deepEqual(branchAliases(42), []);
});

test("the commit type of a subject is read only from a Conventional Commits prefix of a known type", () => {
  assert.equal(commitTypeOf("refactor(x): y"), "refactor");
  assert.equal(commitTypeOf("docs: y"), "docs");
  assert.equal(commitTypeOf("feat!: breaking"), "feat");
  assert.equal(commitTypeOf("chore(deps)!: bump"), "chore");
  assert.equal(commitTypeOf("perf(x): y"), null, "a type outside the pipeline's table");
  assert.equal(commitTypeOf("Refactor the parser"), null);
  assert.equal(commitTypeOf("refactor:no space"), null);
  assert.equal(commitTypeOf(undefined), null);
  assert.deepEqual(COMMIT_TYPES, ["feat", "fix", "refactor", "docs", "style", "build", "chore", "test"]);
});

test("a runtime `worktree-<slug>` branch is published under the commit type, else the task type, and the `+` form is unchanged", () => {
  assert.equal(publishedBranchName("worktree-foo", { type: "feature", slug: "foo", commitType: "refactor" }), "refactor/foo");
  assert.equal(publishedBranchName("worktree-foo", { type: "bug/error", slug: "foo", commitType: null }), "fix/foo");
  assert.equal(publishedBranchName("worktree-foo", { type: "feature", slug: "foo" }), "feat/foo");
  assert.equal(publishedBranchName("worktree-provisional-name", { slug: "final-name", commitType: "docs" }), "docs/final-name");
  assert.equal(publishedBranchName("worktree-feat+x", { type: "bug/error", slug: "y", commitType: "docs" }), "feat/x");
});

test("a runtime `worktree-<slug>` branch is the same branch as its publication under any commit type", () => {
  assert.ok(sameBranch("worktree-foo", "docs/foo", { slug: "foo" }));
  assert.ok(sameBranch("worktree-foo", "refactor/foo", { slug: "foo" }));
  assert.ok(sameBranch("refactor/foo", "worktree-foo", { slug: "foo" }));
  assert.equal(sameBranch("worktree-foo", "perf/foo", { slug: "foo" }), false);
  assert.equal(sameBranch("worktree-foo", "refactor/bar", { slug: "foo" }), false);
  assert.equal(sameBranch("worktree-feat+x", "refactor/x", { slug: "x" }), false, "the `+` form keeps its own type");
});

test("the branches of two runs never match through one run's slug: unrelated `worktree-*` names are different branches", () => {
  const holdHints = { slug: "botao-registrar-entrega-loading-drawer", type: "feature/refactor" };
  const hold = "worktree-bot-o-registrar-entrega-do-drawer";
  const candidate = "worktree-bot-o-entregar-tudo-no-modal";
  assert.equal(sameRunBranch(hold, holdHints, candidate, { slug: null, type: "feature/refactor" }), false);
  assert.equal(sameRunBranch(hold, holdHints, candidate, { slug: "botao-entregar-tudo-modal", type: "feature/refactor" }), false);
  assert.equal(sameRunBranch(candidate, { slug: "botao-entregar-tudo-modal" }, hold, holdHints), false, "swapped sides");
  assert.equal(sameRunBranch("worktree-a", { slug: "a" }, "worktree-b", { slug: "b" }), false);
  assert.ok(sameRunBranch("worktree-a", { slug: "a" }, "worktree-a", { slug: null }), "a name is itself");
});

test("a rung `worktree-<slug>-<n>` of the run's slug publishes and aliases over `<slug>-<n>`, never over `<slug>`", () => {
  const hints = { slug: "x", type: "bug/error" };
  assert.equal(publishedBranchName("worktree-x-2", hints), "fix/x-2");
  assert.equal(publishedBranchName("worktree-x-10", { slug: "x", commitType: "docs" }), "docs/x-10");
  assert.equal(publishedBranchName("worktree-a-b-2", { slug: "a+b", commitType: "docs" }), "docs/a+b-2");
  const aliases = branchAliases("worktree-x-2", hints);
  assert.ok(aliases.includes("fix/x-2") && aliases.includes("feat/x-2"), aliases.join(" "));
  assert.equal(aliases.includes("fix/x"), false, "the rung carries the old branch's published name");
  assert.equal(sameBranch("worktree-x-2", "fix/x", hints), false);
  assert.ok(sameBranch("worktree-x-2", "fix/x-2", hints));
});

test("a rung's run never takes the plain published name as its own, and the collision note explains the pair", () => {
  assert.equal(sameBranch("fix/x", "worktree-x-2", { slug: "x" }), false);
  assert.equal(rungCollisionNote("fix/x", "worktree-x-2", { slug: "x" }), "`fix/x` is the published name of `worktree-x`; this run's `worktree-x-2` publishes as `fix/x-2`");
  assert.equal(rungCollisionNote("feat/x", "worktree-x-11", { slug: "x" }), "`feat/x` is the published name of `worktree-x`; this run's `worktree-x-11` publishes as `feat/x-11`");
});

test("the collision note stays silent on every other pair", () => {
  for (const [head, branch, slug] of [
    ["fix/y", "worktree-x-2", "x"],
    ["nope/x", "worktree-x-2", "x"],
    ["fix/x", "worktree-x", "x"],
    ["fix/x", "worktree-x-1", "x"],
    ["fix/x-2", "worktree-x-2", "x"],
    ["fix/x", "worktree-y-2", "x"],
    ["fix/x", "fix/x-2", "x"],
    ["fix/x", "worktree-x-2", null],
    [null, "worktree-x-2", "x"],
    ["fix/x", null, "x"],
  ]) {
    assert.equal(rungCollisionNote(head, branch, { slug }), null, JSON.stringify([head, branch, slug]));
  }
  assert.equal(rungCollisionNote("fix/x", "worktree-x-2"), null);
});

test("a near-miss of a rung is no rung: it keeps the run's own slug", () => {
  for (const near of ["worktree-x-1", "worktree-x-02", "worktree-x-2b", "worktree-xy-2"]) {
    assert.equal(publishedBranchName(near, { slug: "x", commitType: "fix" }), "fix/x", near);
    assert.ok(branchAliases(near, { slug: "x" }).includes("fix/x"), near);
  }
  assert.equal(publishedBranchName("worktree-x-2", { slug: "x-2", commitType: "fix" }), "fix/x-2", "the slug's own suffix is not a rung");
  assert.deepEqual(branchAliases("worktree-x-2", { slug: "x-2" }).includes("fix/x-2-2"), false);
});

test("the branch of one run still matches its published form across runs, each side by its own slug", () => {
  assert.ok(sameRunBranch("feat/x", { slug: "x" }, "worktree-x", { slug: "x" }));
  assert.ok(sameRunBranch("worktree-x", { slug: "x" }, "feat/x", { slug: null }), "the hold's own aliases carry the match");
  assert.ok(sameRunBranch("worktree-feat+x", {}, "feat/x", {}));
  assert.equal(sameRunBranch("feat/x", { slug: "x" }, "worktree-x", { slug: "y" }), false);
  assert.equal(sameRunBranch("feat/y", { slug: "x" }, "worktree-y", { slug: null }), false, "a slugless candidate gets no type aliases");
  assert.equal(sameRunBranch(null, { slug: "x" }, "feat/x", {}), false);
  assert.equal(sameRunBranch("feat/x", {}, undefined, { slug: "x" }), false);
});
