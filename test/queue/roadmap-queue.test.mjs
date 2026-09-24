import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { saveDecision, setDecisionEmbedding } from "../../src/memory/decisions.mjs";
import { cancelJob, finishJob, getJob } from "../../src/memory/jobs.mjs";
import {
  buildRoadmapPrompt,
  followJob,
  getRoadmapItem,
  getRoadmapItemDetail,
  queueRoadmapItem,
  saveRoadmapItem,
  updateRoadmapItem,
} from "../../src/memory/roadmap.mjs";
import { openDb } from "../../src/memory/db.mjs";
import { runCycle } from "../../src/queue/runner.mjs";
import { openStore } from "../../src/store/open.mjs";
import { fakeEmbedder, makeDir, makeHome, makeProject, mergedChecklist, settleThroughStore } from "../../test-support/memory.mjs";
import { useFakeClaude } from "../../test-support/queue-fake.mjs";
import { doneStream, SLUG } from "../../test-support/streams.mjs";
import { runDir } from "../../src/config/paths.mjs";

const CLI = fileURLToPath(new URL("../../bin/nightqueue.mjs", import.meta.url));
const PR_URL = "https://github.com/acme/alpha/pull/7";

const LINKED = {
  title: "the heartbeat is renewed by the owner only",
  context: "two runners renewed the same lease",
  decision: "renew the lease only from the worker that owns it",
  consequences: "a lost lease kills the child",
  status: "accepted",
};

const RELATED = {
  title: "heartbeat interval is configuration, never a constant",
  context: "a slow disk timed the lease out",
  decision: "read the heartbeat interval from the configuration",
  status: "accepted",
};

const ITEM = { title: "rewrite runner heartbeat", detail: "the renew path must survive a slow disk" };

const EXPECTED_PROMPT = `## Task
rewrite runner heartbeat

the renew path must survive a slow disk

## Roadmap item
Roadmap: alpha#1
Type: improvement
Commit type: refactor or perf

## Linked decision
#1 the heartbeat is renewed by the owner only (accepted)
Context: two runners renewed the same lease
Decision: renew the lease only from the worker that owns it
Consequences: a lost lease kills the child

## Standing decisions
- #1 the heartbeat is renewed by the owner only
- #2 heartbeat interval is configuration, never a constant

## Related decisions
#2 heartbeat interval is configuration, never a constant (accepted)
Context: a slow disk timed the lease out
Decision: read the heartbeat interval from the configuration`;

// Connects a real stdio client to `nightqueue mcp`, closed at the end of the test.
async function connect(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], env, stderr: "pipe" });
  const client = new Client({ name: "nightqueue-tests", version: "0.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  return client;
}

// Plain text of a tool result.
function textOf(result) {
  return result.content.map((block) => block.text).join("\n");
}

// JSON payload of a successful tool result.
function payloadOf(result) {
  assert.notEqual(result.isError, true, textOf(result));
  return JSON.parse(textOf(result));
}

// A git double for the preflight: a clean checkout of the default branch.
function fakeGit() {
  const answers = { status: "", "rev-parse": "main", "symbolic-ref": "origin/main" };
  return ({ args }) => `${answers[args[0]] ?? ""}\n`;
}

// A home with the registered project, the linked decision, the related one and one roadmap item joining them.
function makeRoadmapHome(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const linked = saveDecision({ project: "alpha", ...LINKED }, env);
  saveDecision({ project: "alpha", ...RELATED }, env);
  const item = saveRoadmapItem({ type: "improvement", project: "alpha", ...ITEM, decision_id: linked.id }, env);
  return { env, item };
}

test("queue_add from a roadmap item builds the prompt of the item and links the two", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-prompt");
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, prompt: null } }));
  assert.equal(queued.ok, true);
  assert.equal(queued.project, "alpha");
  assert.equal(queued.roadmapItemId, item.id);
  assert.equal(getJob(queued.id, env).prompt, EXPECTED_PROMPT);

  const row = getRoadmapItem(item.id, env);
  assert.equal(row.status, "in_progress");
  assert.equal(row.job_id, queued.id);
});

