import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultContext, run } from "../../src/cli/index.mjs";
import { runGitAsync } from "../../src/host/git.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { acquireClose, addJob, getJob } from "../../src/memory/jobs.mjs";
import { mergeStep, runClosePipeline } from "../../src/queue/close.mjs";
import { detachedCloseArgs } from "../../src/queue/close-start.mjs";
import { closeLines, closesSummary, closeStoppedLine } from "../../src/queue/close-view.mjs";
import { findRevertedPaths, parsePathLog, revertNoteLines } from "../../src/queue/revert-guard.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeCloseDeps, gitFail, gitLines, gitOk, HEAD_SHA, openPr, CLOSE_PR_URL } from "../../test-support/close.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const DRAFT_NOTE = "PR #7 is a draft: review the remaining failures, then `gh pr ready 7` and close again";
const IDENTITY = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };

// A home with a `done` job of `alpha` carrying the pull request, whose close lease `worker` holds.
function closeHome(t, name) {
  const env = makeHome(t, name);
  const checkout = makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, branch = 'fix/worker' WHERE id = ?").run(CLOSE_PR_URL, id);
  const worker = "close:test:1:aaaa";
  acquireClose(id, { worker, leaseS: 660 }, env);
  return { env, checkout, id, worker, store: openStore(env) };
}

// Runs one attempt of the real pipeline against the fake gh and git.
async function close(home, fake, options = {}) {
  const outcome = await runClosePipeline({ store: home.store, job: getJob(home.id, home.env), worker: home.worker, env: home.env, deps: fake.deps, timeoutS: 600, checkout: home.checkout, ...options });
  const row = getJob(home.id, home.env);
  return { outcome, row, checklist: JSON.parse(row.close) };
}

// The context the merge step reads when it is called on its own, on a head CI already reported green.
function mergeCtx(checkout, head, changes = {}) {
  return {
    jobId: 3,
    prUrl: CLOSE_PR_URL,
    prNumber: 7,
    project: "alpha",
    branch: "fix/worker",
    slug: null,
    type: null,
    force: false,
    allowDraft: false,
    allowRevert: false,
    checkout,
    nowMs: () => Date.now(),
    remainingMs: () => 600000,
    signal: new AbortController().signal,
    warning: null,
    progress: () => {},
    data: { headSha: head, ciGreenSha: head },
    ...changes,
  };
}

// Runs git in a test repository with a fixed identity, answering its trimmed output.
function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { env: { ...process.env, ...IDENTITY }, encoding: "utf8" }).trim();
}

