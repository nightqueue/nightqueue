import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { jobLogPath, logsDir, runnerRegistryPath, runnersDir } from "../../src/config/paths.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { ABANDONED_COMMAND_PREFIX } from "../../src/queue/classify.mjs";
import { createPrStateCache } from "../../src/queue/pr-state.mjs";
import { pruneDeadRunners, writeRunnerRecord } from "../../src/queue/registry.mjs";
import { DISABLED_BACKGROUND_ESCAPE_LINE } from "../../src/queue/runner.mjs";
import { shippedLine } from "../../src/queue/ship-view.mjs";
import { closeSuggestion, failedCoreSection, jobDetailView, prUrlsOf, queueView, truncationSuggestion } from "../../src/queue/view.mjs";
import { KEPT_PREFIX } from "../../src/queue/worktree.mjs";
import { withReadOnlyStore } from "../../src/store/open.mjs";
import { makeHome, makeProject } from "../../test-support/memory.mjs";
import { doneStream } from "../../test-support/streams.mjs";

const DEAD_PID = 999_999;

// A kill double that says no process answers for any pid, the way a registration of a dead runner looks.
function deadKill() {
  throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
}

// A home with one project and the jobs of the test written straight into the table.
function seedHome(t, name, jobs) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  for (const { status, prUrl = null } of jobs) {
    const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
    openDb(env).prepare("UPDATE jobs SET status = ?, pr_url = ? WHERE id = ?").run(status, prUrl, id);
  }
  return env;
}

// A done job whose run log carries `runNotice` under `## Notice` and whose row carries `rowNotice` in `notice_md`.
function seedJobWithRunLog(t, name, { runNotice, rowNotice }) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const id = addJob({ project: "alpha", prompt: "fix the worker" }, env).id;
  mkdirSync(logsDir(env), { recursive: true });
  const logPath = jobLogPath(id, env);
  writeFileSync(logPath, doneStream({ notice: runNotice }));
  openDb(env)
    .prepare("UPDATE jobs SET status = 'done', notice_md = ?, result = ? WHERE id = ?")
    .run(rowNotice, JSON.stringify({ logPath }), id);
  return { env, id };
}

// A cache already holding the state gh answered for each URL, without a single process spawned.
async function seededCache(states, env) {
  const cache = createPrStateCache({ viewImpl: async (url) => states[url] });
  await cache.refresh(Object.keys(states), { ...env, NIGHTSHIFT_NO_PR_CHECK: undefined });
  return cache;
}

test("queueView reads jobs, counts and idleness, and decorates each job with the state of its pull request", async (t) => {
  const merged = "https://github.com/acme/api/pull/1";
  const missed = "https://github.com/acme/api/pull/2";
  const closedMerged = "https://github.com/acme/api/pull/3";
  const env = seedHome(t, "view-pr-state", [
    { status: "done", prUrl: merged },
    { status: "done", prUrl: missed },
    { status: "closed", prUrl: closedMerged },
    { status: "done", prUrl: "https://gitlab.com/acme/api/merge_requests/4" },
    { status: "failed" },
  ]);
  const answers = { [merged]: { ok: true, state: "MERGED" }, [closedMerged]: { ok: true, state: "MERGED" } };
  const prStates = await seededCache(answers, env);

  const view = await withReadOnlyStore(env, (store) => queueView(store, { env, prStates, killImpl: deadKill }));
  const stateById = Object.fromEntries(view.jobs.map((job) => [job.id, job.pr_state]));
  assert.deepEqual(stateById, { 1: "merged", 2: "unknown", 3: "merged", 4: null, 5: null });
  assert.deepEqual(view.suggestions, ["#1 PR merged - close it with nightshift queue close 1"], "only a done job with a merged pull request is suggested");
  assert.equal(view.counts.done, 3);
  assert.equal(view.counts.closed, 1);
  assert.equal("merged" in view.counts, false);
  assert.equal(view.registryError, null);
  assert.deepEqual(view.runners, []);
  assert.equal(view.idle, true);
  assert.equal("prompt" in view.jobs[0], false, "the view leaked the prompt");

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, 1, { prStates }));
  assert.equal(detail.pr_state, "merged");
  assert.equal(closeSuggestion([detail]), "#1 PR merged - close it with nightshift queue close 1");
  assert.equal(await withReadOnlyStore(env, (store) => jobDetailView(store, 99, { prStates })), null);

  const withoutCache = await withReadOnlyStore(env, (store) => queueView(store, { env, killImpl: deadKill }));
  assert.equal(withoutCache.jobs.find((job) => job.id === 1).pr_state, "unknown", "a view with no cache did not read a miss as unknown");
  assert.deepEqual(withoutCache.suggestions, []);
});

