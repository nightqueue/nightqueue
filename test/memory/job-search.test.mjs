import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { searchJobs } from "../../src/memory/job-search.mjs";
import { addJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome, seedDoneJob } from "../../test-support/memory.mjs";

// Queues one pending job of a project and answers its id.
function queue(env, project, prompt) {
  return addJob({ projectId: ensureProject(env, project), prompt }, env).id;
}

test("a search answers only the jobs of its own project, with the title from the prompt and no prompt", (t) => {
  const env = makeHome(t, "job-search-scope");
  const own = queue(env, "alpha", "## Brief\n\nFix the parser crash on empty input");
  queue(env, "beta", "Fix the parser crash on empty input");

  const hits = searchJobs({ query: "parser crash", projectId: ensureProject(env, "alpha") }, env);
  assert.deepEqual(hits, [
    { id: own, ref: `J-${own}`, slug: null, title: "Fix the parser crash on empty input", status: "pending", pr_url: null, finished_at: null },
  ]);
});

test("a notice written after the insert is found, with the pull request and the finish day", (t) => {
  const env = makeHome(t, "job-search-notice");
  const id = seedDoneJob(env, { prompt: "rework the worker", prUrl: "https://github.com/o/r/pull/42", noticeMd: "the descriptor leak is closed" });

  const [hit] = searchJobs({ query: "descriptor leak", projectId: ensureProject(env, "alpha") }, env);
  assert.equal(hit.id, id);
  assert.equal(hit.status, "done");
  assert.equal(hit.pr_url, "https://github.com/o/r/pull/42");
  assert.match(hit.finished_at, /^\d{4}-\d{2}-\d{2}/);
});

test("the excluded job is left out", (t) => {
  const env = makeHome(t, "job-search-exclude");
  const first = queue(env, "alpha", "the runner drops its lease");
  const second = queue(env, "alpha", "the runner renews its lease late");

  const hits = searchJobs({ query: "runner lease", projectId: ensureProject(env, "alpha"), excludeJobId: first }, env);
  assert.deepEqual(
    hits.map((hit) => hit.id),
    [second],
  );
});

test("the limit is clamped to 1..5 and defaults to 5", (t) => {
  const env = makeHome(t, "job-search-limit");
  for (let i = 0; i < 7; i += 1) queue(env, "alpha", `the runner leaks descriptor ${i}`);
  const projectId = ensureProject(env, "alpha");

  assert.equal(searchJobs({ query: "runner", projectId }, env).length, 5);
  assert.equal(searchJobs({ query: "runner", projectId, limit: 50 }, env).length, 5);
  assert.equal(searchJobs({ query: "runner", projectId, limit: 0 }, env).length, 1);
  assert.equal(searchJobs({ query: "runner", projectId, limit: 2 }, env).length, 2);
});

test("an empty query answers nothing and a missing project is refused", (t) => {
  const env = makeHome(t, "job-search-empty");
  queue(env, "alpha", "the runner drops its lease");
  const projectId = ensureProject(env, "alpha");

  assert.deepEqual(searchJobs({ query: "   ", projectId }, env), []);
  assert.deepEqual(searchJobs({ query: null, projectId }, env), []);
  assert.throws(() => searchJobs({ query: "runner" }, env), /projectId/);
});

test("a home opened without the index gets it back with every job in it", (t) => {
  const env = makeHome(t, "job-search-backfill");
  const id = queue(env, "alpha", "the runner drops its lease");
  openDb(env).exec("DROP TABLE jobs_fts");
  closeDb(env);

  const hits = searchJobs({ query: "runner", projectId: ensureProject(env, "alpha") }, env);
  assert.deepEqual(
    hits.map((hit) => hit.id),
    [id],
  );
});

test("a deleted job leaves no row in the index", (t) => {
  const env = makeHome(t, "job-search-delete");
  const id = queue(env, "alpha", "the runner drops its lease");
  const db = openDb(env);
  db.prepare("DELETE FROM jobs WHERE id = ?").run(id);

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs_fts").get().n, 0);
  assert.deepEqual(searchJobs({ query: "runner", projectId: ensureProject(env, "alpha") }, env), []);
});
