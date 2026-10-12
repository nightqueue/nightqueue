import assert from "node:assert/strict";
import { chmodSync, existsSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { saveRunState } from "../../src/queue/resume.mjs";
import { addedFileDiff, BYTE_CAP_NOTE, jobFileDiff, MAX_DIFF_BYTES } from "../../src/studio/file-diff.mjs";
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
  assert.deepEqual([answer.source, answer.kind, answer.base, answer.binary, answer.truncated], ["worktree", "mod", "origin/main", false, false]);
  assert.deepEqual([answer.adds, answer.dels], [1, 1]);
  assert.equal("diff" in answer, false, "the raw diff text is still answered");
  assert.equal(answer.hunks.length, 1);
  assert.equal(answer.hunks[0].header, "@@ -1,3 +1,3 @@");
  assert.deepEqual(answer.hunks[0].lines, [
    { type: "ctx", old: 1, new: 1, text: "one" },
    { type: "del", old: 2, text: "two" },
    { type: "add", new: 2, text: "TWO" },
    { type: "ctx", old: 3, new: 3, text: "three" },
  ]);
});

test("a tracked change over 2000 lines answers the first 2000 lines, truncated, with the whole counts", async (t) => {
  const env = makeHome(t, "file-diff-lines-cap");
  const { path } = busyWorktree(t);
  writeFileSync(join(path, "a.txt"), Array.from({ length: 2101 }, (_, at) => `line ${at}`).join("\n") + "\n");
  const answer = await jobFileDiff(jobAt(env, path), "a.txt", env);
  const lines = answer.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
  assert.equal(answer.truncated, true);
  assert.equal(lines, 2000);
  assert.deepEqual([answer.adds, answer.dels], [2101, 3]);
  assert.equal(answer.note, null, "a line cut alone carries no byte-cut note");
});

