import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGit } from "../../src/host/git.mjs";
import { parseJobRef } from "../../src/memory/refs.mjs";
import {
  WIP_SKIP_REASONS,
  commitWip,
  commitWipAsync,
  reanchorWip,
  restoreWip,
  statusEntries,
  wipKeptLine,
  wipMessage,
  wipNoticeLine,
  withWipLine,
} from "../../src/queue/wip-commit.mjs";

const WIP_REF = "refs/nightqueue/wip/s";
import { initGitRepo } from "../../test-support/git.mjs";
import { gitVars } from "../../test-support/worktrees.mjs";

// Runs git in a directory and answers its trimmed output.
function git(env, cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" }).trim();
}

// A main checkout on `main` with a failing pre-commit hook, and a linked worktree on `fix/x` carrying one tracked file.
function makeRepo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nq-wip-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, ...gitVars() };
  const main = initGitRepo(join(root, "main"));
  writeFileSync(join(main, "a.txt"), "one\n");
  git(env, main, "add", "a.txt");
  git(env, main, "commit", "-q", "-m", "base");
  const hook = join(main, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const worktree = join(root, "wt");
  git(env, main, "worktree", "add", "-q", "-b", "fix/x", worktree);
  return { env, main, worktree, base: git(env, worktree, "rev-parse", "HEAD") };
}

// Writes a file under a directory, creating its parents.
function put(dir, path, body = "x\n") {
  const file = join(dir, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, body);
}

// The `commitWip` call of these tests, with the fixed slug, phase and reason.
function commit(env, cwd, extra = {}) {
  return commitWip({ cwd, slug: "s", phase: "qa", reason: "line one\nline two", env, ...extra });
}

test("the wip subject carries the slug, the phase and the first line of the reason, capped at 120 characters", () => {
  assert.equal(wipMessage("s", "qa", "line one\nline two"), "wip(s): terminated at qa — line one");
  const long = wipMessage("s", "qa", "x".repeat(300));
  assert.equal(long, `wip(s): terminated at qa — ${"x".repeat(120)}`);
});

test("a dirty worktree becomes one wip commit despite a failing hook, and tmp/ and .claude/ paths stay untracked", (t) => {
  const { env, worktree, base } = makeRepo(t);
  writeFileSync(join(worktree, "a.txt"), "two\n");
  for (const path of ["new.txt", "tmp/x", "a/tmp/y", ".Claude/z", "tmp/staged"]) put(worktree, path);
  git(env, worktree, "add", "--", "tmp/staged");
  const wip = commit(env, worktree);
  assert.equal(wip.status, "committed", wip.reason);
  assert.equal(wip.commit, git(env, worktree, "rev-parse", "HEAD"));
  assert.equal(wip.branch, "fix/x");
  assert.equal(wip.amended, false);
  assert.deepEqual([...wip.files].sort(), ["a.txt", "new.txt"]);
  assert.equal(git(env, worktree, "rev-parse", "HEAD^"), base);
  assert.equal(git(env, worktree, "log", "-1", "--format=%s"), "wip(s): terminated at qa — line one");
  assert.deepEqual(git(env, worktree, "show", "--name-only", "--format=", "HEAD").split("\n").sort(), ["a.txt", "new.txt"]);
  const untracked = git(env, worktree, "status", "--porcelain", "--untracked-files=all").split("\n").sort();
  assert.deepEqual(untracked, ["?? .Claude/z", "?? a/tmp/y", "?? tmp/staged", "?? tmp/x"]);
});

test("a clean worktree commits nothing", (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "tmp/only");
  assert.deepEqual(commit(env, worktree), { status: "clean", branch: "fix/x", files: [] });
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), base);
});

test("a second terminate amends the run's wip instead of stacking a commit, and with nothing new keeps it", (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "new.txt");
  const first = commit(env, worktree);
  const again = commit(env, worktree, { prior: first });
  assert.deepEqual([again.status, again.commit], ["committed", first.commit]);
  put(worktree, "more.txt");
  const amended = commit(env, worktree, { prior: first });
  assert.equal(amended.amended, true);
  assert.deepEqual([...amended.files].sort(), ["more.txt", "new.txt"]);
  assert.equal(git(env, worktree, "rev-parse", "HEAD^"), base);
});

