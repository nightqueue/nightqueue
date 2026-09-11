import assert from "node:assert/strict";
import { test } from "node:test";
import { ghPrView } from "../../src/host/gh.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob, getJob, jobView } from "../../src/memory/jobs.mjs";
import { MERGE_SWEEP_LIMIT, PR_CHECK_WINDOW_MS, refreshMergedJobs } from "../../src/queue/merged.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";

const MERGE_SHA = "d3605a5a4d7aaec342d649135cdbd128a042e29d";
const MERGED_AT = "2026-09-11T15:54:01Z";

// A home whose sweep is enabled, because every test home switches it off by default.
function makeSweepHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  delete env.NIGHTSHIFT_NO_PR_CHECK;
  return env;
}

// A delivered job with the pull request URL the sweep will ask gh about.
function deliver(env, { prUrl = "https://github.com/acme/api/pull/42", finishedAt = "2026-09-10 10:00:00" } = {}) {
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET status = 'done', pr_url = ?, finished_at = ? WHERE id = ?").run(prUrl, finishedAt, id);
  return id;
}

// A gh double that answers every pull request the same way and records the URLs it was asked about.
function fakeGh(answer) {
  const calls = [];
  const impl = (url) => {
    calls.push(url);
    return typeof answer === "function" ? answer(url) : answer;
  };
  impl.calls = calls;
  return impl;
}

// The answer of gh for a merged pull request.
function mergedAnswer({ mergedAt = MERGED_AT, mergeSha = MERGE_SHA } = {}) {
  return { ok: true, state: "MERGED", mergedAt, mergeSha };
}