test("closeSuggestion aggregates every qualifying job into one line, and null answers no jobs, one job or none at all", () => {
  const terminal = (id, status, pr_state) => ({ id, status, pr_state });

  assert.equal(closeSuggestion([]), null);
  assert.equal(closeSuggestion([terminal(1, "done", "open")]), null, "an open pull request qualified");
  assert.equal(closeSuggestion([terminal(1, "running", "merged")]), null, "a running job with a merged pull request qualified");
  assert.equal(closeSuggestion([terminal(1, "failed", "merged")]), "#1 PR merged - close it with nightshift queue close 1", "a failed job with a merged pull request did not qualify");

  const ten = Array.from({ length: 10 }, (_, index) => terminal(index + 1, "done", "merged")).reverse();
  assert.equal(
    closeSuggestion(ten),
    "10 jobs have a merged PR (#10, #9, #8, #7, #6 and 5 more) - close them with nightshift queue close --merged",
  );
});

test("truncationSuggestion answers null for no cut job, names the one cut job, and folds several into one line", () => {
  const cut = (id, flag = "notice_truncated") => ({ id, status: "gate", [flag]: true });

  assert.equal(truncationSuggestion([]), null);
  assert.equal(truncationSuggestion(undefined), null);
  assert.equal(truncationSuggestion([{ id: 1, status: "gate", notice_md: "short" }]), null, "a job whose text fits earned a pointer");
  assert.equal(truncationSuggestion([cut(4)]), "#4 text cut at 500 characters - read it whole with nightshift queue status 4");
  assert.equal(truncationSuggestion([cut(4, "result_truncated")]), "#4 text cut at 500 characters - read it whole with nightshift queue status 4", "a cut result earned no pointer");
  assert.equal(
    truncationSuggestion([cut(9), { id: 8, status: "done" }, cut(7, "result_truncated")]),
    "2 jobs have text cut at 500 characters (#9, #7) - read each whole with nightshift queue status <id>",
  );

  const seven = Array.from({ length: 7 }, (_, index) => cut(index + 1)).reverse();
  assert.equal(
    truncationSuggestion(seven),
    "7 jobs have text cut at 500 characters (#7, #6, #5, #4, #3 and 2 more) - read each whole with nightshift queue status <id>",
  );
});

test("queueView lists the truncation pointer after the close suggestion only when a listed text was cut", async (t) => {
  const merged = "https://github.com/acme/api/pull/1";
  const env = seedHome(t, "view-truncation", [{ status: "done", prUrl: merged }, { status: "gate" }, { status: "gate" }]);
  openDb(env).prepare("UPDATE jobs SET notice_md = ? WHERE id = 2").run("x".repeat(1500));
  openDb(env).prepare("UPDATE jobs SET notice_md = ? WHERE id = 3").run("fits");
  const prStates = await seededCache({ [merged]: { ok: true, state: "MERGED" } }, env);

  const view = await withReadOnlyStore(env, (store) => queueView(store, { env, prStates, killImpl: deadKill }));
  assert.deepEqual(view.suggestions, [
    "#1 PR merged - close it with nightshift queue close 1",
    "#2 text cut at 500 characters - read it whole with nightshift queue status 2",
  ]);
  assert.equal(view.jobs.find((job) => job.id === 2).notice_truncated, true);
  assert.equal("notice_truncated" in view.jobs.find((job) => job.id === 3), false, "a notice that fits carries the flag key");

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, 2, { prStates }));
  assert.equal(detail.notice_md, "x".repeat(1500), "the detail of one job was cut");
  assert.equal("notice_truncated" in detail, false);
});