test("an item with no detail and no linked decision queues the task alone", async (t) => {
  const env = makeHome(t, "roadmap-queue-bare");
  makeProject(t, env, "alpha");
  const item = saveRoadmapItem({ type: "chore", project: "alpha", title: "index the logs" }, env);
  const client = await connect(t, env);

  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  assert.equal(getJob(queued.id, env).prompt, "## Task\nindex the logs\n\n## Roadmap item\nRoadmap: alpha#1\nType: chore\nCommit type: chore");
});

test("queue_add refuses two prompt sources, none at all, and a project that is not the item's", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-refusals");
  makeProject(t, env, "beta");
  const client = await connect(t, env);

  const both = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, prompt: "fix the worker" } });
  assert.equal(both.isError, true);
  assert.match(textOf(both), /pass either `prompt` or `roadmap_item_id`, never both/);

  const neither = await client.callTool({ name: "queue_add", arguments: { project: "alpha" } });
  assert.equal(neither.isError, true);
  assert.match(textOf(neither), /queue_add needs `prompt`, or `roadmap_item_id` to build it from a roadmap item/);

  const foreign = await client.callTool({ name: "queue_add", arguments: { project: "beta", roadmap_item_id: item.id } });
  assert.equal(foreign.isError, true);
  assert.match(textOf(foreign), /belongs to project `alpha`, not `beta`/);

  const unknown = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: 404 } });
  assert.equal(unknown.isError, true);
  assert.match(textOf(unknown), /unknown roadmap item `404`/);
  assert.equal(getRoadmapItem(item.id, env).status, "todo");
});

test("a queued item is refused a second job while the first is alive, and accepted once it is cancelled", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-live-job");
  const client = await connect(t, env);

  const first = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  const refused = await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), new RegExp(`already queued as job \`${first.id}\` \\(\`pending\`\\)`));

  cancelJob(first.id, { reason: "no longer needed" }, env);
  const second = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  assert.notEqual(second.id, first.id);
  assert.equal(getRoadmapItem(item.id, env).job_id, second.id);
});

test("a job that ends done puts its own roadmap item in review, and leaves every other one alone", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-done-hook");
  useFakeClaude(env, makeDir(t, "roadmap-queue-done-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const untouched = saveRoadmapItem({ type: "improvement", project: "alpha", title: "index the logs" }, env);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));

  const cycle = await runCycle({ jobId: queued.id, env, deps: { gitImpl: fakeGit() } });

  assert.deepEqual(
    cycle.processed.map((entry) => entry.status),
    ["done"],
  );
  const row = getRoadmapItem(item.id, env);
  assert.equal(row.status, "in_review");
  assert.equal(row.closed_at, null);
  assert.equal(getRoadmapItem(untouched.id, env).status, "todo");
  assert.equal(followJob(queued.id, env), 0, "a second follow moved an item that already followed its job");
});

test("the runner records the files the implementation artifact lists, and the pr comment carries them", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-files");
  useFakeClaude(env, makeDir(t, "roadmap-queue-files-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  const artifactDir = runDir("alpha", SLUG, env);
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "04-implementation.md"), "## Modified files\n- `src/runner.mjs`\n```\nsrc/example.mjs\n```\n\n## Done\n");

  await runCycle({ jobId: queued.id, env, deps: { gitImpl: fakeGit() } });

  assert.deepEqual(JSON.parse(getJob(queued.id, env).result).files, ["src/runner.mjs"]);
  const pr = getRoadmapItemDetail(item.id, {}, env).comments.find((comment) => comment.kind === "pr");
  assert.deepEqual(pr.refs.files, [{ path: "src/runner.mjs" }]);
});

