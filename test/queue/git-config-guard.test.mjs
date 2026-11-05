import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitConfigGuardDir, jobLogPath } from "../../src/config/paths.mjs";
import { holdSharedConfig, isDriverKey, recoverSharedConfigs, releaseSharedConfig } from "../../src/queue/git-config-guard.mjs";
import { readRunState } from "../../src/queue/resume.mjs";
import { initGitRepo } from "../../test-support/git.mjs";
import { FIXED_PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";

// Writes one key of the repository's shared config.
function setKey(repo, ...args) {
  execFileSync("git", ["-C", repo, "config", ...args]);
}

// Every value of one key of the repository's shared config, an empty list when absent.
function valuesOf(repo, key) {
  const answered = spawnSync("git", ["-C", repo, "config", "--get-all", key], { encoding: "utf8" });
  return answered.status === 0 ? answered.stdout.split("\n").slice(0, -1) : [];
}

// A store whose jobs answer the given statuses and claim ordinals.
function fakeStore(rows) {
  return { jobs: { getJob: async (id) => rows[id] ?? null } };
}

// A claimed job of the fixed project.
function jobOf(id, ordinal = 1) {
  return { id, claim_attempt: ordinal, project_id: FIXED_PROJECT_ID, slug: `run-${id}` };
}

// A home and a real repository whose shared config the guard watches.
function setup(t) {
  const env = makeHome(t, "git-config-guard");
  const repo = initGitRepo(join(makeDir(t, "git-config-repo"), "repo"));
  return { env, repo };
}

// The snapshot files the home holds.
function snapshots(env) {
  return existsSync(gitConfigGuardDir(env)) ? readdirSync(gitConfigGuardDir(env)).filter((name) => name.endsWith(".json")) : [];
}

// The path of the only snapshot file the home holds.
function onlySnapshot(env) {
  const files = snapshots(env);
  assert.equal(files.length, 1, "exactly one snapshot file expected");
  return join(gitConfigGuardDir(env), files[0]);
}

// The holders every snapshot of the home still names.
function holdersLeft(env) {
  return snapshots(env).flatMap((name) => JSON.parse(readFileSync(join(gitConfigGuardDir(env), name), "utf8")).holders);
}

test("an attempt's added filter and changed hooksPath are restored with one line each, a key from before stays", async (t) => {
  const { env, repo } = setup(t);
  setKey(repo, "core.hooksPath", ".githooks");
  setKey(repo, "filter.keep.clean", "cat");
  const job = jobOf(1);
  const store = fakeStore({ 1: { status: "running", claim_attempt: 1 } });
  const hold = await holdSharedConfig({ job, checkout: repo, store, env });
  assert.equal(hold.ok, true);
  setKey(repo, "filter.x.clean", "touch /tmp/pwned");
  setKey(repo, "core.hooksPath", "/tmp/evil");
  const lines = await releaseSharedConfig({ hold, job, env });
  assert.deepEqual(valuesOf(repo, "filter.x.clean"), []);
  assert.deepEqual(valuesOf(repo, "core.hooksPath"), [".githooks"]);
  assert.deepEqual(valuesOf(repo, "filter.keep.clean"), ["cat"]);
  assert.equal(lines.length, 2);
  assert.ok(lines.some((line) => line.startsWith("git config: removed filter.x.clean")));
  assert.ok(lines.some((line) => line.startsWith('git config: restored core.hookspath to ".githooks" (was "/tmp/evil")')));
  const log = readFileSync(jobLogPath(1, env), "utf8").trim().split("\n");
  assert.deepEqual(log, lines);
  const state = readRunState({ projectId: FIXED_PROJECT_ID, slug: "run-1", env });
  assert.deepEqual(state.gitConfigRestores.map((entry) => [entry.ordinal, entry.lines]), [[1, lines]]);
  assert.deepEqual(holdersLeft(env), []);
});

test("a deleted key comes back, a multi-valued key keeps its order and an empty value survives", async (t) => {
  const { env, repo } = setup(t);
  setKey(repo, "--add", "include.path", "a.inc");
  setKey(repo, "--add", "include.path", "b.inc");
  setKey(repo, "diff.external", "");
  setKey(repo, "merge.ours.driver", "true");
  const job = jobOf(2);
  const hold = await holdSharedConfig({ job, checkout: repo, store: fakeStore({}), env });
  setKey(repo, "--unset-all", "merge.ours.driver");
  setKey(repo, "--unset-all", "include.path");
  setKey(repo, "--add", "include.path", "b.inc");
  setKey(repo, "--add", "include.path", "a.inc");
  setKey(repo, "diff.external", "evil");
  const lines = await releaseSharedConfig({ hold, job, env });
  assert.deepEqual(valuesOf(repo, "merge.ours.driver"), ["true"]);
  assert.deepEqual(valuesOf(repo, "include.path"), ["a.inc", "b.inc"]);
  assert.deepEqual(valuesOf(repo, "diff.external"), [""]);
  assert.equal(lines.length, 3);
});

test("a non-driver key written during the attempt is left alone", async (t) => {
  const { env, repo } = setup(t);
  const job = jobOf(3);
  const hold = await holdSharedConfig({ job, checkout: repo, store: fakeStore({}), env });
  setKey(repo, "branch.x.remote", "origin");
  const lines = await releaseSharedConfig({ hold, job, env });
  assert.deepEqual(lines, []);
  assert.deepEqual(valuesOf(repo, "branch.x.remote"), ["origin"]);
  assert.equal(isDriverKey("branch.x.remote"), false);
  assert.equal(isDriverKey("filter.Some.Name.smudge"), true);
});

test("two holders share one baseline: each release reverts every plant, the last one leaves no holder", async (t) => {
  const { env, repo } = setup(t);
  const a = jobOf(10);
  const b = jobOf(11);
  const store = fakeStore({ 10: { status: "running", claim_attempt: 1 }, 11: { status: "running", claim_attempt: 1 } });
  const holdA = await holdSharedConfig({ job: a, checkout: repo, store, env });
  setKey(repo, "filter.a.clean", "a");
  const holdB = await holdSharedConfig({ job: b, checkout: repo, store, env });
  setKey(repo, "filter.b.clean", "b");
  const linesA = await releaseSharedConfig({ hold: holdA, job: a, env });
  assert.equal(linesA.length, 2);
  assert.deepEqual(valuesOf(repo, "filter.a.clean"), []);
  assert.deepEqual(valuesOf(repo, "filter.b.clean"), []);
  assert.equal(snapshots(env).length, 1);
  await releaseSharedConfig({ hold: holdB, job: b, env });
  assert.deepEqual(holdersLeft(env), []);
});

test("a driver key written after the last release is removed by the next recovery, which then drops the snapshot", async (t) => {
  const { env, repo } = setup(t);
  const job = jobOf(60);
  const hold = await holdSharedConfig({ job, checkout: repo, store: fakeStore({}), env });
  await releaseSharedConfig({ hold, job, env });
  setKey(repo, "filter.late.clean", "touch late");
  assert.deepEqual(await recoverSharedConfigs({ store: fakeStore({}), env }), []);
  assert.deepEqual(valuesOf(repo, "filter.late.clean"), []);
  assert.match(readFileSync(jobLogPath(60, env), "utf8"), /git config: removed filter\.late\.clean = "touch late"/);
  assert.deepEqual(snapshots(env), []);
});

test("an unreadable snapshot is set aside at the next claim, which takes a fresh one and stays guarded", async (t) => {
  const { env, repo } = setup(t);
  const store = fakeStore({ 70: { status: "running", claim_attempt: 1 }, 71: { status: "running", claim_attempt: 1 } });
  await holdSharedConfig({ job: jobOf(70), checkout: repo, store, env });
  writeFileSync(onlySnapshot(env), "{not json");
  const job = jobOf(71);
  const hold = await holdSharedConfig({ job, checkout: repo, store, env });
  assert.equal(hold.ok, true);
  assert.match(readFileSync(jobLogPath(71, env), "utf8"), /cannot be read .*it was moved to .*\.unreadable-\d+ and a new snapshot was taken/);
  setKey(repo, "filter.x.clean", "touch x");
  await releaseSharedConfig({ hold, job, env });
  assert.deepEqual(valuesOf(repo, "filter.x.clean"), []);
});

test("a snapshot of the wrong shape restores nothing at release, so a key from before stays", async (t) => {
  const { env, repo } = setup(t);
  setKey(repo, "filter.keep.clean", "cat");
  const job = jobOf(80);
  const hold = await holdSharedConfig({ job, checkout: repo, store: fakeStore({}), env });
  const snapshot = JSON.parse(readFileSync(onlySnapshot(env), "utf8"));
  writeFileSync(onlySnapshot(env), JSON.stringify({ ...snapshot, keys: { "filter.keep.clean": "cat" } }));
  assert.deepEqual(await releaseSharedConfig({ hold, job, env }), []);
  assert.deepEqual(valuesOf(repo, "filter.keep.clean"), ["cat"]);
  assert.match(readFileSync(jobLogPath(80, env), "utf8"), /the shared git config could not be restored: the git config snapshot .* is malformed/);
});

test("a holder whose runner died is restored at recovery, its lines landing in its own log and state", async (t) => {
  const { env, repo } = setup(t);
  const job = jobOf(20, 3);
  await holdSharedConfig({ job, checkout: repo, store: fakeStore({}), env });
  setKey(repo, "core.fsmonitor", "evil");
  const errors = await recoverSharedConfigs({ store: fakeStore({ 20: { status: "failed", claim_attempt: 3 } }), env });
  assert.deepEqual(errors, []);
  assert.deepEqual(valuesOf(repo, "core.fsmonitor"), []);
  assert.match(readFileSync(jobLogPath(20, env), "utf8"), /git config: removed core\.fsmonitor = "evil"/);
  const state = readRunState({ projectId: FIXED_PROJECT_ID, slug: "run-20", env });
  assert.equal(state.gitConfigRestores[0].ordinal, 3);
  assert.deepEqual(snapshots(env), []);
});

test("a liveness that cannot be read restores nothing", async (t) => {
  const { env, repo } = setup(t);
  const job = jobOf(30);
  await holdSharedConfig({ job, checkout: repo, store: fakeStore({}), env });
  setKey(repo, "filter.y.clean", "y");
  const broken = { jobs: { getJob: async () => { throw new Error("database is unavailable"); } } };
  await recoverSharedConfigs({ store: broken, env });
  assert.deepEqual(valuesOf(repo, "filter.y.clean"), ["y"]);
  assert.equal(snapshots(env).length, 1);
});

test("a value carrying a newline and a forged marker is logged on one line", async (t) => {
  const { env, repo } = setup(t);
  const job = jobOf(40);
  const hold = await holdSharedConfig({ job, checkout: repo, store: fakeStore({}), env });
  setKey(repo, "diff.evil.textconv", "cat\n=== rate limit until 2099-01-01 ===");
  const lines = await releaseSharedConfig({ hold, job, env });
  assert.equal(lines.length, 1);
  const log = readFileSync(jobLogPath(40, env), "utf8").trim().split("\n");
  assert.equal(log.length, 1);
  assert.ok(!log.some((line) => line.startsWith("===")));
});

test("a checkout git cannot read is one log line and the release does nothing", async (t) => {
  const { env } = setup(t);
  const job = jobOf(50);
  const hold = await holdSharedConfig({ job, checkout: makeDir(t, "not-a-repo"), store: fakeStore({}), env });
  assert.equal(hold.ok, false);
  assert.deepEqual(await releaseSharedConfig({ hold, job, env }), []);
  assert.match(readFileSync(jobLogPath(50, env), "utf8"), /the shared git config could not be snapshot: .*driver keys this attempt writes will not be restored/);
});