test("a status outside the job status enum earns its own advisory in suggestions, singular and plural correct, and never breaks the counts", async (t) => {
  const env = seedHome(t, "view-unknown-status", [{ status: "merged" }, { status: "merged" }, { status: "done" }]);

  const view = await withReadOnlyStore(env, (store) => queueView(store, { env, killImpl: deadKill }));
  assert.deepEqual(view.suggestions, ["2 jobs carry the unknown status 'merged'; run nightshift doctor"]);
  assert.equal("merged" in view.counts, false, "the unknown status leaked into the known counts");
  assert.equal(view.counts.done, 1);

  const single = seedHome(t, "view-unknown-status-one", [{ status: "weird" }]);
  const singleView = await withReadOnlyStore(single, (store) => queueView(store, { env: single, killImpl: deadKill }));
  assert.deepEqual(singleView.suggestions, ["1 job carries the unknown status 'weird'; run nightshift doctor"]);
});

test("queueView on a read-only store never prunes: a dead runner's registration is still on disk afterwards", async (t) => {
  const env = seedHome(t, "view-no-prune", [{ status: "pending" }]);
  writeRunnerRecord({ pid: DEAD_PID, startedAt: new Date().toISOString(), mode: "watch", intervalS: 30, logPath: "/tmp/dead.log" }, env);
  const pidfile = runnerRegistryPath(DEAD_PID, env);
  assert.equal(existsSync(pidfile), true, "setup: the registration was not written");

  const view = await withReadOnlyStore(env, (store) => queueView(store, { env, killImpl: deadKill }));
  assert.deepEqual(view.runners, [], "a dead registration was reported as a live runner");
  assert.equal(view.counts.pending, 1);
  assert.equal(view.idle, false, "a pending job with no runner reads as idle");
  assert.equal(existsSync(pidfile), true, "the view pruned a registration: a read wrote to the file system");

  assert.deepEqual(pruneDeadRunners(env, deadKill), [pidfile], "setup: a prune would not have removed this registration, so the check above proves nothing");
  assert.equal(existsSync(pidfile), false);
});

test("sections name jobs, counts, runners, advisories and ships, each read with an integer elapsed time", async (t) => {
  const env = seedHome(t, "view-sections", [{ status: "pending" }]);
  const view = await withReadOnlyStore(env, (store) => queueView(store, { env, killImpl: deadKill }));
  assert.deepEqual(view.sections.map((section) => section.name), ["jobs", "counts", "runners", "advisories", "ships"]);
  for (const section of view.sections) {
    assert.equal(section.ok, true, `${section.name}: ${section.error}`);
    assert.equal(section.error, null);
    assert.ok(Number.isInteger(section.ms) && section.ms >= 0, `${section.name} took ${section.ms}`);
  }
});

test("a registry that cannot be listed fails the runners section, and the view still answers", async (t) => {
  const env = seedHome(t, "view-registry-file", [{ status: "pending" }]);
  writeFileSync(runnersDir(env), "not a directory\n");

  const view = await withReadOnlyStore(env, (store) => queueView(store, { env, killImpl: deadKill }));
  const runners = view.sections.find((section) => section.name === "runners");
  assert.equal(runners.ok, false);
  assert.ok(runners.error, "the failed section carries no error");
  assert.equal(view.registryError, runners.error);
  assert.deepEqual(view.runners, []);
  assert.equal(view.idle, false);
  assert.equal(view.counts.pending, 1, "a failed registry cost the view its counts");
});

test("a store whose listing throws fails the jobs section with its first line, and the view does not throw", async () => {
  const store = {
    jobs: {
      listJobs: async () => {
        throw new Error("disk I/O error\nat somewhere");
      },
      countsByStatus: async () => ({ pending: 0, running: 0, done: 0, gate: 0, failed: 0, cancelled: 0, closed: 0 }),
      countPendingBlocked: async () => 0,
      countActiveJobs: async () => 0,
      countActiveJobsByProject: async () => [],
    },
  };
  const env = { NIGHTSHIFT_HOME: "/nonexistent/nightshift-view-home" };

  const view = await queueView(store, { env, killImpl: deadKill });
  const jobs = view.sections.find((section) => section.name === "jobs");
  assert.deepEqual({ ok: jobs.ok, error: jobs.error }, { ok: false, error: "disk I/O error" });
  assert.deepEqual(view.jobs, []);
  assert.deepEqual(failedCoreSection(view), view.sections[0]);
  assert.equal(view.idle, false, "a view that could not list the jobs claims the queue is idle");
});