test("a wip HEAD that neither the record nor the wip ref names, or a human `wip(` commit, is never amended", (t) => {
  const { env, worktree } = makeRepo(t);
  put(worktree, "new.txt");
  const first = commit(env, worktree);
  git(env, worktree, "update-ref", "-d", WIP_REF);
  put(worktree, "more.txt");
  const second = commit(env, worktree, { prior: { ...first, commit: "0".repeat(40) } });
  assert.equal(second.amended, false);
  assert.equal(git(env, worktree, "rev-parse", "HEAD^"), first.commit);
  put(worktree, "hand.txt");
  git(env, worktree, "add", "hand.txt");
  git(env, worktree, "commit", "-q", "--no-verify", "-m", "wip(s): typed by hand");
  const human = git(env, worktree, "rev-parse", "HEAD");
  put(worktree, "later.txt");
  const third = commit(env, worktree);
  assert.equal(third.amended, false);
  assert.equal(git(env, worktree, "rev-parse", "HEAD^"), human);
});

test("the wip commit writes its ref in the same step and answers the ref and the parent", (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "new.txt");
  const wip = commit(env, worktree);
  assert.equal(wip.ref, WIP_REF);
  assert.equal(wip.parent, base);
  assert.equal(git(env, worktree, "rev-parse", WIP_REF), wip.commit);
});

test("a retried terminate whose record was lost adopts the commit its wip ref names instead of answering clean", (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "new.txt");
  const first = commit(env, worktree);
  const again = commit(env, worktree);
  assert.deepEqual([again.status, again.commit, again.amended, again.ref, again.parent], ["committed", first.commit, false, WIP_REF, base]);
  assert.deepEqual(again.files, ["new.txt"]);
  put(worktree, "more.txt");
  const amended = commit(env, worktree);
  assert.equal(amended.amended, true);
  assert.deepEqual([...amended.files].sort(), ["more.txt", "new.txt"]);
  assert.equal(git(env, worktree, "rev-parse", "HEAD^"), base);
  assert.equal(git(env, worktree, "rev-parse", WIP_REF), amended.commit);
});

test("an amend drops every other wip ref that named the replaced commit", (t) => {
  const { env, worktree } = makeRepo(t);
  put(worktree, "new.txt");
  const first = commit(env, worktree);
  git(env, worktree, "update-ref", "refs/nightqueue/wip/other", first.commit);
  put(worktree, "more.txt");
  commit(env, worktree, { prior: first });
  assert.equal(git(env, worktree, "for-each-ref", "--format=%(refname)", "refs/nightqueue/wip/"), WIP_REF);
});

test("a refused ref write undoes the commit and keeps the files on disk", (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "new.txt");
  const gitImpl = (call) => (call.args[0] === "update-ref" ? { ok: false, stdout: "", stderr: "fatal: refused" } : runGit(call));
  const wip = commitWip({ cwd: worktree, slug: "s", phase: "qa", reason: "why", env, gitImpl });
  assert.equal(wip.status, "failed");
  assert.match(wip.reason, /update-ref .* failed: fatal: refused; the commit was undone/);
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), base);
  assert.ok(existsSync(join(worktree, "new.txt")));
});