// A job worktree off a published `main` whose `min.js` was committed with the given content.
function seededFileWorktree(t, content) {
  const { checkout } = publishedCheckout(t, "file-diff-seeded");
  writeFileSync(join(checkout, "min.js"), content);
  git(["-C", checkout, "add", "min.js"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
  git(["-C", checkout, "push", "-q", "origin", "main"]);
  return addWorktree(checkout, "job", { push: false }).path;
}

test("a tracked change whose lines outrun the byte cap answers the byte-cut note and never a header-only hunk", async (t) => {
  const huge = (char) => char.repeat(1100 * 1024) + "\n";
  for (const [name, seed] of [["both-sides", huge("y")], ["new-side", "small\n"]]) {
    const env = makeHome(t, `file-diff-byte-cut-${name}`);
    const path = seededFileWorktree(t, seed);
    writeFileSync(join(path, "min.js"), huge("x"));
    const answer = await jobFileDiff(jobAt(env, path), "min.js", env);
    assert.equal(answer.truncated, true, name);
    assert.ok(answer.hunks.every((hunk) => hunk.lines.length > 0), `${name}: a hunk with no line was answered`);
    assert.equal(answer.note, BYTE_CAP_NOTE, name);
  }
});

test("a renamed file answers one rename diff from its old name", async (t) => {
  const env = makeHome(t, "file-diff-ren");
  const { path } = busyWorktree(t);
  const answer = await jobFileDiff(jobAt(env, path), "new name.txt", env);
  assert.deepEqual([answer.kind, answer.from, answer.source], ["ren", "old.txt", "worktree"]);
  assert.deepEqual([answer.hunks, answer.adds, answer.dels], [[], 0, 0]);
});

test("an untracked file answers its whole content as added lines", async (t) => {
  const env = makeHome(t, "file-diff-untracked");
  const { path } = busyWorktree(t);
  const answer = await jobFileDiff(jobAt(env, path), "scratch.txt", env);
  assert.deepEqual([answer.source, answer.kind, answer.adds, answer.dels], ["worktree", "new", 1, 0]);
  assert.deepEqual(answer.hunks, [{ header: "@@ -0,0 +1,1 @@", lines: [{ type: "add", new: 1, text: "notes" }] }]);
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
  assert.deepEqual(answer.hunks, []);
  assert.match(answer.note, /not a regular file/);
});

test("a large untracked file is truncated with no count, and a binary one answers binary with no hunk", async (t) => {
  const env = makeHome(t, "file-diff-large");
  const { path } = busyWorktree(t);
  writeFileSync(join(path, "big.txt"), "0123456789abcdef\n".repeat(200_000));
  writeFileSync(join(path, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  const job = jobAt(env, path);
  const big = await jobFileDiff(job, "big.txt", env);
  assert.equal(big.truncated, true);
  assert.deepEqual([big.adds, big.dels], [null, null]);
  assert.equal(big.note, BYTE_CAP_NOTE);
  assert.equal(big.hunks[0].lines.length, 2000);
  assert.deepEqual(big.hunks[0].lines[1999], { type: "add", new: 2000, text: "0123456789abcdef" });
  const image = await jobFileDiff(job, "image.png", env);
  assert.deepEqual([image.binary, image.hunks, image.adds], [true, [], null]);
});

test("an untracked file whose first line outruns the byte cap answers a note, never a silent empty diff", async (t) => {
  const env = makeHome(t, "file-diff-long-line");
  const { path } = busyWorktree(t);
  writeFileSync(join(path, "bundle.min.js"), "x".repeat(2 * MAX_DIFF_BYTES));
  const answer = await jobFileDiff(jobAt(env, path), "bundle.min.js", env);
  assert.deepEqual([answer.hunks, answer.truncated], [[], true]);
  assert.match(answer.note, /too large/);
  assert.ok(MAX_DIFF_BYTES > 0);
});

test("a released worktree answers unavailable for a recorded file and refuses any other path", async (t) => {
  const env = makeHome(t, "file-diff-released");
  const { checkout, path } = busyWorktree(t);
  git(["-C", checkout, "worktree", "remove", "--force", path]);
  const job = jobAt(env, path, { files: ["a.txt"] });
  const answer = await jobFileDiff(job, "a.txt", env);
  assert.deepEqual([answer.source, answer.hunks], ["unavailable", []]);
  assert.match(answer.note, /worktree was released/);
  assert.equal(await jobFileDiff(job, "../../etc/passwd", env), null);
});

// A checkout whose `main` holds a merge commit changing `a.txt`, with the job released: no worktree on disk.
function mergedCheckout(t) {
  const { checkout } = publishedCheckout(t, "file-diff-merge");
  writeFileSync(join(checkout, "a.txt"), "one\ntwo\nthree\n");
  git(["-C", checkout, "add", "a.txt"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
  git(["-C", checkout, "checkout", "-q", "-b", "job"]);
  writeFileSync(join(checkout, "a.txt"), "one\nTWO\nthree\nfour\n");
  writeFileSync(join(checkout, "other.txt"), "not the job's\n");
  git(["-C", checkout, "add", "a.txt", "other.txt"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "job"]);
  git(["-C", checkout, "checkout", "-q", "main"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "-m", "merge job", "job"]);
  return { checkout, sha: git(["-C", checkout, "rev-parse", "HEAD"]).trim() };
}

// A closed job whose worktree is gone, with its recorded files, merge commit and project checkout.
function closedJob(env, { checkout, sha }) {
  return { ...jobAt(env, join(checkout, "gone"), { files: ["a.txt"] }), project_path: checkout, close: { data: { mergeSha: sha } } };
}

test("a released job with a merge commit answers that commit's hunks against its first parent, read-only", async (t) => {
  const env = makeHome(t, "file-diff-merge");
  const merged = mergedCheckout(t);
  const statusBefore = git(["-C", merged.checkout, "status", "--porcelain"]);
  const answer = await jobFileDiff(closedJob(env, merged), "a.txt", env);
  assert.deepEqual([answer.source, answer.kind, answer.adds, answer.dels, answer.truncated], ["merge", "mod", 2, 1, false]);
  assert.deepEqual(
    answer.hunks[0].lines.map((line) => [line.type, line.text]),
    [["ctx", "one"], ["del", "two"], ["add", "TWO"], ["ctx", "three"], ["add", "four"]],
  );
  assert.equal(git(["-C", merged.checkout, "status", "--porcelain"]), statusBefore);
  assert.equal(await jobFileDiff(closedJob(env, merged), "other.txt", env), null, "a file the merge touched but the job did not record was answered");
});

test("a bogus or missing merge sha answers unavailable without reaching git as an option", async (t) => {
  const env = makeHome(t, "file-diff-merge-bogus");
  const merged = mergedCheckout(t);
  const marker = join(makeDir(t, "file-diff-merge-marker"), "x");
  const bogus = await jobFileDiff(closedJob(env, { ...merged, sha: `--output=${marker}` }), "a.txt", env);
  assert.equal(bogus.source, "unavailable");
  assert.equal(existsSync(marker), false, "the bogus sha reached git as an option");
  const missing = await jobFileDiff(closedJob(env, { ...merged, sha: "d".repeat(40) }), "a.txt", env);
  assert.equal(missing.source, "unavailable");
  assert.match(missing.note, /merge commit dddddd/);
  const noCheckout = await jobFileDiff({ ...closedJob(env, merged), project_path: join(merged.checkout, "nope") }, "a.txt", env);
  assert.match(noCheckout.note, /worktree was released/);
});

test("a planted fsmonitor in the project checkout never runs while a merge diff is read", async (t) => {
  const env = makeHome(t, "file-diff-merge-fsmonitor");
  const merged = mergedCheckout(t);
  const marker = join(makeDir(t, "file-diff-fsmonitor-marker"), "ran");
  const script = join(makeDir(t, "file-diff-fsmonitor-script"), "monitor.sh");
  writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
  chmodSync(script, 0o755);
  git(["-C", merged.checkout, "config", "core.fsmonitor", script]);
  git(["-C", merged.checkout, "status", "--porcelain"]);
  assert.equal(existsSync(marker), true, "the planted fsmonitor is not live, so this test proves nothing");
  rmSync(marker);
  const answer = await jobFileDiff(closedJob(env, merged), "a.txt", env);
  assert.equal(answer.source, "merge");
  assert.equal(existsSync(marker), false, "the merge diff read ran the planted fsmonitor");
});

test("an added file's diff marks a missing final newline, and an empty file has no hunk", () => {
  assert.equal(addedFileDiff("a\nb"), "@@ -0,0 +1,2 @@\n+a\n+b\n\\ No newline at end of file\n");
  assert.equal(addedFileDiff(""), "");
});