test("a merged pull request turns the delivered job into `merged`, keeping what the run itself wrote", (t) => {
  const env = makeSweepHome(t, "merged-sweep-merged");
  const id = deliver(env);
  const gh = fakeGh(mergedAnswer());

  const report = refreshMergedJobs({ env, ghImpl: gh });
  assert.deepEqual(report, { skipped: null, checked: 1, merged: 1, undetermined: 0 });
  assert.deepEqual(gh.calls, ["https://github.com/acme/api/pull/42"]);

  const row = getJob(id, env);
  assert.equal(row.status, "merged");
  assert.equal(row.merge_sha, MERGE_SHA);
  assert.equal(row.merged_at, "2026-09-11 15:54:01");
  assert.equal(row.finished_at, "2026-09-10 10:00:00", "the sweep rewrote finished_at");
  assert.equal(row.pr_url, "https://github.com/acme/api/pull/42");
  assert.ok(row.pr_checked_at, "the sweep did not stamp the check");

  const view = jobView(row);
  assert.match(view.merged_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(view.pr_checked_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(view.merge_sha, MERGE_SHA);
});

test("an open or closed pull request only stamps the check and leaves the job `done`", (t) => {
  for (const state of ["OPEN", "CLOSED"]) {
    const env = makeSweepHome(t, `merged-sweep-${state.toLowerCase()}`);
    const id = deliver(env);

    const report = refreshMergedJobs({ env, ghImpl: fakeGh({ ok: true, state, mergedAt: null, mergeSha: null }) });
    assert.deepEqual(report, { skipped: null, checked: 1, merged: 0, undetermined: 0 }, state);

    const row = getJob(id, env);
    assert.equal(row.status, "done", state);
    assert.equal(row.merged_at, null, state);
    assert.equal(row.merge_sha, null, state);
    assert.ok(row.pr_checked_at, `${state} left no check stamp`);
  }
});

test("an answer nobody could determine writes nothing and is asked again on the next sweep", (t) => {
  const env = makeSweepHome(t, "merged-sweep-undetermined");
  const id = deliver(env);
  const gh = fakeGh({ ok: false });

  const first = refreshMergedJobs({ env, ghImpl: gh });
  assert.deepEqual(first, { skipped: null, checked: 1, merged: 0, undetermined: 1 });
  assert.equal(getJob(id, env).pr_checked_at, null, "a failed check was stamped as a check");

  const second = refreshMergedJobs({ env, ghImpl: gh });
  assert.deepEqual(second, { skipped: null, checked: 1, merged: 0, undetermined: 1 });
  assert.equal(gh.calls.length, 2, "the job that could not be checked was not retried");
  assert.equal(getJob(id, env).status, "done");
});

test("a gh that throws never ends the sweep of the jobs behind it", (t) => {
  const env = makeSweepHome(t, "merged-sweep-throw");
  const broken = deliver(env, { prUrl: "https://github.com/acme/api/pull/1" });
  const good = deliver(env, { prUrl: "https://github.com/acme/api/pull/2" });
  const gh = fakeGh((url) => {
    if (url.endsWith("/1")) throw new Error("gh exploded");
    return mergedAnswer();
  });

  const report = refreshMergedJobs({ env, ghImpl: gh });
  assert.deepEqual(report, { skipped: null, checked: 2, merged: 1, undetermined: 1 });
  assert.equal(getJob(broken, env).status, "done");
  assert.equal(getJob(good, env).status, "merged");
});

test("a job checked inside the window is not asked about again, and one checked before it is", (t) => {
  const env = makeSweepHome(t, "merged-sweep-window");
  deliver(env);
  const gh = fakeGh({ ok: true, state: "OPEN", mergedAt: null, mergeSha: null });

  const now = new Date("2026-09-11T12:00:00Z");
  refreshMergedJobs({ env, ghImpl: gh, now: () => now });
  assert.equal(gh.calls.length, 1);

  refreshMergedJobs({ env, ghImpl: gh, now: () => new Date(now.getTime() + PR_CHECK_WINDOW_MS - 1000) });
  assert.equal(gh.calls.length, 1, "the sweep asked gh again inside the five minute window");

  refreshMergedJobs({ env, ghImpl: gh, now: () => new Date(now.getTime() + PR_CHECK_WINDOW_MS + 1000) });
  assert.equal(gh.calls.length, 2, "the sweep never asked gh again after the window");
});

test("the sweep never calls gh more than its limit, never-checked jobs first and newest among them", (t) => {
  const env = makeSweepHome(t, "merged-sweep-limit");
  const ids = [];
  for (let n = 1; n <= MERGE_SWEEP_LIMIT + 2; n += 1) ids.push(deliver(env, { prUrl: `https://github.com/acme/api/pull/${n}` }));
  const gh = fakeGh({ ok: false });

  const report = refreshMergedJobs({ env, ghImpl: gh });
  assert.equal(report.checked, MERGE_SWEEP_LIMIT);
  assert.equal(gh.calls.length, MERGE_SWEEP_LIMIT);
  assert.equal(gh.calls[0], `https://github.com/acme/api/pull/${MERGE_SWEEP_LIMIT + 2}`);

  const small = fakeGh({ ok: false });
  assert.equal(refreshMergedJobs({ env, ghImpl: small, limit: 2 }).checked, 2);
});

test("a pull request URL gh could resolve against another repository is never handed to it", (t) => {
  const env = makeSweepHome(t, "merged-sweep-url");
  const foreign = deliver(env, { prUrl: "https://gitlab.com/acme/api/merge_requests/42" });
  const flag = deliver(env, { prUrl: "--repo acme/other" });
  const broken = deliver(env, { prUrl: "https://github.com/acme/api/pull/not-a-number" });
  const gh = fakeGh(mergedAnswer());

  assert.deepEqual(refreshMergedJobs({ env, ghImpl: gh }), { skipped: null, checked: 0, merged: 0, undetermined: 0 });
  assert.deepEqual(gh.calls, []);
  for (const id of [foreign, flag, broken]) assert.equal(getJob(id, env).status, "done");
});

test("the sweep is a no-op when it is switched off and inside an unattended job session", (t) => {
  const env = makeSweepHome(t, "merged-sweep-off");
  const id = deliver(env);
  const gh = fakeGh(mergedAnswer());

  assert.deepEqual(refreshMergedJobs({ env: { ...env, NIGHTSHIFT_NO_PR_CHECK: "1" }, ghImpl: gh }), {
    skipped: "disabled",
    checked: 0,
    merged: 0,
    undetermined: 0,
  });
  assert.deepEqual(refreshMergedJobs({ env: { ...env, NIGHTSHIFT_JOB_ID: "7" }, ghImpl: gh }), {
    skipped: "inside-job",
    checked: 0,
    merged: 0,
    undetermined: 0,
  });
  assert.deepEqual(gh.calls, []);
  assert.equal(getJob(id, env).status, "done");
});

test("a job that left `done` while gh answered is never overwritten with the merge", (t) => {
  const env = makeSweepHome(t, "merged-sweep-race");
  const id = deliver(env);
  const gh = fakeGh(() => {
    openDb(env).prepare("UPDATE jobs SET status = 'pending' WHERE id = ?").run(id);
    return mergedAnswer();
  });

  const report = refreshMergedJobs({ env, ghImpl: gh });
  assert.deepEqual(report, { skipped: null, checked: 1, merged: 0, undetermined: 0 });
  const row = getJob(id, env);
  assert.equal(row.status, "pending", "the sweep overwrote a job that had already left `done`");
  assert.equal(row.merged_at, null);
  assert.equal(row.merge_sha, null);
});

test("a job with no pull request, and one that never finished, are never candidates", (t) => {
  const env = makeSweepHome(t, "merged-sweep-candidates");
  const pending = addJob({ project: "alpha", prompt: "fix the parser" }, env).id;
  const noPr = deliver(env, { prUrl: null });
  const gh = fakeGh(mergedAnswer());

  assert.equal(refreshMergedJobs({ env, ghImpl: gh }).checked, 0);
  assert.equal(getJob(pending, env).status, "pending");
  assert.equal(getJob(noPr, env).status, "done");
});

// A spawnSync double that answers one `gh pr view` call the way the test asked.
function fakeSpawnSync(answer) {
  const calls = [];
  return {
    calls,
    impl: (file, args) => {
      calls.push([file, ...args]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

test("gh pr view is a tri-state: anything it could not read is undetermined, never `not merged`", () => {
  const merged = fakeSpawnSync({ status: 0, stdout: JSON.stringify({ state: "MERGED", mergedAt: MERGED_AT, mergeCommit: { oid: MERGE_SHA } }), stderr: "" });
  assert.deepEqual(ghPrView("https://github.com/acme/api/pull/42", { env: {}, spawnSyncImpl: merged.impl }), {
    ok: true,
    state: "MERGED",
    mergedAt: MERGED_AT,
    mergeSha: MERGE_SHA,
  });
  assert.deepEqual(merged.calls[0], ["gh", "pr", "view", "https://github.com/acme/api/pull/42", "--json", "state,mergedAt,mergeCommit"]);

  const closed = fakeSpawnSync({ status: 0, stdout: JSON.stringify({ state: "CLOSED", mergedAt: null, mergeCommit: null }), stderr: "" });
  assert.deepEqual(ghPrView("https://github.com/acme/api/pull/7", { env: {}, spawnSyncImpl: closed.impl }), {
    ok: true,
    state: "CLOSED",
    mergedAt: null,
    mergeSha: null,
  });

  const missing = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  const undetermined = [
    fakeSpawnSync(missing),
    fakeSpawnSync({ status: 1, stdout: "", stderr: "gh: not authenticated" }),
    fakeSpawnSync({ error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" }),
    fakeSpawnSync({ status: 0, stdout: "not json at all", stderr: "" }),
    fakeSpawnSync({ status: 0, stdout: JSON.stringify({ state: "DRAFT" }), stderr: "" }),
  ];
  for (const spawner of undetermined) {
    assert.deepEqual(ghPrView("https://github.com/acme/api/pull/42", { env: {}, spawnSyncImpl: spawner.impl }), { ok: false });
  }
});