test("root files named like a glob or a pathspec magic word are committed as themselves and never pull a tmp/ path in", (t) => {
  const { env, worktree } = makeRepo(t);
  for (const path of ["*", ":(top)tmp", "tmp/secret.txt", "tmp/staged"]) put(worktree, path);
  git(env, worktree, "add", "--", "tmp/staged");
  const wip = commit(env, worktree);
  assert.equal(wip.status, "committed", wip.reason);
  assert.deepEqual(git(env, worktree, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort(), ["*", ":(top)tmp", "a.txt"]);
  assert.deepEqual(git(env, worktree, "status", "--porcelain", "--untracked-files=all").split("\n").sort(), ["?? tmp/secret.txt", "?? tmp/staged"]);
});

test("no repository hook runs for the wip commit, not even prepare-commit-msg or post-commit", (t) => {
  const { env, main, worktree } = makeRepo(t);
  const marker = join(worktree, "..", "post-commit-ran");
  for (const [name, body] of [["prepare-commit-msg", "#!/bin/sh\nexit 1\n"], ["post-commit", `#!/bin/sh\ntouch '${marker}'\n`]]) {
    writeFileSync(join(main, ".git", "hooks", name), body);
    chmodSync(join(main, ".git", "hooks", name), 0o755);
  }
  put(worktree, "new.txt");
  const wip = commit(env, worktree);
  assert.equal(wip.status, "committed", wip.reason);
  assert.equal(git(env, worktree, "rev-parse", WIP_REF), git(env, worktree, "rev-parse", "HEAD"));
  assert.equal(existsSync(marker), false, "the post-commit hook ran");
});

test("a commit call that fails after writing the commit undoes it, so no wip commit is left without its ref", (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "new.txt");
  const timedOut = (call) => {
    const result = runGit(call);
    return call.args.includes("commit") ? { ok: false, stdout: "", stderr: "spawnSync git ETIMEDOUT" } : result;
  };
  const wip = commitWip({ cwd: worktree, slug: "s", phase: "qa", reason: "why", env, gitImpl: timedOut });
  assert.equal(wip.status, "failed");
  assert.match(wip.reason, /git commit failed: spawnSync git ETIMEDOUT; the commit it made was undone/);
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), base);
  assert.equal(git(env, worktree, "for-each-ref", "--format=%(refname)", "refs/nightqueue/wip/"), "");
  assert.ok(existsSync(join(worktree, "new.txt")));
});

test("a slug that is not a valid ref name commits nothing", (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "new.txt");
  const wip = commitWip({ cwd: worktree, slug: "bad..slug", phase: "qa", reason: "why", env });
  assert.equal(wip.status, "failed");
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), base);
});

test("a failing second add chunk commits nothing, and the next call stages everything again", (t) => {
  const { env, worktree, base } = makeRepo(t);
  for (let index = 0; index < 501; index += 1) put(worktree, `many/f${index}.txt`);
  let adds = 0;
  const gitImpl = (call) => {
    const isAdd = call.args.includes("add");
    if (isAdd) adds += 1;
    return isAdd && adds === 2 ? { ok: false, stdout: "", stderr: "boom" } : runGit(call);
  };
  assert.equal(commitWip({ cwd: worktree, slug: "s", phase: "qa", reason: "why", env, gitImpl }).status, "failed");
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), base);
  const wip = commit(env, worktree);
  assert.equal(wip.files.length, 501);
  assert.equal(git(env, worktree, "show", "--name-only", "--format=", "HEAD").split("\n").length, 501);
});

test("a signing config never stops the wip commit", (t) => {
  const { env, worktree } = makeRepo(t);
  git(env, worktree, "config", "commit.gpgsign", "true");
  git(env, worktree, "config", "gpg.program", "/nonexistent/signer");
  put(worktree, "new.txt");
  assert.equal(commit(env, worktree).status, "committed");
});

test("the async commit answers the same as the sync one", async (t) => {
  const { env, worktree, base } = makeRepo(t);
  put(worktree, "new.txt");
  const wip = await commitWipAsync({ cwd: worktree, slug: "s", phase: "qa", reason: "line one", env });
  assert.deepEqual([wip.status, wip.parent, wip.ref, wip.files], ["committed", base, WIP_REF, ["new.txt"]]);
  assert.equal(git(env, worktree, "rev-parse", WIP_REF), wip.commit);
});

// The paths HEAD's tree carries, sorted.
function treeOf(env, cwd) {
  return git(env, cwd, "ls-tree", "-r", "--name-only", "HEAD").split("\n").sort();
}

// A worktree whose branch carries the given committed files on top of the base.
function repoWith(t, files) {
  const repo = makeRepo(t);
  for (const path of files) put(repo.worktree, path);
  git(repo.env, repo.worktree, "add", "--", ...files);
  git(repo.env, repo.worktree, "commit", "-q", "--no-verify", "-m", "files");
  return repo;
}

const RENAMES = [
  { label: "a staged rename (R )", act: (env, cwd) => git(env, cwd, "mv", "src/old.js", "src/new.js") },
  {
    label: "an intent-to-add rename ( R)",
    act: (env, cwd) => {
      renameSync(join(cwd, "src", "old.js"), join(cwd, "src", "new.js"));
      git(env, cwd, "add", "-N", "--", "src/new.js");
    },
  },
  {
    label: "a renamed then edited file (RM)",
    act: (env, cwd) => {
      git(env, cwd, "mv", "src/old.js", "src/new.js");
      writeFileSync(join(cwd, "src", "new.js"), "edited\n");
    },
  },
];

