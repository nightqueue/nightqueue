import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { saveRunState } from "../../src/queue/resume.mjs";
import { jobDiffstat } from "../../src/studio/diffstat.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";
import { addWorktree, git, publishedCheckout } from "../../test-support/worktrees.mjs";

const SLUG = "fix-the-worker";

// A job worktree off a published `main`: one committed new file, one uncommitted edit and one untracked file.
function busyWorktree(t) {
  const { checkout } = publishedCheckout(t, "diffstat");
  writeFileSync(join(checkout, "a.txt"), "one\ntwo\nthree\n");
  git(["-C", checkout, "add", "a.txt"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
  git(["-C", checkout, "push", "-q", "origin", "main"]);
  const { path } = addWorktree(checkout, "job", { push: false });
  writeFileSync(join(path, "new file.txt"), "x\ny\n");
  git(["-C", path, "add", "new file.txt"]);
  git(["-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "add a file"]);
  writeFileSync(join(path, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(join(path, "scratch.txt"), "notes\n");
  return { checkout, path };
}

// A job whose state.json records the given worktree, with the result the runner would have written.
function jobAt(env, worktree, result = null) {
  saveRunState({ projectId: FIXED_PROJECT_ID, slug: SLUG, env, state: { worktree } });
  return { project_id: FIXED_PROJECT_ID, slug: SLUG, result: result === null ? null : JSON.stringify(result) };
}

test("a live worktree answers its diff against the merge base, uncommitted edits and untracked files included, without touching the worktree", async (t) => {
  const env = makeHome(t, "diffstat-live");
  const { path } = busyWorktree(t);
  const index = git(["-C", path, "rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  const statusBefore = git(["-C", path, "status", "--porcelain"]);
  const indexBefore = statSync(index).mtimeMs;
  const answer = await jobDiffstat(jobAt(env, path), env);
  assert.equal(statSync(index).mtimeMs, indexBefore, "the diffstat wrote the index");
  assert.equal(answer.source, "worktree");
  assert.equal(answer.base, "origin/main");
  assert.deepEqual(answer.files, [
    { path: "a.txt", added: 1, deleted: 1, kind: "mod" },
    { path: "new file.txt", added: 2, deleted: 0, kind: "new" },
    { path: "scratch.txt", added: null, deleted: null, untracked: true, kind: "new" },
  ]);
  assert.deepEqual(answer.totals, { added: 3, deleted: 1 });
  assert.equal(git(["-C", path, "status", "--porcelain"]), statusBefore);
});

// A job worktree that renames, deletes and edits seeded files, with spaces and non-ASCII names, plus an untracked file.
function reshapedWorktree(t) {
  const { checkout } = publishedCheckout(t, "diffstat-kinds");
  writeFileSync(join(checkout, "a.txt"), "one\ntwo\nthree\nfour\n");
  writeFileSync(join(checkout, "gone.txt"), "bye\n");
  writeFileSync(join(checkout, "keep.txt"), "same\n");
  git(["-C", checkout, "add", "a.txt", "gone.txt", "keep.txt"]);
  git(["-C", checkout, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);
  git(["-C", checkout, "push", "-q", "origin", "main"]);
  const { path } = addWorktree(checkout, "job", { push: false });
  mkdirSync(join(path, "dir é"));
  git(["-C", path, "mv", "a.txt", "dir é/b c.txt"]);
  git(["-C", path, "rm", "-q", "gone.txt"]);
  git(["-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "reshape"]);
  writeFileSync(join(path, "keep.txt"), "changed\n");
  writeFileSync(join(path, "ação nova.txt"), "olá\n");
  return path;
}

test("a live worktree tags each file with its kind: a rename is one ren entry with its old name, a delete del, an edit mod, an untracked file new", async (t) => {
  const env = makeHome(t, "diffstat-kinds");
  const path = reshapedWorktree(t);
  const answer = await jobDiffstat(jobAt(env, path), env);
  assert.equal(answer.source, "worktree");
  const byPath = new Map(answer.files.map((file) => [file.path, file]));
  assert.equal(answer.files.length, 4, `one entry per file, got ${answer.files.map((file) => file.path).join(", ")}`);
  assert.deepEqual(byPath.get("dir é/b c.txt"), { path: "dir é/b c.txt", added: 0, deleted: 0, kind: "ren", from: "a.txt" });
  assert.deepEqual(byPath.get("gone.txt"), { path: "gone.txt", added: 0, deleted: 1, kind: "del" });
  assert.deepEqual(byPath.get("keep.txt"), { path: "keep.txt", added: 1, deleted: 1, kind: "mod" });
  assert.deepEqual(byPath.get("ação nova.txt"), { path: "ação nova.txt", added: null, deleted: null, untracked: true, kind: "new" });
  assert.equal(answer.files.some((file) => file.path === "a.txt"), false, "the rename's old name showed up as its own entry");
});

test("a released worktree answers the run's recorded names with the note, and nothing at all answers none", async (t) => {
  const env = makeHome(t, "diffstat-released");
  const { checkout, path } = busyWorktree(t);
  git(["-C", checkout, "worktree", "remove", "--force", path]);
  const released = await jobDiffstat(jobAt(env, path, { files: ["a.txt", "new file.txt"] }), env);
  assert.equal(released.source, "recorded");
  assert.deepEqual(released.files.map((file) => [file.path, file.added, file.deleted, file.kind]), [["a.txt", null, null, null], ["new file.txt", null, null, null]]);
  assert.equal(released.totals, null);
  assert.match(released.note, /worktree released/);
  const none = await jobDiffstat(jobAt(env, path), env);
  assert.deepEqual([none.source, none.files], ["none", []]);
});

test("a worktree git cannot read falls back to the recorded names with git's reason, never a throw", async (t) => {
  const env = makeHome(t, "diffstat-broken");
  const notARepo = makeDir(t, "diffstat-not-a-repo");
  const answer = await jobDiffstat(jobAt(env, notARepo, { files: ["a.txt"] }), env);
  assert.equal(answer.source, "recorded");
  assert.deepEqual(answer.files.map((file) => file.path), ["a.txt"]);
  assert.match(answer.note, /^the worktree could not be read: /);
});

test("a core.fsmonitor command the job wrote into the repo config is never run by the read", async (t) => {
  const env = makeHome(t, "diffstat-fsmonitor");
  const { path } = busyWorktree(t);
  const scratch = makeDir(t, "diffstat-fsmonitor-scratch");
  const marker = join(scratch, "ran");
  const hook = join(scratch, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\necho ran > "${marker}"\nprintf '\\0'\n`);
  chmodSync(hook, 0o755);
  git(["-C", path, "config", "core.fsmonitor", hook]);
  const answer = await jobDiffstat(jobAt(env, path), env);
  assert.equal(answer.source, "worktree");
  assert.equal(existsSync(marker), false, "the studio read ran the repo-configured fsmonitor");
});

test("a job whose commits already reached the base answers the run's recorded names with a note, never an empty card", async (t) => {
  const env = makeHome(t, "diffstat-merged");
  const { checkout } = publishedCheckout(t, "diffstat-merged");
  const { path } = addWorktree(checkout, "job", { push: false });
  writeFileSync(join(path, "a.txt"), "one\n");
  git(["-C", path, "add", "a.txt"]);
  git(["-C", path, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "job work"]);
  git(["-C", path, "push", "-q", "origin", "HEAD:main"]);
  git(["-C", path, "fetch", "-q", "origin"]);
  const answer = await jobDiffstat(jobAt(env, path, { files: ["a.txt"] }), env);
  assert.equal(answer.source, "recorded");
  assert.deepEqual(answer.files.map((file) => file.path), ["a.txt"]);
  assert.match(answer.note, /already merged/);
});