// Writes (or, for null, deletes) files and commits them, answering the new commit.
function commit(dir, files, message) {
  for (const [name, content] of Object.entries(files)) {
    if (content === null) git(dir, "rm", "-q", "--", name);
    else writeFileSync(join(dir, name), content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

// A real repository whose base `main` (also `origin/main`) is c1 (f1, f2, `a[1] b.txt` at v1), c2 "s2" (f1 v2, `a[1] b.txt` v2), c3 "s3" (f2 v2).
function baseRepo(t, name) {
  const dir = mkdtempSync(join(tmpdir(), `nq-${name}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initGitRepo(dir);
  const c1 = commit(dir, { f1: "v1\n", f2: "v1\n", "a[1] b.txt": "v1\n" }, "s1");
  const c2 = commit(dir, { f1: "v2\n", "a[1] b.txt": "v2\n" }, "s2");
  const c3 = commit(dir, { f2: "v2\n" }, "s3");
  git(dir, "update-ref", "refs/remotes/origin/main", c3);
  return { dir, c1, c2, c3 };
}

// Builds a branch from a commit with the given commits on it, answering its tip; `main` stays checked out after.
function branchFrom(dir, from, commits) {
  git(dir, "checkout", "-q", "--detach", from);
  let tip = from;
  for (const [files, message] of commits) tip = commit(dir, files, message);
  git(dir, "checkout", "-q", "main");
  return tip;
}

// A merge commit of the base tip onto a branch that keeps the branch's tree whole (`-s ours`), answering it.
function oursMerge(dir, branchTip, tip) {
  git(dir, "checkout", "-q", "--detach", branchTip);
  git(dir, "merge", "-q", "-s", "ours", "-m", "merge main", tip);
  const head = git(dir, "rev-parse", "HEAD");
  git(dir, "checkout", "-q", "main");
  return head;
}

// The real git runner of the guard, in one repository.
function realGit(dir) {
  return (args) => runGitAsync({ args, cwd: dir });
}

// Close doubles whose git is the real one of a repository, for the merge step over an open pull request at the head.
function realGitDeps(dir, head, changes = {}) {
  const fake = fakeCloseDeps({ pr: openPr({ headRefOid: head }), ...changes });
  fake.deps.git = async (args, options = {}) => {
    fake.log.git.push({ args, cwd: options.cwd });
    return await runGitAsync({ args, cwd: options.cwd ?? dir, timeoutMs: options.timeoutMs });
  };
  return fake;
}

test("an open draft fails preflight with reason draft and the exact note; nothing re-runs, rebases or merges, and status lists it failed", async (t) => {
  const home = closeHome(t, "draft-preflight");
  const fake = fakeCloseDeps({ pr: openPr({ isDraft: true }) });
  const { outcome, row, checklist } = await close(home, fake);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.step, "preflight");
  assert.equal(outcome.reason, "draft");
  assert.equal(checklist.steps.preflight.note, `draft - ${DRAFT_NOTE}`);
  assert.deepEqual(fake.log.merges, []);
  assert.deepEqual(fake.log.reruns, []);
  assert.deepEqual(fake.log.tests, []);
  assert.deepEqual(fake.log.readies, []);
  assert.equal(fake.log.checkReads, 0);
  assert.equal(gitLines(fake.log).some((line) => line.startsWith("push") || line.startsWith("worktree add")), false);
  const summary = closesSummary([row]);
  assert.deepEqual(summary.failed, [{ id: home.id, step: "preflight", reason: "draft" }]);
  assert.deepEqual(summary.stalled, []);
  assert.match(closeLines(summary)[0], /draft - mark it ready with gh pr ready, then run again with: nightqueue queue close J-\d+ \(or --allow-draft\)$/);
  assert.match(closeStoppedLine(row), /^⛔ close stopped at preflight: draft - mark it ready with gh pr ready/);
});

test("--allow-draft marks the draft ready once, merges it and records markedReady", async (t) => {
  const home = closeHome(t, "draft-allowed");
  const fake = fakeCloseDeps({ pr: openPr({ isDraft: true }) });
  const { outcome, checklist } = await close(home, fake, { allowDraft: true });
  assert.equal(outcome.status, "closed", JSON.stringify(checklist));
  assert.deepEqual(fake.log.readies, [CLOSE_PR_URL]);
  assert.equal(fake.log.merges.length, 1);
  assert.equal(checklist.data.markedReady, true);
  assert.match(checklist.steps.preflight.note, /marked ready with --allow-draft/);
});

test("a pull request drafted after a done preflight fails the merge step with draft, and nothing is merged", async () => {
  const fake = fakeCloseDeps({ pr: openPr({ isDraft: true }) });
  const result = await mergeStep({ ctx: mergeCtx("/work/alpha", HEAD_SHA), deps: fake.deps });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "draft");
  assert.equal(result.note, DRAFT_NOTE);
  assert.equal(result.reopen, undefined);
  assert.deepEqual(fake.log.merges, []);
});

test("a head restoring two files to their version before the last two base commits is found reverting both", async (t) => {
  const { dir, c1, c2, c3 } = baseRepo(t, "revert-two");
  const head = branchFrom(dir, c3, [[{ f1: "v1\n", f2: "v1\n", "a[1] b.txt": "v1\n" }, "restore"]]);
  const found = await findRevertedPaths({ git: realGit(dir), base: "origin/main", head });
  assert.equal(found.ok, true, found.error);
  const byPath = Object.fromEntries(found.reverted.map((item) => [item.path, item]));
  assert.deepEqual(Object.keys(byPath).sort(), ["a[1] b.txt", "f1", "f2"]);
  assert.equal(byPath.f1.backTo, c1);
  assert.deepEqual(byPath.f1.undone, { sha: c2, subject: "s2" });
  assert.equal(byPath.f2.backTo, c1);
  assert.deepEqual(byPath.f2.undone, { sha: c3, subject: "s3" });
  assert.deepEqual(revertNoteLines([byPath.f1]), [`f1 back to ${c1.slice(0, 7)} (undoes ${c2.slice(0, 7)} s2)`]);
});

test("the merge step fails a reverting head with reverts-base, both note lines and no gh pr merge call", async (t) => {
  const { dir, c1, c2, c3 } = baseRepo(t, "revert-merge-step");
  const head = branchFrom(dir, c3, [[{ f1: "v1\n", f2: "v1\n" }, "restore"]]);
  const fake = realGitDeps(dir, head);
  const result = await mergeStep({ ctx: mergeCtx(dir, head), deps: fake.deps });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "reverts-base");
  assert.match(result.note, new RegExp(`f1 back to ${c1.slice(0, 7)} \\(undoes ${c2.slice(0, 7)} s2\\)`));
  assert.match(result.note, new RegExp(`f2 back to ${c1.slice(0, 7)} \\(undoes ${c3.slice(0, 7)} s3\\)`));
  assert.deepEqual(result.data.revertedPaths.sort(), ["f1", "f2"]);
  assert.deepEqual(fake.log.merges, []);
});

test("a merge-commit head that kept the branch's old side is caught, deletions of base-added paths and re-added base deletions included", async (t) => {
  const { dir, c1, c3 } = baseRepo(t, "revert-ours-merge");
  const addX = commit(dir, { x: "x\n" }, "add x");
  const dropF2 = commit(dir, { f2: null }, "drop f2");
  git(dir, "update-ref", "refs/remotes/origin/main", dropF2);
  const branch = branchFrom(dir, c1, [[{ y: "y\n" }, "branch work"]]);
  const head = oursMerge(dir, branch, dropF2);
  const found = await findRevertedPaths({ git: realGit(dir), base: "origin/main", head });
  assert.equal(found.ok, true, found.error);
  const byPath = Object.fromEntries(found.reverted.map((item) => [item.path, item]));
  assert.deepEqual(byPath.x.undone, { sha: addX, subject: "add x" });
  assert.deepEqual(byPath.f2.undone, { sha: c3, subject: "s3" }, "the base's deleted f2 re-added at its older version was not caught");
  assert.ok(byPath.f1, "the old side of f1 was not caught");
  assert.equal(byPath.y, undefined, "the branch's own new file was flagged");
});

test("a change a merge commit brought into the base is caught on the base's first-parent line, never through the side branch", async (t) => {
  const { dir, c2, c3 } = baseRepo(t, "revert-base-merge");
  const side = branchFrom(dir, c3, [[{ f1: "side-a\n" }, "side a"], [{ f1: "side-b\n" }, "side b"]]);
  git(dir, "merge", "-q", "--no-ff", "-m", "merge side", side);
  const merged = git(dir, "rev-parse", "HEAD");
  git(dir, "update-ref", "refs/remotes/origin/main", merged);
  const head = branchFrom(dir, merged, [[{ f1: "v2\n" }, "put f1 back"]]);
  const found = await findRevertedPaths({ git: realGit(dir), base: "origin/main", head });
  assert.equal(found.ok, true, found.error);
  assert.deepEqual(found.reverted, [{ path: "f1", backTo: c2, undone: { sha: merged, subject: "merge side" } }]);
  const sideA = branchFrom(dir, merged, [[{ f1: "side-a\n" }, "back to side a"]]);
  assert.deepEqual((await findRevertedPaths({ git: realGit(dir), base: "origin/main", head: sideA })).reverted, [], "a side-branch state the base never had was flagged");
});

test("a head that deletes a file its own line already had is a plain change, not a revert", async (t) => {
  const { dir, c3 } = baseRepo(t, "revert-plain-delete");
  const head = branchFrom(dir, c3, [[{ f1: null }, "remove f1"]]);
  const found = await findRevertedPaths({ git: realGit(dir), base: "origin/main", head });
  assert.deepEqual(found, { ok: true, reverted: [] });
});

test("a stale head that changed only its own file is not flagged, and it merges", async (t) => {
  const { dir, c1 } = baseRepo(t, "revert-stale");
  const head = branchFrom(dir, c1, [[{ f3: "mine\n" }, "f3 only"]]);
  assert.deepEqual(await findRevertedPaths({ git: realGit(dir), base: "origin/main", head }), { ok: true, reverted: [] });
  git(dir, "branch", "fix/worker", head);
  git(dir, "remote", "add", "origin", dir);
  const fake = realGitDeps(dir, head);
  await mergeStep({ ctx: mergeCtx(dir, head), deps: fake.deps });
  assert.equal(fake.log.merges.length, 1);
});

test("a head whose edit of a base-changed file is a new content (a three-way result) is not flagged", async (t) => {
  const { dir, c3 } = baseRepo(t, "revert-three-way");
  const head = branchFrom(dir, c3, [[{ f1: "v2\nmine\n" }, "edit f1"]]);
  assert.deepEqual(await findRevertedPaths({ git: realGit(dir), base: "origin/main", head }), { ok: true, reverted: [] });
});

test("--allow-revert merges the reverting head and records allowedRevert", async (t) => {
  const { dir, c3 } = baseRepo(t, "revert-allowed");
  const head = branchFrom(dir, c3, [[{ f1: "v1\n", f2: "v1\n" }, "restore"]]);
  const fake = realGitDeps(dir, head);
  const result = await mergeStep({ ctx: mergeCtx(dir, head, { allowRevert: true }), deps: fake.deps });
  assert.equal(fake.log.merges.length, 1);
  assert.equal(result.data.allowedRevert, true);
  assert.match(result.note, /revert guard skipped with --allow-revert/);
});

test("a guard that git cannot run fails closed with revert-check-failed and merges nothing", async () => {
  const fake = fakeCloseDeps({ git: { "diff --raw": gitOk(`:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0f1\0`), "merge-base": gitFail("fatal: boom") } });
  const result = await mergeStep({ ctx: mergeCtx("/work/alpha", HEAD_SHA), deps: fake.deps });
  assert.equal(result.reason, "revert-check-failed");
  assert.match(result.note, /git merge-base failed: fatal: boom/);
  assert.deepEqual(fake.log.merges, []);
});

test("a failed fetch over a stale origin base fails closed with revert-check-failed, and a revert it still sees stays reverts-base", async (t) => {
  const { dir, c2, c3 } = baseRepo(t, "revert-fetch-fail");
  git(dir, "update-ref", "refs/remotes/origin/main", c2);
  const head = branchFrom(dir, c3, [[{ f2: "v1\n" }, "restore f2"]]);
  const stale = realGitDeps(dir, head);
  const result = await mergeStep({ ctx: mergeCtx(dir, head), deps: stale.deps });
  assert.equal(result.reason, "revert-check-failed");
  assert.match(result.note, /git fetch origin main fix\/worker failed, so origin\/main may be stale/);
  assert.deepEqual(stale.log.merges, []);
  git(dir, "update-ref", "refs/remotes/origin/main", c3);
  const fresh = realGitDeps(dir, head);
  assert.equal((await mergeStep({ ctx: mergeCtx(dir, head), deps: fresh.deps })).reason, "reverts-base");
  assert.deepEqual(fresh.log.merges, []);
});

test("a deletion in a SHA-256 repository is recognised by its all-zero id and not flagged", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nq-revert-sha256-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--object-format=sha256", dir]);
  const added = commit(dir, { f: "v1\n", g: "g1\n" }, "add f");
  git(dir, "update-ref", "refs/remotes/origin/main", commit(dir, { g: "g2\n" }, "s2"));
  const head = branchFrom(dir, added, [[{ f: null }, "delete f"]]);
  assert.deepEqual(await findRevertedPaths({ git: realGit(dir), base: "origin/main", head }), { ok: true, reverted: [] });
});

test("the history of a path keeps one entry per first-parent commit and ignores the records of a directory of the same name", () => {
  const record = (meta, path) => `\n${meta}\0${path}\0`;
  const text = [
    `\x1e${"c".repeat(40)}\x1f${"p".repeat(40)}\x1fmake f1 a directory\0`,
    record(`:100644 000000 ${"1".repeat(40)} ${"0".repeat(40)} D`, "f1"),
    `:000000 100644 ${"0".repeat(40)} ${"2".repeat(40)} A\0f1/x\0`,
    `\x1e${"d".repeat(40)}\x1f\x1fadd f1\0`,
    record(`:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A`, "f1"),
  ].join("");
  const entries = parsePathLog(text, "f1");
  assert.deepEqual(
    entries.map((entry) => [entry.subject, entry.oldBlob, entry.parent]),
    [
      ["make f1 a directory", "1".repeat(40), "p".repeat(40)],
      ["add f1", "0".repeat(40), null],
    ],
  );
});

test("the history of a path keeps each commit's sha and subject when a subject or a path holds the log's separators", () => {
  const text = [
    `\x1e${"c".repeat(40)}\x1f${"p".repeat(40)}\x1fs\x1e2\x1fx\0`,
    `\n:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0f\0`,
    `:000000 100644 ${"0".repeat(40)} ${"3".repeat(40)} A\0\x1eodd\0`,
    `\x1e${"d".repeat(40)}\x1f\x1fadd\x1ef\0`,
    `\n:000000 100644 ${"0".repeat(40)} ${"1".repeat(40)} A\0f\0`,
  ].join("");
  assert.deepEqual(
    parsePathLog(text, "f").map((entry) => [entry.sha, entry.subject, entry.oldBlob]),
    [
      ["c".repeat(40), "s\x1e2\x1fx", "1".repeat(40)],
      ["d".repeat(40), "add\x1ef", "0".repeat(40)],
    ],
  );
});

test("queue close forwards --allow-draft and --allow-revert to the detached child, and refuses them with --steps or --merged", async (t) => {
  assert.deepEqual(detachedCloseArgs({ id: 4, force: false, allowDraft: true, allowRevert: true, runtimeDir: "/rt" }).slice(1), ["queue", "close", "4", "--foreground", "--allow-draft", "--allow-revert"]);
  const home = closeHome(t, "draft-cli");
  const calls = [];
  const out = [];
  const err = [];
  const ctx = { ...defaultContext(), env: home.env, out: (line) => out.push(line), err: (line) => err.push(line), spawnImpl: (file, args) => (calls.push(args), { pid: 4242, unref: () => {} }), killImpl: () => true };
  openDb(home.env).prepare("UPDATE jobs SET close_worker = NULL, close_lease_until = NULL WHERE id = ?").run(home.id);
  assert.equal(await run(["queue", "close", String(home.id), "--allow-draft", "--allow-revert"], ctx), 0, err.join("\n"));
  assert.deepEqual(calls[0].slice(1), ["queue", "close", String(home.id), "--foreground", "--allow-draft", "--allow-revert"]);
  assert.notEqual(await run(["queue", "close", "--merged", "--allow-draft"], ctx), 0);
  assert.match(err.join("\n"), /--allow-draft and --allow-revert cannot be combined with --steps or --merged/);
  assert.notEqual(await run(["queue", "close", String(home.id), "--steps", "origin", "--allow-revert"], ctx), 0);
});

test("the queue_close tool accepts allow_draft and allow_revert", async (t) => {
  const env = makeHome(t, "draft-mcp");
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const tool = (await client.listTools()).tools.find((item) => item.name === "queue_close");
  assert.ok(tool.inputSchema.properties.allow_draft, "queue_close has no allow_draft");
  assert.ok(tool.inputSchema.properties.allow_revert, "queue_close has no allow_revert");
});

test("a stopped close names its own way out for draft and reverts-base, and keeps the generic hint for any other reason", () => {
  const row = (reason) => ({ id: 5, status: "done", close_status: "failed", close: JSON.stringify({ steps: {}, data: {}, failed: { step: "merge", reason } }) });
  assert.match(closeStoppedLine(row("draft")), /draft - mark it ready with gh pr ready, then run again with: nightqueue queue close J-5 \(or --allow-draft\)$/);
  assert.match(closeStoppedLine(row("reverts-base")), /reverts-base - review the reverted paths; for an intended revert run again with: nightqueue queue close J-5 --allow-revert$/);
  assert.match(closeStoppedLine(row("checks-red")), /checks-red - run again with: nightqueue queue close J-5$/);
});