for (const { label, act } of RENAMES) {
  test(`${label} is wip-committed under its new path only`, (t) => {
    const { env, worktree } = repoWith(t, ["src/old.js"]);
    act(env, worktree);
    const wip = commit(env, worktree);
    assert.equal(wip.status, "committed", wip.reason);
    assert.deepEqual(wip.files, ["src/new.js"]);
    assert.deepEqual(treeOf(env, worktree), ["a.txt", "src/new.js"]);
  });
}

test("a 4-character rename source is never read as an entry, and a 1-character path is taken", (t) => {
  const { env, worktree } = repoWith(t, ["ab/c", "c"]);
  git(env, worktree, "mv", "ab/c", "ab/d");
  put(worktree, "e");
  const wip = commit(env, worktree);
  assert.deepEqual([...wip.files].sort(), ["ab/d", "e"]);
  assert.deepEqual(treeOf(env, worktree), ["a.txt", "ab/d", "c", "e"]);
});

test("a staged rename out of tmp/ keeps the tmp/ source in the tree and commits only the new path", (t) => {
  const { env, worktree } = repoWith(t, ["tmp/x"]);
  mkdirSync(join(worktree, "src"));
  git(env, worktree, "mv", "tmp/x", "src/x");
  const wip = commit(env, worktree);
  assert.deepEqual(wip.files, ["src/x"]);
  assert.deepEqual(treeOf(env, worktree), ["a.txt", "src/x", "tmp/x"]);
});

test("the status parser reads a copy and a rename in either column with their source paths", () => {
  const raw = "C  copy\0src\0 R new\0old\0?? c\0RM moved\0ab/c\0";
  assert.deepEqual(
    statusEntries(raw).map((entry) => [entry.path, entry.orig]),
    [["copy", "src"], ["new", "old"], ["c", null], ["moved", "ab/c"]],
  );
});

test("the wip never lands on the default branch, the main checkout's branch, a detached HEAD or an adopted worktree", (t) => {
  const { env, main, worktree } = makeRepo(t);
  put(main, "m.txt");
  assert.deepEqual(commit(env, main), { status: "skipped", branch: "main", reason: WIP_SKIP_REASONS.defaultBranch });
  git(env, main, "checkout", "-q", "-b", "dev");
  assert.deepEqual(commit(env, main), { status: "skipped", branch: "dev", reason: WIP_SKIP_REASONS.mainCheckout });
  put(worktree, "new.txt");
  assert.deepEqual(commit(env, worktree, { state: { worktree, adoptedWorktree: worktree } }), { status: "skipped", branch: "fix/x", reason: WIP_SKIP_REASONS.adopted });
  git(env, worktree, "checkout", "-q", "--detach");
  assert.deepEqual(commit(env, worktree), { status: "skipped", branch: null, reason: WIP_SKIP_REASONS.detached });
  assert.match(git(env, worktree, "status", "--porcelain"), /new\.txt/);
});

test("a worktree that is not a git checkout answers failed and never throws", (t) => {
  const { worktree, env } = makeRepo(t);
  const wip = commit(env, join(worktree, "..", "missing"));
  assert.equal(wip.status, "failed");
  assert.ok(wip.reason, "a failed wip names no reason");
});

test("the restore gives the wip a ref names back as uncommitted changes, and keeps the ref", async (t) => {
  const { env, worktree, base } = makeRepo(t);
  writeFileSync(join(worktree, "a.txt"), "two\n");
  put(worktree, "new.txt");
  const wip = commit(env, worktree);
  assert.deepEqual(await restoreWip({ cwd: worktree, env }), {
    status: "restored", commit: wip.commit, short: wip.short, subject: "wip(s): terminated at qa — line one", ref: WIP_REF, parent: base, branch: "fix/x",
  });
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), base);
  assert.equal(git(env, worktree, "symbolic-ref", "--short", "HEAD"), "fix/x");
  assert.deepEqual(git(env, worktree, "status", "--short").split("\n").map((line) => line.trim()).sort(), ["?? new.txt", "M a.txt"]);
  assert.equal(git(env, worktree, "rev-parse", WIP_REF), wip.commit, "the restore dropped the only durable copy");
  assert.deepEqual(await restoreWip({ cwd: worktree, env }), { status: "none", head: base });
});