test("a job that ends done moves an item the operator cancelled while it ran, and the link survives as history", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-dropped-item");
  useFakeClaude(env, makeDir(t, "roadmap-queue-dropped-plan"), [{ stdout: doneStream(), exitCode: 0 }]);
  const client = await connect(t, env);
  const queued = payloadOf(await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id } }));
  updateRoadmapItem(item.id, { status: "cancelled" }, env);

  const cycle = await runCycle({ jobId: queued.id, env, deps: { gitImpl: fakeGit() } });

  assert.deepEqual(
    cycle.processed.map((entry) => entry.status),
    ["done"],
  );
  const row = getRoadmapItem(item.id, env);
  assert.equal(row.status, "in_review");
  assert.equal(row.job_id, queued.id, "the link is history and survives a manual status change");
});

test("nightqueue queue add --roadmap builds the same prompt as the tool, from anywhere", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-cli");
  const elsewhere = makeDir(t, "roadmap-queue-cli-cwd");

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id)], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /roadmap item #1 of `alpha` is now `in_progress`/);
  assert.equal(getJob(1, env).prompt, EXPECTED_PROMPT);
  assert.equal(getRoadmapItem(item.id, env).job_id, 1);

  const both = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", "1", "fix", "the", "worker"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /pass either `prompt` or `roadmap_item_id`, never both/);

  const malformed = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", "zero"], { env, cwd: elsewhere, encoding: "utf8" });
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /`--roadmap` expects a positive integer, got `zero`/);
});

test("a job built from a roadmap item carries the operator's tier, through the tool and through the CLI", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-tier");
  const elsewhere = makeDir(t, "roadmap-queue-tier-cwd");
  const client = await connect(t, env);

  const queued = payloadOf(
    await client.callTool({ name: "queue_add", arguments: { roadmap_item_id: item.id, tier: "complex" } }),
  );
  assert.equal(queued.tier, "complex");
  assert.equal(getJob(queued.id, env).tier, "complex");
  cancelJob(queued.id, { reason: "queued again through the CLI" }, env);

  const added = spawnSync(process.execPath, [CLI, "queue", "add", "--roadmap", String(item.id), "--tier", "complex"], {
    env,
    cwd: elsewhere,
    encoding: "utf8",
  });
  assert.equal(added.status, 0, added.stderr);
  assert.equal(getJob(getRoadmapItem(item.id, env).job_id, env).tier, "complex");
});

const RELATED_HEADING = "## Related decisions";
const STANDING_HEADING = "## Standing decisions";
const RECALLED_NON_LINKED = 5;
const FAKE_MODEL = "fake-embedder@v1";
const FAKE_VECTOR = [1, 0, 0, 0];

const LEXICAL_ONLY = {
  title: "the runner claims one job at a time",
  context: "two runners took the same job",
  decision: "claim every job under a lease",
  status: "accepted",
};

const SEMANTIC_ONLY = [
  {
    title: "cold starts pay for the model download",
    context: "the first call was slow",
    decision: "cache the model on disk",
    status: "accepted",
  },
  {
    title: "one worktree per task",
    context: "two tasks wrote the same tree",
    decision: "never share a checkout",
    status: "accepted",
  },
  {
    title: "the pull request is the only delivery",
    context: "local commits were lost",
    decision: "open a pull request at the end",
    status: "accepted",
  },
];

// How many times a heading stands alone as a line of a prompt.
function headingOccurrences(prompt, heading) {
  return prompt.split("\n").filter((line) => line === heading).length;
}

