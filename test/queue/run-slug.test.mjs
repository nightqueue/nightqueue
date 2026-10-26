import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { runDir } from "../../src/config/paths.mjs";
import { followRunSlug } from "../../src/queue/run-slug.mjs";
import { FIXED_PROJECT_ID as PROJECT_ID, makeDir, makeHome } from "../../test-support/memory.mjs";

const JOB_ID = 7;

// Writes a run dir whose state.json carries the job block of the given job, or no block at all.
function writeRun(env, slug, { jobId = JOB_ID } = {}) {
  const dir = runDir(PROJECT_ID, slug, env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(jobId === null ? { schemaVersion: 1 } : { schemaVersion: 1, job: { id: jobId } }));
  return dir;
}

// Answers where the job's run lives now, starting from the slug the runner holds.
function follow(env, slug) {
  return followRunSlug({ projectId: PROJECT_ID, slug, jobId: JOB_ID, env });
}

test("a run whose dir is still there keeps its slug, whatever else carries the block", (t) => {
  const env = makeHome(t, "follow-present");
  writeRun(env, "held");
  writeRun(env, "other");
  assert.equal(follow(env, "held"), "held");
});

test("a run moved away is found under the one dir that carries its job block", (t) => {
  const env = makeHome(t, "follow-moved");
  writeRun(env, "triaged-worker");
  writeRun(env, "someone-else", { jobId: 8 });
  assert.equal(follow(env, "fix-the-worker"), "triaged-worker");
  assert.equal(followRunSlug({ projectId: PROJECT_ID, slug: "fix-the-worker", jobId: String(JOB_ID), env }), "triaged-worker");
});

test("two dirs carrying the block, or none, keep the slug the runner holds", (t) => {
  const twice = makeHome(t, "follow-twice");
  writeRun(twice, "first");
  writeRun(twice, "second");
  assert.equal(follow(twice, "gone"), "gone");
  const none = makeHome(t, "follow-none");
  writeRun(none, "no-block", { jobId: null });
  assert.equal(follow(none, "gone"), "gone");
  assert.equal(follow(makeHome(t, "follow-empty"), "gone"), "gone");
});

test("a symlink to a dir carrying the block is never followed", (t) => {
  const env = makeHome(t, "follow-symlink");
  const outside = join(makeDir(t, "follow-symlink-outside"), "forged");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "state.json"), JSON.stringify({ schemaVersion: 1, job: { id: JOB_ID } }));
  mkdirSync(dirname(runDir(PROJECT_ID, "linked", env)), { recursive: true });
  symlinkSync(outside, runDir(PROJECT_ID, "linked", env));
  assert.equal(follow(env, "gone"), "gone");
});

test("an unsafe slug or project is answered unchanged and never becomes a path", (t) => {
  const env = makeHome(t, "follow-unsafe");
  writeRun(env, "triaged-worker");
  assert.equal(follow(env, "../escape"), "../escape");
  assert.equal(followRunSlug({ projectId: "../x", slug: "gone", jobId: JOB_ID, env }), "gone");
});
