import assert from "node:assert/strict";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob } from "../../src/memory/jobs.mjs";
import { MERGE_SWEEP_LIMIT, PR_CHECK_WINDOW_MS, refreshMergedJobs } from "../../src/queue/merged.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

// A home whose sweep is enabled, because every test home switches it off by default.
function makeSweepHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  delete env.NIGHTSHIFT_NO_PR_CHECK;
  return env;
}

// A delivered job with the pull request URL the sweep will ask gh about.
function deliver(env, { prUrl, finishedAt = "2026-09-10 10:00:00" } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, finished_at = ? WHERE id = ?").run(prUrl, finishedAt, id);
  return id;
}

// A gh double that answers per pull request URL and records every URL it was asked about.
function fakeGh(byUrl) {
  const calls = [];
  const impl = (url) => {
    calls.push(url);
    return byUrl(url);
  };
  impl.calls = calls;
  return impl;
}

test("an older merged pull request is never checked while newer open ones keep the window full, forever", (t) => {
  const env = makeSweepHome(t, "merged-backlog-rotation-starve");
  const total = MERGE_SWEEP_LIMIT + 5;
  const ids = [];
  for (let n = 1; n <= total; n += 1) ids.push(deliver(env, { prUrl: `https://github.com/acme/api/pull/${n}` }));
  const oldestId = ids[0];
  const oldestUrl = "https://github.com/acme/api/pull/1";

  // The oldest job's pull request is actually merged; every newer one is a pull request still open, never merged.
  const gh = fakeGh((url) =>
    url === oldestUrl ? { ok: true, state: "MERGED", mergedAt: "2026-09-11T15:54:01Z", mergeSha: "deadbeef" } : { ok: true, state: "OPEN", mergedAt: null, mergeSha: null },
  );

  let clock = new Date("2026-09-11T12:00:00Z");
  const sweeps = 20;
  for (let i = 0; i < sweeps; i += 1) {
    refreshMergedJobs({ env, ghImpl: gh, now: () => clock, limit: MERGE_SWEEP_LIMIT });
    // Advance well past the five-minute re-check window so a stamped newer job becomes eligible again.
    clock = new Date(clock.getTime() + PR_CHECK_WINDOW_MS * 3);
  }

  assert.equal(gh.calls.includes(oldestUrl), true, "the oldest job's pull request was never even asked about");
  assert.equal(getJob(oldestId, env).status, "merged", "the oldest job's actually-merged pull request was never surfaced");
});