// How many decisions were rendered under `## Related decisions`, which is always the last block of the prompt.
function relatedCount(prompt) {
  const start = prompt.indexOf(RELATED_HEADING);
  if (start < 0) return 0;
  return prompt
    .slice(start + RELATED_HEADING.length)
    .split("\n")
    .filter((line) => /^#\d+ /.test(line)).length;
}

// A home with the semantic path ON: one item, decisions its title recalls lexically, and decisions only an embedder reaches.
function makeEmbeddedHome(t, name) {
  const env = makeHome(t, name, { embed: true });
  makeProject(t, env, "alpha");
  const linked = saveDecision({ project: "alpha", ...LINKED }, env);
  saveDecision({ project: "alpha", ...RELATED }, env);
  saveDecision({ project: "alpha", ...LEXICAL_ONLY }, env);
  for (const decision of SEMANTIC_ONLY) {
    const saved = saveDecision({ project: "alpha", ...decision }, env);
    setDecisionEmbedding({ id: saved.id, vector: FAKE_VECTOR, model: FAKE_MODEL }, env);
  }
  const item = saveRoadmapItem({ type: "improvement", project: "alpha", ...ITEM, decision_id: linked.id }, env);
  return { env, item };
}

test("with an embedder enabled the prompt carries one `## Related decisions` heading and every recalled non-linked decision, up to eight", async (t) => {
  const { env, item } = makeEmbeddedHome(t, "roadmap-queue-embedder");
  const embedder = fakeEmbedder(FAKE_VECTOR, { model: FAKE_MODEL });

  const prompt = await buildRoadmapPrompt({ item: getRoadmapItem(item.id, env), embedder }, env);
  assert.ok(embedder.calls.length > 0, "the semantic path never ran, so this test would prove nothing");
  assert.equal(headingOccurrences(prompt, RELATED_HEADING), 1, prompt);
  assert.equal(headingOccurrences(prompt, STANDING_HEADING), 1, prompt);
  assert.ok(prompt.indexOf(STANDING_HEADING) < prompt.indexOf(RELATED_HEADING), prompt);
  assert.equal(relatedCount(prompt), RECALLED_NON_LINKED, `the related block must hold every recalled non-linked decision:\n${prompt}`);

  const { job } = await queueRoadmapItem({ id: item.id, embedder }, env);
  const queued = getJob(job.id, env).prompt;
  assert.equal(headingOccurrences(queued, RELATED_HEADING), 1, queued);
  assert.equal(relatedCount(queued), RECALLED_NON_LINKED, queued);
});

test("a proposed decision is listed by title under `## Proposed (not binding)`, after the standing titles and before the related ones", async (t) => {
  const { env, item } = makeRoadmapHome(t, "roadmap-queue-proposed");
  const proposed = saveDecision(
    { project: "alpha", title: "heartbeats move to a side table", context: "still open", decision: "nothing settled yet", status: "proposed" },
    env,
  );

  const prompt = await buildRoadmapPrompt({ item: getRoadmapItem(item.id, env) }, env);

  const heading = "## Proposed (not binding)";
  assert.ok(prompt.includes(`${heading}\n- #${proposed.number} heartbeats move to a side table\n\n${RELATED_HEADING}`), prompt);
  assert.ok(prompt.indexOf(STANDING_HEADING) < prompt.indexOf(heading), prompt);
  assert.equal(prompt.includes("nothing settled yet"), false, "a proposal is listed by title only");
  const standing = prompt.slice(prompt.indexOf(STANDING_HEADING), prompt.indexOf(heading));
  assert.equal(standing.includes("heartbeats move to a side table"), false, "a proposal was listed as standing");
});

// A store on a fresh home whose one roadmap item is queued as a job through the store, the way queue_add links it.
async function linkedJob(t, name) {
  const env = makeHome(t, name);
  makeProject(t, env, "alpha");
  const store = openStore(env);
  const item = await store.roadmap.saveRoadmapItem({ type: "improvement", project: "alpha", title: "follow the job" });
  const { job } = await store.roadmap.queueRoadmapItem({ id: item.id });
  return { env, store, item, job };
}

// The status and closed_at of the item right now.
async function itemState(store, item) {
  const row = await store.roadmap.getRoadmapItem(item.id);
  return { status: row.status, closed: row.closed_at !== null };
}

// Claims the job and finishes it on the given status, through the store the runner uses.
async function runTo(store, job, status, { prUrl } = {}) {
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(await store.jobs.finishJob(job.id, { worker: "w1", status, prUrl }), true, "setup: the job was not finished");
}

test("an item follows its job through gate, retry, failure, done and a delivered close", async (t) => {
  const { store, item, job } = await linkedJob(t, "roadmap-follow-lifecycle");
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });

  await runTo(store, job, "gate");
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
  await store.jobs.retryJob(job.id, { note: "go on" });
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });

  await runTo(store, job, "failed");
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
  await store.jobs.retryJob(job.id, {});
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });

  await runTo(store, job, "done", { prUrl: PR_URL });
  assert.deepEqual(await itemState(store, item), { status: "in_review", closed: false });
  await settleThroughStore(store, job.id);
  assert.deepEqual(await itemState(store, item), { status: "done", closed: true });
  assert.equal(await store.roadmap.followJob(job.id), 0);
});