test("a human `wip(` commit with no ref, or a commit on top of a ref'd wip, is never reset", async (t) => {
  const { env, worktree } = makeRepo(t);
  put(worktree, "human.txt");
  git(env, worktree, "add", "human.txt");
  git(env, worktree, "commit", "-q", "--no-verify", "-m", "wip(s): by hand");
  const human = git(env, worktree, "rev-parse", "HEAD");
  assert.equal((await restoreWip({ cwd: worktree, env })).status, "none");
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), human);
  put(worktree, "new.txt");
  commit(env, worktree);
  put(worktree, "hand.txt");
  git(env, worktree, "add", "hand.txt");
  git(env, worktree, "commit", "-q", "--no-verify", "-m", "by hand");
  const head = git(env, worktree, "rev-parse", "HEAD");
  assert.equal((await restoreWip({ cwd: worktree, env })).status, "none");
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), head);
});

test("a ref'd HEAD whose subject is not a wip is never reset, and a worktree that is gone fails without throwing", async (t) => {
  const { env, worktree, base } = makeRepo(t);
  git(env, worktree, "update-ref", WIP_REF, base);
  assert.equal((await restoreWip({ cwd: worktree, env })).status, "moved");
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), base);
  assert.equal((await restoreWip({ cwd: join(worktree, "..", "missing"), env })).status, "failed");
});

// A wip committed then given back by the restore, as the claim records it.
async function restoredWip(env, worktree) {
  put(worktree, "new.txt");
  commit(env, worktree);
  const { status: _status, ...ids } = await restoreWip({ cwd: worktree, env });
  return { ...ids, status: "committed", restored: true };
}

test("the re-anchor puts the branch back on the restored wip, leaves later edits uncommitted and creates no commit", async (t) => {
  const { env, worktree } = makeRepo(t);
  const wip = await restoredWip(env, worktree);
  put(worktree, "later.txt");
  const before = git(env, worktree, "rev-list", "--all", "--count");
  assert.deepEqual(await reanchorWip({ cwd: worktree, wip, env }), { status: "reanchored", commit: wip.commit });
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), wip.commit);
  assert.equal(git(env, worktree, "symbolic-ref", "--short", "HEAD"), "fix/x");
  assert.equal(git(env, worktree, "rev-list", "--all", "--count"), before);
  assert.deepEqual(git(env, worktree, "status", "--short").split("\n").map((line) => line.trim()), ["?? later.txt"]);
});

test("the re-anchor never resets a HEAD the attempt moved, a record not restored, or a wip whose ref is gone", async (t) => {
  const { env, worktree } = makeRepo(t);
  const wip = await restoredWip(env, worktree);
  assert.deepEqual(await reanchorWip({ cwd: worktree, wip: { ...wip, restored: false }, env }), { status: "none" });
  git(env, worktree, "update-ref", "-d", WIP_REF);
  assert.equal((await reanchorWip({ cwd: worktree, wip, env })).status, "failed");
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), wip.parent);
  git(env, worktree, "update-ref", WIP_REF, wip.commit);
  assert.equal((await reanchorWip({ cwd: worktree, wip: { ...wip, branch: "other" }, env })).status, "failed");
  git(env, worktree, "add", "new.txt");
  git(env, worktree, "commit", "-q", "--no-verify", "-m", "delivery");
  const delivered = git(env, worktree, "rev-parse", "HEAD");
  assert.deepEqual(await reanchorWip({ cwd: worktree, wip, env }), { status: "moved", head: delivered });
  assert.equal(git(env, worktree, "rev-parse", "HEAD"), delivered);
});

