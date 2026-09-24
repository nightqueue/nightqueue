import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openDb } from "../../src/memory/db.mjs";
import { saveDecision } from "../../src/memory/decisions.mjs";
import { getJob } from "../../src/memory/jobs.mjs";
import { addRoadmapComment, getRoadmapItemDetail, queueRoadmapItem, saveRoadmapItem, updateRoadmapItem } from "../../src/memory/roadmap.mjs";
import { openStore } from "../../src/store/open.mjs";
import { makeDir, makeHome, makeProject, mergedChecklist, settleThroughStore } from "../../test-support/memory.mjs";

const ROADMAP_MODULE_URL = new URL("../../src/memory/roadmap.mjs", import.meta.url).href;
const PR_URL = "https://github.com/acme/alpha/pull/7";
const MERGE_SHA = mergedChecklist().data.mergeSha;

// A store on a fresh home whose one roadmap item is queued as a job through the store, the way queue_add links it.
async function linkedJob(t, name, type = "improvement") {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const store = openStore(env);
  const item = await store.roadmap.saveRoadmapItem({ type, project: "alpha", title: "follow the job" });
  const { job } = await store.roadmap.queueRoadmapItem({ id: item.id });
  return { env, store, item, job };
}

// Claims the job and finishes it on the given status, through the store the runner uses.
async function runTo(store, job, status, extra = {}) {
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status, ...extra }), true, "setup: the job was not finished");
}

// The comment thread of an item, as the operator reads it.
function thread(env, item) {
  return getRoadmapItemDetail(item.id, {}, env).comments;
}

test("roadmap comments are append-only: an UPDATE or a DELETE is refused by the database", async (t) => {
  const { env, item } = await linkedJob(t, "roadmap-comments-append-only");
  const db = openDb(env);
  assert.throws(() => db.prepare("UPDATE roadmap_comments SET body = 'rewritten' WHERE item_id = ?").run(item.id), /append-only/);
  assert.throws(() => db.prepare("DELETE FROM roadmap_comments WHERE item_id = ?").run(item.id), /append-only/);
  assert.equal(thread(env, item).length, 1);
});

test("queue, gate, retry, done and close leave queued, gate, queued, pr and closed, each signed by the job", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-comments-lifecycle");
  await runTo(store, job, "gate", { noticeMd: "which base branch?" });
  await store.jobs.retryJob(job.id, { note: "use main" });
  await runTo(store, job, "done", { prUrl: PR_URL });
  await settleThroughStore(store, job.id);

  const comments = thread(env, item);
  assert.deepEqual(
    comments.map((comment) => comment.kind),
    ["queued", "gate", "queued", "pr", "closed"],
  );
  assert.ok(comments.every((comment) => comment.author === `job:${job.id}`));
  assert.match(comments[1].body, /stopped at a gate\n\nwhich base branch\?/);
  assert.match(comments[2].body, /re-queued by retry of job #\d+\n\nuse main/);
  assert.match(comments[3].body, new RegExp(`done: ${PR_URL}`));
  assert.equal(comments[4].body, `job #${job.id} closed`);
  assert.deepEqual([comments[4].refs.pr, comments[4].refs.sha], [PR_URL, MERGE_SHA]);
  assert.equal(getRoadmapItemDetail(item.id, {}, env).status, "done");
});

test("running, a release and a park leave no comment", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-comments-quiet");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }));
  assert.equal(await store.jobs.releaseJob(job.id, { worker: "w1" }), true);
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }));
  assert.equal(await store.jobs.parkJob(job.id, { worker: "w1", notBefore: new Date(Date.now() + 60000).toISOString() }), true);
  assert.deepEqual(
    thread(env, item).map((comment) => comment.kind),
    ["queued"],
  );
});

test("a cancel leaves `failed` with its reason", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-comments-cancel");
  await store.jobs.cancelJob(job.id, { reason: "not now" });
  const comments = thread(env, item);
  assert.deepEqual(
    comments.map((comment) => [comment.kind, comment.body]),
    [
      ["queued", `queued as job #${job.id}`],
      ["failed", `job #${job.id} cancelled\n\nnot now`],
    ],
  );
});