test("a cancelled job sends its item back to todo", async (t) => {
  const { store, item, job } = await linkedJob(t, "roadmap-follow-cancel");
  await store.jobs.cancelJob(job.id, { reason: "not now" });
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
});

test("a closed job (settleClose) closes its item as done with the merge sha", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-follow-close");
  await runTo(store, job, "done", { prUrl: PR_URL });
  await settleThroughStore(store, job.id);
  assert.deepEqual(await itemState(store, item), { status: "done", closed: true });
  const closed = getRoadmapItemDetail(item.id, {}, env).comments.at(-1);
  assert.deepEqual([closed.kind, closed.refs.pr, closed.refs.sha], ["closed", PR_URL, mergedChecklist().data.mergeSha]);
});

test("a release or a park back to pending keeps the item in progress", async (t) => {
  const { store, item, job } = await linkedJob(t, "roadmap-follow-release");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }));
  assert.equal(await store.jobs.releaseJob(job.id, { worker: "w1" }), true);
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }));
  assert.equal(await store.jobs.parkJob(job.id, { worker: "w1", notBefore: new Date(Date.now() + 60000).toISOString() }), true);
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
});

test("a status written behind the store's back is picked up by the next orphan sweep", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-follow-sweep");
  openDb(env).prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(job.id);
  assert.deepEqual(await itemState(store, item), { status: "in_progress", closed: false });
  await store.jobs.sweepOrphans();
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
});

test("a retry of a job whose failure nobody followed still leaves the failure's comment first", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-follow-unseen-retry");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(finishJob(job.id, { worker: "w1", status: "failed" }, env), true, "setup: the job was not finished");
  await store.jobs.retryJob(job.id, {});
  const kinds = getRoadmapItemDetail(item.id, {}, env).comments.map((comment) => comment.kind);
  assert.deepEqual(kinds, ["queued", "failed", "queued"], "the unfollowed failure lost its comment");
});

test("a close of a job whose finish nobody followed still leaves the pull request's comment first", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-follow-unseen-close");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL }, env), true, "setup: the job was not finished");
  await settleThroughStore(store, job.id);
  assert.deepEqual(await itemState(store, item), { status: "done", closed: true });
  const kinds = getRoadmapItemDetail(item.id, {}, env).comments.map((comment) => comment.kind);
  assert.deepEqual(kinds, ["queued", "pr", "closed"], "the unfollowed finish lost its comment");
});

test("a close that cancels a job whose finish nobody followed still leaves the pull request's comment first", async (t) => {
  const { env, store, item, job } = await linkedJob(t, "roadmap-follow-unseen-cancel");
  assert.ok(await store.jobs.claimJobById(job.id, { worker: "w1", cap: null }), "setup: the job was not claimed");
  assert.equal(finishJob(job.id, { worker: "w1", status: "done", prUrl: PR_URL }, env), true, "setup: the job was not finished");
  assert.ok(await store.jobs.acquireClose(job.id, { worker: "close-w", leaseS: 600 }), "setup: the close lease was refused");
  const close = { attempts: 1, steps: {}, data: { prNumber: 7, merged: false } };
  assert.ok(await store.jobs.cancelOnClosedPr(job.id, { worker: "close-w", close, note: "closed without merge" }), "setup: the cancel was refused");
  assert.deepEqual(await itemState(store, item), { status: "todo", closed: false });
  const kinds = getRoadmapItemDetail(item.id, {}, env).comments.map((comment) => comment.kind);
  assert.deepEqual(kinds, ["queued", "pr", "failed"], "the unfollowed finish lost its comment");
});
