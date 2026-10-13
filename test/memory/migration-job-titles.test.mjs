import assert from "node:assert/strict";
import { test } from "node:test";
import { closeDb, openDb } from "../../src/memory/db.mjs";
import { addJob, claimJobById, finishJob, getJob } from "../../src/memory/jobs.mjs";
import { ensureProject, makeHome, makeProject } from "../../test-support/memory.mjs";

const WORKER = "host:5151";
const PR_URL = "https://github.com/acme/app/pull/7";

// Queues a job of `alpha` with the given close checklist text (null for none).
function jobWithClose(env, close) {
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  openDb(env).prepare("UPDATE jobs SET close = ? WHERE id = ?").run(close, id);
  return id;
}

// Takes the title columns off a current home, as a database written before them has it.
function dropTitleColumns(env) {
  openDb(env).exec("ALTER TABLE jobs DROP COLUMN title; ALTER TABLE jobs DROP COLUMN pr_title;");
  closeDb(env);
}

test("a home without the title columns gains them and backfills the pull request title from the close checklist, never throwing on an odd row", (t) => {
  const env = makeHome(t, "migration-job-titles");
  makeProject(t, env, "alpha");
  const titled = jobWithClose(env, JSON.stringify({ data: { title: "  fix(discord): accept links  " } }));
  const untitled = jobWithClose(env, JSON.stringify({ data: { prNumber: 7 } }));
  const odd = [
    jobWithClose(env, "not json at all"),
    jobWithClose(env, "[1, 2]"),
    jobWithClose(env, JSON.stringify({ data: "text" })),
    jobWithClose(env, JSON.stringify({ data: { title: 42 } })),
    jobWithClose(env, JSON.stringify({ data: { title: "   " } })),
    jobWithClose(env, null),
  ];
  dropTitleColumns(env);
  const db = openDb(env);
  assert.equal(getJob(titled, env).pr_title, "fix(discord): accept links");
  for (const id of [untitled, ...odd]) assert.equal(getJob(id, env).pr_title, null, `job ${id} got a title it never had`);
  assert.equal(getJob(titled, env).title, null);
  db.prepare("UPDATE jobs SET pr_title = 'edited' WHERE id = ?").run(titled);
  closeDb(env);
  assert.equal(getJob(titled, env).pr_title, "edited", "a second open overwrote a title already there");
});

test("finishing a job records the pull request title it was given, on one line", (t) => {
  const env = makeHome(t, "finish-pr-title");
  makeProject(t, env, "alpha");
  const id = addJob({ projectId: ensureProject(env, "alpha"), prompt: "fix the worker" }, env).id;
  claimJobById(id, { worker: WORKER, cap: 4 }, env);
  finishJob(id, { worker: WORKER, status: "done", result: { status: "done" }, prUrl: PR_URL, prTitle: "feat(queue):  show\nthe title" }, env);
  assert.equal(getJob(id, env).pr_title, "feat(queue): show the title");
});