const RETRY = "Retry: nightqueue queue retry J-7 (the changes come back uncommitted in the same worktree; add --fresh to start over on a new branch)";
const NOTICE_FORMS = [
  { wip: { status: "committed", short: "abc1234", branch: "fix/x" }, first: "Terminated run: work kept as wip commit abc1234 on branch fix/x (local, never pushed, not reviewed)." },
  { wip: { status: "clean", branch: "fix/x" }, first: "Terminated run: no wip commit, the worktree had no changes." },
  { wip: { status: "skipped", branch: "fix/x", reason: WIP_SKIP_REASONS.adopted }, first: "Terminated run: no wip commit (adopted worktree); the changes stay uncommitted in /w." },
  { wip: { status: "skipped", branch: "main", reason: WIP_SKIP_REASONS.defaultBranch }, first: "Terminated run: no wip commit (default branch); the changes stay uncommitted in /w." },
  { wip: { status: "skipped", branch: "dev", reason: WIP_SKIP_REASONS.mainCheckout }, first: "Terminated run: no wip commit (main checkout's branch); the changes stay uncommitted in /w." },
  { wip: { status: "skipped", branch: null, reason: WIP_SKIP_REASONS.detached }, first: "Terminated run: no wip commit (detached HEAD); the changes stay uncommitted in /w." },
  { wip: { status: "skipped", branch: null, reason: WIP_SKIP_REASONS.noWorktree }, first: "Terminated run: no wip commit (no worktree recorded)." },
  { wip: { status: "failed", branch: "fix/x", reason: "git commit failed: boom" }, first: "Terminated run: the wip commit failed (git commit failed: boom); the changes stay uncommitted in /w." },
];

// The last line of a notice paragraph: the branch a new job can start from, or the detached-HEAD form.
function newJobLine(wip) {
  if (wip.branch) return `New job from it: start_branch: ${wip.branch}`;
  return wip.reason === WIP_SKIP_REASONS.detached ? "New job from it: no branch (detached HEAD)" : null;
}

for (const { wip, first } of NOTICE_FORMS) {
  test(`the notice of a ${wip.status} wip (${wip.reason ?? "no reason"}) carries its exact lines, with and without a job id`, () => {
    const tail = newJobLine(wip);
    const withJob = wipNoticeLine({ wip, jobId: 7, branch: wip.branch, worktree: "/w" });
    assert.deepEqual(withJob.split("\n"), [first, RETRY, ...(tail ? [tail] : [])]);
    assert.equal(parseJobRef(/queue retry (J-\d+) /.exec(withJob)[1]), 7);
    const withoutJob = wipNoticeLine({ wip, jobId: null, branch: wip.branch, worktree: "/w" });
    assert.deepEqual(withoutJob.split("\n"), [first, ...(tail ? [tail] : [])]);
  });
}

test("a non-positive or non-integer job id prints no retry line", () => {
  const wip = NOTICE_FORMS[0].wip;
  for (const jobId of [0, -1, 1.5, "7", Number.NaN]) {
    assert.equal(wipNoticeLine({ wip, jobId, branch: "fix/x", worktree: "/w" }).includes("Retry:"), false, String(jobId));
  }
});

test("a notice carries exactly one wip paragraph however many earlier ones it held", () => {
  const old = wipNoticeLine({ wip: { status: "committed", short: "old1234", branch: "fix/x" }, jobId: 7, branch: "fix/x" });
  const line = wipNoticeLine({ wip: { status: "committed", short: "new5678", branch: "fix/x" }, jobId: 7, branch: "fix/x" });
  const notice = withWipLine(`The run stopped.\n\n${old}\n\n${old}`, line);
  assert.equal(notice, `The run stopped.\n\n${line}`);
  assert.equal(withWipLine("", line), line);
});

test("the kept-wip paragraph names the branch, the short hash and the worktree, and replaces any earlier wip paragraph", () => {
  const kept = wipKeptLine({ wip: { short: "abc1234" }, branch: "fix/x", worktree: "/w" });
  assert.deepEqual(kept.split("\n"), [
    "Wip commit: the branch fix/x keeps the wip commit abc1234 of a terminated attempt (local, never pushed, not reviewed); changes made after it stay uncommitted in /w.",
    "New job from it: start_branch: fix/x",
  ]);
  const old = wipNoticeLine({ wip: { status: "committed", short: "old1234", branch: "fix/x" }, jobId: 7, branch: "fix/x" });
  assert.equal(withWipLine(`The run failed.\n\n${old}\n\n${kept}`, kept), `The run failed.\n\n${kept}`);
});