test("a close that finds its pull request closed without merge leaves `failed` and moves the item to todo", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-comments-closed-pr");
  await runTo(store, job, "done", { prUrl: PR_URL });
  assert.ok(await store.jobs.acquireClose(job.id, { worker: "close-w", leaseS: 600 }), "setup: the close lease was refused");
  const close = { attempts: 1, steps: {}, data: { prNumber: 7, merged: false } };
  const cancelled = await store.jobs.cancelOnClosedPr(job.id, { worker: "close-w", close, note: "PR #7 was closed without merge" });
  assert.equal(cancelled?.status, "cancelled");

  assert.deepEqual(
    thread(env, item).map((comment) => [comment.kind, comment.body]),
    [
      ["queued", `queued as job #${job.id}`],
      ["pr", `job #${job.id} done: ${PR_URL}`],
      ["failed", `job #${job.id} cancelled\n\nPR #7 was closed without merge`],
    ],
  );
  assert.equal(getRoadmapItemDetail(item.id, {}, env).status, "todo");
});

test("the refs of a comment carry the job's pull request, branch, merge sha, files and proposed decision", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-comments-refs");
  const decision = saveDecision({ project: "alpha", title: "t", context: "c", decision: "d", status: "proposed" }, env);
  openDb(env).prepare("UPDATE decisions SET job_id = ? WHERE id = ?").run(job.id, decision.id);
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }));
  await store.jobs.persistRunFacts(job.id, { worker: "w1", branch: "feat/follow" });
  const result = { status: "done", files: ["src/a.mjs", " ", 7, "test/a.test.mjs"] };
  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL, result }), true);
  await settleThroughStore(store, job.id);

  const [, pr, closed] = thread(env, item);
  const files = [{ path: "src/a.mjs" }, { path: "test/a.test.mjs" }];
  assert.deepEqual(pr.refs, { job_id: job.id, pr: PR_URL, branch: "feat/follow", sha: null, files, decision_id: decision.id });
  assert.deepEqual(closed.refs, { job_id: job.id, pr: PR_URL, branch: "feat/follow", sha: MERGE_SHA, files, decision_id: decision.id });
});

test("a move back from review or done leaves `reopened`, signed by the operator unless a job moved it", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-comments-reopened");
  await runTo(store, job, "done", { prUrl: PR_URL });
  updateRoadmapItem(item.id, { status: "todo" }, env);
  updateRoadmapItem(item.id, { status: "backlog" }, env);
  updateRoadmapItem(item.id, { status: "done" }, env);
  updateRoadmapItem(item.id, { status: "in_review", author: "job:9" }, env);
  const reopened = thread(env, item).filter((comment) => comment.kind === "reopened");
  assert.deepEqual(
    reopened.map((comment) => [comment.author, comment.body]),
    [
      ["operator", "reopened by operator"],
      ["job:9", "reopened by job:9"],
    ],
  );
});

test("a note is signed by its author, and a project viewer never comments nor reads an item it does not see", async (t) => {
  const env = makeHome(t, "roadmap-comments-note");
  makeProject(t, env, "alpha");
  makeProject(t, env, "beta");
  const foreign = saveRoadmapItem({ type: "bug", project: "beta", title: "beta crashes" }, env);
  const note = addRoadmapComment({ id: foreign.id, body: "seen in prod" }, env);
  assert.deepEqual([note.kind, note.author, note.body, note.project], ["note", "operator", "seen in prod", null]);

  assert.throws(() => addRoadmapComment({ id: foreign.id, body: "x", author: "job:1", viewer: "alpha" }, env), /belongs to project `beta`, not project `alpha`/);
  assert.throws(() => getRoadmapItemDetail(foreign.id, { viewer: "alpha" }, env), /belongs to project `beta`/);
  assert.throws(() => addRoadmapComment({ id: foreign.id, body: "x", author: "robot" }, env), /invalid roadmap comment author/);
  assert.throws(() => addRoadmapComment({ id: foreign.id, body: "  " }, env), /`body` is required/);
  assert.equal(getRoadmapItemDetail(foreign.id, {}, env).comments.length, 1, "a refused comment was written");
});

