import assert from "node:assert/strict";
import { statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { saveRunState } from "../../src/queue/resume.mjs";
import { addedFileDiff, jobFileDiff, MAX_DIFF_BYTES } from "../../src/studio/file-diff.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { addWorktree, git, publishedCheckout } from "../../test-support/worktrees.mjs";

const SLUG = "fix-the-worker";

// A job worktree off a published `main`: a committed rename, an uncommitted edit and an untracked file.
function busyWorktree(t) {
  const { checkout } = publishedCheckout(t, "file-diff");
  writeFileSync(join(checkout, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(join(checkout, "old.txt"), "alpha\nbeta\ngamma\ndelta\n");
  git(["-C", checkout, "add", "a.txt", "old.txt"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
  git(["-C", checkout, "push", "-q", "origin", "main"]);
  const { path } = addWorktree(checkout, "job", { push: false });
  git(["-C", path, "mv", "old.txt", "new name.txt"]);
  git(["-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "rename"]);
  writeFileSync(join(path, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(path, "scratch.txt"), "notes\n");
  return { checkout, path };
}

// A job whose state.json records the given worktree, with the result the runner would have written.
function jobAt(env, worktree, result = null) {
  saveRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env, state: { worktree } });
  return { project_id: FIXED_PROJECT_ID, slug: SLUG, result: result === null ? null : JSON.stringify(result) };
}

test("an edited file answers its unified diff against the merge base, without writing the index or the worktree", async (t) => {
  const env = makeHome(t, "file-diff-mod");
  const { path } = busyWorktree(t);
  const index = git(["-C", path, "rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const statusBefore = git(["-C", path, "status", "--porcelain"]);
  const indexBefore = statSync(index).mtimeMs;
  const answer = await jobFileDiff(jobAt(env, path), "a.txt", env);
  assert.equal(statSync(index).mtimeMs, indexBefore, "the diff read wrote the index");
  assert.equal(git(["-C", path, "status", "--porcelain"]), statusBefore);
  assert.deepEqual([answer.source, answer.kind, answer.base, answer.untracked, answer.binary, answer.truncated], ["worktree", "mod", "origin/main", false, false, false]);
  assert.match(answer.diff, /^@@ -1,3 \+1,3 @@$/m);
  assert.match(answer.diff, /^-two$/m);
  assert.match(answer.diff, /^\+TWO$/m);
});

test("a renamed file answers one rename diff from its old name", async (t) => {
  const env = makeHome(t, "file-diff-ren");
  const { path } = busyWorktree(t);
  const answer = await jobFileDiff(jobAt(env, path), "new name.txt", env);
  assert.deepEqual([answer.kind, answer.from], ["ren", "old.txt"]);
  assert.match(answer.diff, /^rename from old\.txt$/m);
  assert.match(answer.diff, /^rename to new name\.txt$/m);
});

test("an untracked file answers its whole content as added lines", async (t) => {
  const env = makeHome(t, "file-diff-untracked");
  const { path } = busyWorktree(t);
  const answer = await jobFileDiff(jobAt(env, path), "scratch.txt", env);
  assert.deepEqual([answer.source, answer.kind, answer.untracked], ["worktree", "new", true]);
  assert.equal(answer.diff, "@@ -0,0 +1,1 @@\n+notes\n");
});

test("a path the job's diff does not list exactly is refused before anything is read: climbing, absolute, glob, unchanged", async (t) => {
  const env = makeHome(t, "file-diff-refused");
  const { path } = busyWorktree(t);
  const job = jobAt(env, path);
  for (const asked of ["../../etc/passwd", "/etc/passwd", "*.txt", "./a.txt", "a.txt/", "", "a\0.txt", null]) {
    assert.equal(await jobFileDiff(job, asked, env), null, `\`${asked}\` was not refused`);
  }
});

test("an untracked symlink is never followed, even to a file outside the worktree", async (t) => {
  const env = makeHome(t, "file-diff-symlink");
  const { path } = busyWorktree(t);
  const outside = join(makeDir(t, "file-diff-outside"), "secret.txt");
  writeFileSync(outside, "do not read\n");
  symlinkSync(outside, join(path, "link.txt"));
  const answer = await jobFileDiff(jobAt(env, path), "link.txt", env);
  assert.equal(answer.source, "unavailable");
  assert.equal(answer.diff, null);
  assert.match(answer.note, /not a regular file/);
});

test("a large untracked file is cut at the byte cap on a whole line, and a binary one answers binary", async (t) => {
  const env = makeHome(t, "file-diff-large");
  const { path } = busyWorktree(t);
  writeFileSync(join(path, "big.txt"), "0123456789abcdef\n".repeat(200_000));
  writeFileSync(join(path, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const job = jobAt(env, path);
  const big = await jobFileDiff(job, "big.txt", env);
  assert.equal(big.truncated, true);
  assert.ok(Buffer.byteLength(big.diff) <= MAX_DIFF_BYTES + 64, `the diff is ${Buffer.byteLength(big.diff)} bytes`);
  assert.match(big.diff, /\+0123456789abcdef\n$/);
  const image = await jobFileDiff(job, "image.png", env);
  assert.deepEqual([image.binary, image.diff], [true, ""]);
});

test("a released worktree answers unavailable for a recorded file and refuses any other path", async (t) => {
  const env = makeHome(t, "file-diff-released");
  const { checkout, path } = busyWorktree(t);
  git(["-C", checkout, "worktree", "remove", "--force", path]);
  const job = jobAt(env, path, { files: ["a.txt"] });
  const answer = await jobFileDiff(job, "a.txt", env);
  assert.deepEqual([answer.source, answer.diff], ["unavailable", null]);
  assert.match(answer.note, /worktree was released/);
  assert.equal(await jobFileDiff(job, "../../etc/passwd", env), null);
});

test("an added file's diff marks a missing final newline, and an empty file has no hunk", () => {
  assert.equal(addedFileDiff("a\nb"), "@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n");
  assert.equal(addedFileDiff(""), "");
});