test("prUrlsOf keeps only the URLs a job carries, and tolerates rows that are gone", () => {
  assert.deepEqual(prUrlsOf([{ pr_url: "https://github.com/acme/api/pull/1" }, { pr_url: null }, null, {}]), ["https://github.com/acme/api/pull/1"]);
  assert.deepEqual(prUrlsOf(undefined), []);
});

test("jobDetailView hides run_notice when the row's notice differs from the run's only by the worktree-kept line the runtime appended", async (t) => {
  const runNotice = "## Requires user confirmation\n\nmay this touch the payments table?";
  const rowNotice = `${runNotice}\n\n${KEPT_PREFIX}/tmp/wt-52 - it has uncommitted changes.`;
  const { env, id } = seedJobWithRunLog(t, "view-run-notice-worktree", { runNotice, rowNotice });

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal(detail.notice_md, rowNotice);
  assert.equal("run_notice" in detail, false, "the worktree line the runtime appended made the notices look different");
});

test("jobDetailView hides run_notice when the row's notice differs from the run's only by the abandoned-command line the runtime appended", async (t) => {
  const runNotice = "the run's real notice, kept whole";
  const rowNotice = `${runNotice}\n\n${ABANDONED_COMMAND_PREFIX}npm test`;
  const { env, id } = seedJobWithRunLog(t, "view-run-notice-abandoned", { runNotice, rowNotice });

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal(detail.notice_md, rowNotice);
  assert.equal("run_notice" in detail, false, "the abandoned-command line the runtime appended made the notices look different");
});

test("jobDetailView hides run_notice when the row's notice differs from the run's only by the Shipped line a ship appended", async (t) => {
  const runNotice = "the run's real notice, kept whole";
  const rowNotice = `${runNotice}\n\n${shippedLine({ number: 7, sha: "abc1234def", at: "2026-09-21T10:00:00Z" })}`;
  const { env, id } = seedJobWithRunLog(t, "view-run-notice-shipped", { runNotice, rowNotice });

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal(detail.notice_md, `${runNotice}\n\nShipped: PR #7 merged as abc1234 on 2026-09-21`);
  assert.equal("run_notice" in detail, false, "the Shipped line a ship appended made the notices look different");
});

test("jobDetailView hides run_notice when the row's notice carries every line the runtime appends, in a row", async (t) => {
  const runNotice = "the run's real notice, kept whole";
  const rowNotice = `${runNotice}\n\n${ABANDONED_COMMAND_PREFIX}npm test\n\n${KEPT_PREFIX}/tmp/wt-52 - it has uncommitted changes.\n\n${DISABLED_BACKGROUND_ESCAPE_LINE}`;
  const { env, id } = seedJobWithRunLog(t, "view-run-notice-all-appended", { runNotice, rowNotice });

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal(detail.notice_md, rowNotice);
  assert.equal("run_notice" in detail, false, "the runtime's own appended lines made the notices look different");
});

test("jobDetailView still shows run_notice when the classifier really replaced the run's notice", async (t) => {
  const runNotice = "✅ Delivered the fix and opened the pull request.";
  const rowNotice = 'runtime: the CLI killed the background task "npm test"; the run did not finish';
  const { env, id } = seedJobWithRunLog(t, "view-run-notice-replaced", { runNotice, rowNotice });

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal(detail.notice_md, rowNotice);
  assert.equal(detail.run_notice, runNotice);
});

test("jobDetailView hides run_notice when only trailing whitespace tells the row's notice apart from the run's", async (t) => {
  const runNotice = "the run's real notice, kept whole";
  const rowNotice = `${runNotice}\n\n  `;
  const { env, id } = seedJobWithRunLog(t, "view-run-notice-trailing-space", { runNotice, rowNotice });

  const detail = await withReadOnlyStore(env, (store) => jobDetailView(store, id));
  assert.equal("run_notice" in detail, false, "trailing whitespace alone made the notices look different");
});