test("a member project reads its org's item but never a sibling project's comment on it", (t) => {
  const env = makeHome(t, "roadmap-comments-org-siblings");
  makeProject(t, env, "alpha", { org: "acme" });
  makeProject(t, env, "beta", { org: "acme" });
  makeProject(t, env, "gamma", { org: "other" });
  const item = saveRoadmapItem({ type: "chore", org: "acme", title: "raise node" }, env);
  addRoadmapComment({ id: item.id, body: "org-wide note" }, env);
  addRoadmapComment({ id: item.id, body: "beta only", author: "job:2", viewer: "beta" }, env);

  const bodies = (viewer) => getRoadmapItemDetail(item.id, { viewer }, env).comments.map((comment) => comment.body);
  assert.deepEqual(bodies("alpha"), ["org-wide note"]);
  assert.deepEqual(bodies("beta"), ["org-wide note", "beta only"]);
  assert.deepEqual(bodies(null), ["org-wide note", "beta only"]);
  assert.throws(() => getRoadmapItemDetail(item.id, { viewer: "gamma" }, env), /belongs to org `acme`, not project `gamma`/);
});

test("the type is required on save, sets the default tier of the job, and an explicit tier wins", async (t) => {
  const env = makeHome(t, "roadmap-comments-type");
  makeProject(t, env, "alpha");
  assert.throws(() => saveRoadmapItem({ project: "alpha", title: "x" }, env), /`type` is required: expected one of bug\|feature\|improvement\|chore\|incident/);
  assert.throws(() => saveRoadmapItem({ project: "alpha", title: "x", type: "epic" }, env), /`type` is required/);

  const expected = { bug: "simple", feature: "complex", improvement: "simple", chore: "trivial", incident: "simple" };
  for (const [type, tier] of Object.entries(expected)) {
    const item = saveRoadmapItem({ project: "alpha", title: `a ${type}`, type }, env);
    const { job } = await queueRoadmapItem({ id: item.id }, env);
    assert.equal(getJob(job.id, env).tier, tier, type);
  }
  const bug = saveRoadmapItem({ project: "alpha", title: "an explicit tier", type: "bug" }, env);
  const { job } = await queueRoadmapItem({ id: bug.id, tier: "complex" }, env);
  assert.equal(getJob(job.id, env).tier, "complex");
  assert.match(getJob(job.id, env).prompt, /## Roadmap item\nRoadmap: alpha#\d+\nType: bug\nCommit type: fix/);
  assert.equal(updateRoadmapItem(bug.id, { type: "incident" }, env).type, "incident");
});

// Source of a child process that follows one job over and over for a while, generated so no PoC lives on disk.
function followerSource() {
  return [
    `import { followJob } from ${JSON.stringify(ROADMAP_MODULE_URL)};`,
    "const [, , jobRaw, durationRaw] = process.argv;",
    "const deadline = Date.now() + Number(durationRaw);",
    "let calls = 0;",
    "while (Date.now() < deadline) { followJob(Number(jobRaw), process.env); calls += 1; }",
    "process.stdout.write(String(calls));",
  ].join("\n");
}

// Runs one follower process to its end.
function runFollower(script, env, jobId) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, String(jobId), "400"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

test("two processes following the same job at once write its comment once", async (t) => {
  const { env, item, job } = await linkedJob(t, "roadmap-comments-race");
  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
  const script = join(makeDir(t, "roadmap-comments-race-script"), "follower.mjs");
  writeFileSync(script, followerSource(), "utf8");

  const results = await Promise.all([runFollower(script, env, job.id), runFollower(script, env, job.id)]);
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    thread(env, item).map((comment) => comment.kind),
    ["queued", "failed"],
  );
});
